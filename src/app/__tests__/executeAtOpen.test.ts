import { beforeEach, describe, expect, it } from "vitest";
import { FakeBroker } from "../../adapters/fake/index.js";
import { cents } from "../../core/money.js";
import { toTicker, type Proposal } from "../../core/types.js";
import { PermanentError, TransientError } from "../../lib/errors.js";
import { executeAtOpen } from "../executeAtOpen.js";
import { harness, NEXT, type Harness } from "./harness.js";

/** Tuesday 2026-11-03, 09:30 New York. */
const OPEN = "2026-11-03T14:30:00Z";

function proposal(id: string, ticker: string, overrides: Partial<Proposal> = {}): Proposal {
    return {
        id,
        runId: "run-1",
        tradeDate: NEXT,
        ticker: toTicker(ticker),
        side: "buy",
        requestedQty: 10,
        qty: 10,
        limitPrice: cents(10_100),
        previousClose: cents(10_000),
        targetWeight: 0.05,
        stopLossPct: 0.08,
        takeProfitPct: 0.2,
        confidence: 3,
        reasoning: "",
        status: "approved",
        riskNotes: [],
        ...overrides,
    };
}

async function seed(h: Harness, proposals: Proposal[]): Promise<void> {
    await h.repos.runs.start({ id: "run-1", type: "evening_analysis", tradeDate: NEXT, startedAt: h.clock.now() });
    await h.repos.candidates.saveMany(
        "run-1",
        [...new Set(proposals.map((p) => p.ticker))].map((ticker) => ({
            candidate: {
                ticker,
                exchange: "NYSE",
                kind: "common_stock",
                close: cents(10_000),
                changePct: 0,
                relativeVolume: 1,
                avgDollarVolumeUsd: 1e8,
                marketCapUsd: 1e10,
                isHolding: false,
                inNews: false,
            },
            passed: true,
            rejectReason: undefined,
        })),
    );
    await h.repos.proposals.saveMany(proposals);
}

