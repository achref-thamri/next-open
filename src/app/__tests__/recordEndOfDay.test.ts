import { beforeEach, describe, expect, it } from "vitest";
import { cents } from "../../core/money.js";
import { toTicker, type OrderIntent } from "../../core/types.js";
import { toOrderRecord } from "../executeAtOpen.js";
import { recordEndOfDay, sendWeeklyReport } from "../recordEndOfDay.js";
import { harness, NEXT, seedStock, type Harness } from "./harness.js";

/** Tuesday 2026-11-03, 16:20 New York. */
const AFTER_CLOSE = "2026-11-03T21:20:00Z";
const AAA = toTicker("AAA");

function buy(id: string, qty: number, limit: number): OrderIntent {
    return {
        clientOrderId: id,
        ticker: AAA,
        side: "buy",
        qty,
        limitPrice: cents(limit),
        stopLossPrice: cents(Math.round(limit * 0.9)),
        takeProfitPrice: cents(Math.round(limit * 1.2)),
    };
}

describe("recordEndOfDay", () => {
    let h: Harness;

    beforeEach(() => {
        h = harness({}, AFTER_CLOSE);
        seedStock(h, "VT", { price: 125, until: NEXT });
    });

    it("starts the benchmark on day one with the account's equity", async () => {
        await recordEndOfDay(h);

        expect((await h.repos.settings.get()).benchmark).toEqual({
            symbol: "VT",
            shares: 800, // $100,000 / $125
            startDate: NEXT,
            startValue: 10_000_000,
        });
        expect(await h.repos.equity.list()).toEqual([
            { date: NEXT, equity: 10_000_000, cash: 10_000_000, benchmarkValue: 10_000_000 },
        ]);
    });

    it("values the benchmark at today's close on later days", async () => {
        await h.repos.settings.update({
            benchmark: { symbol: "VT", shares: 1000, startDate: NEXT, startValue: cents(12_000_000) },
        });

        await recordEndOfDay(h);

        expect((await h.repos.equity.latest())?.benchmarkValue).toBe(12_500_000);
    });

    it("sets the halt flag when equity is down 3% on the day", async () => {
        h.broker.seedPosition(AAA, 1000, cents(10_000));
        h.broker.closeMarket(); // previous close: $200,000
        h.broker.setPrice(AAA, cents(9_400)); // -$6,000 = -3%

        await recordEndOfDay(h);

        expect(await h.repos.settings.get()).toMatchObject({
            halted: true,
            haltReason: "daily loss stop on 2026-11-03",
        });
        expect(h.notifier.texts()[0]).toContain("🛑 Daily loss stop hit");
    });

    it("does not halt just above the stop", async () => {
        h.broker.seedPosition(AAA, 1000, cents(10_000));
        h.broker.closeMarket();
        h.broker.setPrice(AAA, cents(9_401));

        await recordEndOfDay(h);

        expect((await h.repos.settings.get()).halted).toBe(false);
    });

    it("cancels unfilled buys and lists them in the summary", async () => {
        const order = await h.broker.placeOrder(buy("tb-p1", 10, 10_000));
        await h.repos.orders.upsert(toOrderRecord(order, undefined, NEXT, h.clock.now()));
        h.broker.openMarket(new Map([[AAA, cents(10_300)]])); // gapped above the limit

        await recordEndOfDay(h);

        expect((await h.broker.getOrderByClientId("tb-p1"))?.status).toBe("canceled");
        expect((await h.repos.orders.getByClientOrderId("tb-p1"))?.status).toBe("canceled");
        expect(h.notifier.texts()[0]).toContain("Not filled: buy 10 AAA (limit $100.00 not reached), cancelled");
    });

    it("reports fills and stop-loss hits, and keeps the stop of a filled entry", async () => {
        const order = await h.broker.placeOrder(buy("tb-p1", 10, 10_000));
        await h.repos.orders.upsert(toOrderRecord(order, undefined, NEXT, h.clock.now()));
        h.broker.openMarket(new Map([[AAA, cents(10_000)]]));
        h.broker.tradeRange(AAA, cents(8_900), cents(10_000));

        await recordEndOfDay(h);

        const text = h.notifier.texts()[0] ?? "";
        expect(text).toContain("buy 10 AAA at $100.00");
        expect(text).toContain("🛡️ stop-loss 10 AAA at $90.00");
        expect(text).not.toContain("Not filled");
        expect((await h.repos.orders.getByClientOrderId("tb-p1"))?.status).toBe("filled");
    });

    it("keeps the legs of a filled entry open overnight", async () => {
        const order = await h.broker.placeOrder(buy("tb-p1", 10, 10_000));
        await h.repos.orders.upsert(toOrderRecord(order, undefined, NEXT, h.clock.now()));
        h.broker.openMarket(new Map([[AAA, cents(10_000)]]));

        await recordEndOfDay(h);

        const open = await h.broker.listOpenOrders();
        expect(open[0]?.legs.map((l) => l.role)).toEqual(["take_profit", "stop_loss"]);
    });

    it("fails without a benchmark price instead of storing a wrong snapshot", async () => {
        h.marketData.bars.clear();

        const result = await recordEndOfDay(h);

        expect(result).toEqual({ status: "failed", message: "No VT close for 2026-11-03 yet" });
        expect(await h.repos.equity.list()).toEqual([]);
    });

    it("does nothing on a non-trading day", async () => {
        h.clock.set("2026-11-07T21:20:00Z");

        expect((await recordEndOfDay(h)).status).toBe("skipped");
        expect(h.notifier.sent).toEqual([]);
    });

    it("sends a weekly report with the go-live gate", async () => {
        await recordEndOfDay(h);

        await sendWeeklyReport(h);

        const report = h.notifier.texts().at(-1) ?? "";
        expect(report).toContain("🗓️ Weekly report");
        expect(report).toContain("Return: account 0.0% vs benchmark 0.0%");
        expect(report).toContain("❌ Paper trading period: 0 months (need 3, prefer 6)");
    });
});