describe("executeAtOpen", () => {
    let h: Harness;
    const statuses = async () =>
        (await h.repos.proposals.list({ tradeDate: NEXT })).map((p) => [p.id, p.status, p.qty]);

    beforeEach(() => {
        h = harness({}, OPEN);
    });

    it("places approved buys as brackets with a stable client order id", async () => {
        await seed(h, [proposal("p1", "AAA")]);

        await executeAtOpen(h);

        const [order] = h.broker.allOrders();
        expect(order).toMatchObject({
            clientOrderId: "no-p1",
            ticker: "AAA",
            side: "buy",
            qty: 10,
            limitPrice: 10_100,
        });
        // stop 8% below and target 20% above the limit
        expect(order?.legs.map((l) => [l.role, l.stopPrice ?? l.limitPrice])).toEqual([
            ["take_profit", 12_000],
            ["stop_loss", 9_200],
        ]);
        expect(await statuses()).toEqual([["p1", "executed", 10]]);
        expect((await h.repos.orders.getByClientOrderId("no-p1"))?.proposalId).toBe("p1");
        expect(h.notifier.texts()[0]).toContain("🟢 buy 10 AAA at ≤ $101.00");
    });

    it("places sells before buys and cancels the position's bracket legs first", async () => {
        h.broker.seedPosition(toTicker("BBB"), 20, cents(10_000));
        await h.broker.placeOrder({
            clientOrderId: "no-old",
            ticker: toTicker("BBB"),
            side: "buy",
            qty: 5,
            limitPrice: cents(10_000),
            stopLossPrice: cents(9_000),
            takeProfitPrice: cents(12_000),
        });
        h.broker.openMarket(new Map([[toTicker("BBB"), cents(10_000)]]));
        await seed(h, [
            proposal("p1", "AAA"),
            proposal("p2", "BBB", { side: "sell", qty: 25, stopLossPct: undefined, takeProfitPct: undefined }),
        ]);

        await executeAtOpen(h);

        const placed = h.broker.allOrders().filter((o) => o.clientOrderId !== "no-old");
        expect(placed.map((o) => [o.clientOrderId, o.side])).toEqual([
            ["no-p2", "sell"],
            ["no-p1", "buy"],
        ]);
        const old = h.broker.allOrders().find((o) => o.clientOrderId === "no-old");
        expect(old?.legs.map((l) => l.status)).toEqual(["canceled", "canceled"]);
    });

    it("does not resend orders after a crash", async () => {
        await seed(h, [proposal("p1", "AAA"), proposal("p2", "BBB")]);
        // The first order goes through, the second fails, the run fails.
        const first = await executeAtOpen(withFailureOnSecondOrder(h));
        expect(first.status).toBe("failed");
        expect(h.broker.allOrders().map((o) => o.clientOrderId)).toEqual(["no-p1"]);

        const second = await executeAtOpen(h);

        expect(second.status).toBe("succeeded");
        expect(h.broker.allOrders().map((o) => o.clientOrderId)).toEqual(["no-p1", "no-p2"]);
        expect(await statuses()).toEqual([
            ["p1", "executed", 10],
            ["p2", "executed", 10],
        ]);
    });

    it("records orders placed before a crash that never got stored", async () => {
        await seed(h, [proposal("p1", "AAA")]);
        await h.broker.placeOrder({
            clientOrderId: "no-p1",
            ticker: toTicker("AAA"),
            side: "buy",
            qty: 10,
            limitPrice: cents(10_100),
            stopLossPrice: cents(9_200),
            takeProfitPrice: cents(12_000),
        });

        const result = await executeAtOpen(h);

        expect(result).toEqual({ status: "skipped", message: "every approved order was already placed" });
        expect(h.broker.allOrders()).toHaveLength(1);
        expect(await statuses()).toEqual([["p1", "executed", 10]]);
    });

    it("places nothing while halted", async () => {
        await seed(h, [proposal("p1", "AAA")]);
        await h.repos.settings.update({ halted: true, haltReason: "manual stop" });

        await executeAtOpen(h);

        expect(h.broker.allOrders()).toEqual([]);
        expect(await statuses()).toEqual([["p1", "rejected", 0]]);
        expect(h.notifier.texts()[0]).toContain("⛔ buy AAA not placed: trading is halted");
    });

    it("records trims made against the live account", async () => {
        // $100,500 equity but only $10,500 cash: keeping $10,050 leaves $450, enough for 4 shares at $101.
        const calendar = h.broker.calendar;
        h.broker = new FakeBroker({ clock: h.clock, cash: cents(1_050_000) });
        h.broker.calendar.push(...calendar);
        h.broker.seedPosition(toTicker("ZZZ"), 900, cents(10_000));
        await seed(h, [proposal("p1", "AAA")]);

        await executeAtOpen(h);

        const [p] = await h.repos.proposals.list({ tradeDate: NEXT });
        expect(p).toMatchObject({ status: "executed", qty: 4, riskNotes: ["cash kept at 10% of equity ($10,050.00)"] });
        expect(h.broker.allOrders()[0]?.qty).toBe(4);
        expect(h.notifier.texts()[0]).toContain("✂️ buy AAA trimmed from 10 to 4");
    });

    it("marks a proposal rejected when the broker refuses it, and continues", async () => {
        await seed(h, [proposal("p1", "AAA"), proposal("p2", "BBB")]);
        h.broker.failures.failNext("placeOrder", new PermanentError("asset not tradable"));

        const result = await executeAtOpen(h);

        expect(result.status).toBe("succeeded");
        expect(await statuses()).toEqual([
            ["p1", "rejected", 10],
            ["p2", "executed", 10],
        ]);
        expect(h.notifier.texts()[0]).toContain("⛔ buy AAA refused by the broker: asset not tradable");
    });

    it("expires unapproved proposals and never executes them", async () => {
        await seed(h, [proposal("p1", "AAA", { status: "pending" })]);

        const result = await executeAtOpen(h);

        expect(result.status).toBe("skipped");
        expect(h.broker.allOrders()).toEqual([]);
        expect(await statuses()).toEqual([["p1", "expired", 10]]);
        expect(h.notifier.texts()).toEqual(["⌛ 1 unapproved order expired."]);
    });

    it("refuses live trading until the owner confirms /golive", async () => {
        h = harness({ mode: "live" }, OPEN);
        await seed(h, [proposal("p1", "AAA")]);

        const result = await executeAtOpen(h);

        expect(result.status).toBe("failed");
        expect(h.broker.allOrders()).toEqual([]);

        await h.repos.settings.update({ liveConfirmed: true });

        expect((await executeAtOpen(h)).status).toBe("succeeded");
    });

    it("refuses to trade when the account allows margin or shorting", async () => {
        await seed(h, [proposal("p1", "AAA")]);
        h.broker.marginEnabled = true;

        const result = await executeAtOpen(h);

        expect(result).toEqual({ status: "failed", message: "account has margin enabled" });
        expect(h.broker.allOrders()).toEqual([]);
    });
});

/** Lets the first placeOrder through and fails the second with a transient error. */
function withFailureOnSecondOrder(h: Harness): Harness {
    const place = h.broker.placeOrder.bind(h.broker);
    let calls = 0;
    h.broker.placeOrder = (intent) => {
        calls++;
        if (calls === 2) return Promise.reject(new TransientError("connection reset"));
        return place(intent);
    };
    return h;
}
