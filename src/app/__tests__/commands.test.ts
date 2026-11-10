import { beforeEach, describe, expect, it } from "vitest";
import { cents } from "../../core/money.js";
import { toTicker, toTradingDate } from "../../core/types.js";
import { handleCommand, HELP } from "../commands.js";
import { ASOF, harness, OWNER, type Harness } from "./harness.js";

const AAA = toTicker("AAA");

describe("handleCommand", () => {
    let h: Harness;
    const send = (text: string, chatId = OWNER) => handleCommand(h, { chatId, text });

    beforeEach(() => {
        h = harness();
    });

    it("ignores everyone but the owner", async () => {
        expect(await send("/stop", 7)).toBeUndefined();
        expect((await h.repos.settings.get()).halted).toBe(false);
    });

    it("answers unknown commands with help", async () => {
        expect(await send("hello")).toBe(HELP);
        expect(await send("/nope")).toBe(HELP);
    });

    it("shows status", async () => {
        h.broker.seedPosition(AAA, 10, cents(10_000));
        h.broker.setPrice(AAA, cents(11_000));

        const reply = await send("/status");

        expect(reply).toContain("Mode: paper");
        expect(reply).toContain("Trading: ✅ active");
        expect(reply).toContain("• AAA 10 @ $100.00 → $110.00 (+10.0%)");
        expect(reply).toContain("Open orders: 0 · pending approvals: 0");
    });

    it("/stop halts and cancels entries and exits but keeps stop-losses", async () => {
        h.broker.seedPosition(toTicker("BBB"), 10, cents(10_000));
        const filled = await h.broker.placeOrder({
            clientOrderId: "no-filled",
            ticker: AAA,
            side: "buy",
            qty: 5,
            limitPrice: cents(10_000),
            stopLossPrice: cents(9_000),
            takeProfitPrice: cents(12_000),
        });
        h.broker.openMarket(new Map([[AAA, cents(10_000)]]));
        await h.broker.placeOrder({
            clientOrderId: "no-entry",
            ticker: toTicker("CCC"),
            side: "buy",
            qty: 5,
            limitPrice: cents(5_000),
            stopLossPrice: cents(4_500),
            takeProfitPrice: cents(6_000),
        });
        await h.broker.placeOrder({
            clientOrderId: "no-exit",
            ticker: toTicker("BBB"),
            side: "sell",
            qty: 10,
            limitPrice: cents(20_000),
            stopLossPrice: undefined,
            takeProfitPrice: undefined,
        });

        const reply = await send("/stop");

        expect(reply).toBe(
            "⛔ Trading halted. Cancelled 2 open orders; stop-losses stay in place. Send /resume to start again.",
        );
        expect(await h.repos.settings.get()).toMatchObject({ halted: true, haltReason: "manual /stop" });
        const status = async (id: string) => (await h.broker.getOrderByClientId(id))?.status;
        expect([await status("no-entry"), await status("no-exit")]).toEqual(["canceled", "canceled"]);
        const legs = (await h.broker.getOrderByClientId(filled.clientOrderId))?.legs.map((l) => l.status);
        expect(legs).toEqual(["open", "open"]);
        expect((await h.broker.getPositions()).map((p) => p.ticker).sort()).toEqual(["AAA", "BBB"]);
    });

    it("/resume clears the halt", async () => {
        await h.repos.settings.update({ halted: true, haltReason: "daily loss stop" });

        expect(await send("/resume")).toBe("✅ Trading resumed from the next run.");
        expect(await h.repos.settings.get()).toMatchObject({ halted: false, haltReason: undefined });
        expect(await send("/resume")).toBe("Trading is already active.");
    });

    it("/why shows the latest reasoning", async () => {
        await h.repos.runs.start({ id: "run-1", type: "evening_analysis", tradeDate: ASOF, startedAt: h.clock.now() });
        const callId = await h.repos.llmCalls.save("run-1", {
            model: "m",
            prompt: { system: "", user: "" },
            response: "",
            inputTokens: 0,
            outputTokens: 0,
            costUsd: 0,
            durationMs: 0,
        });
        await h.repos.decisions.saveMany([
            {
                id: "d1",
                runId: "run-1",
                llmCallId: callId,
                tradeDate: ASOF,
                ticker: AAA,
                action: "buy",
                targetWeight: 0.08,
                confidence: 4,
                stopLossPct: 0.07,
                takeProfitPct: 0.15,
                horizonDays: 10,
                reasoning: "Strong earnings and guidance.",
                createdAt: h.clock.now(),
            },
        ]);

        expect(await send("/why aaa")).toBe(
            [
                "AAA on 2026-11-02: buy to 8.0% of equity, confidence 4/5",
                "Stop −7.0% · target +15.0% · horizon 10 days",
                "Strong earnings and guidance.",
            ].join("\n"),
        );
        expect(await send("/why ZZZ")).toBe("No decisions for ZZZ yet.");
        expect(await send("/why")).toBe("Usage: /why TICKER");
    });

    it("/report shows performance and the gate", async () => {
        expect(await send("/report")).toContain("Go-live gate: not yet");
    });

    describe("/golive", () => {
        async function seedPassingHistory(target: Harness): Promise<void> {
            await target.repos.equity.save({
                date: toTradingDate("2026-07-01"),
                equity: cents(10_000_000),
                cash: cents(0),
                benchmarkValue: cents(10_000_000),
            });
            await target.repos.equity.save({
                date: ASOF,
                equity: cents(11_500_000),
                cash: cents(0),
                benchmarkValue: cents(10_500_000),
            });
        }

        it("refuses in paper mode", async () => {
            await seedPassingHistory(h);

            expect(await send("/golive")).toContain("Refused: Next Open runs in paper mode");
            expect((await h.repos.settings.get()).liveConfirmed).toBe(false);
        });

        it("refuses in live mode while the gate fails", async () => {
            h = harness({ mode: "live" });

            const reply = await send("/golive");

            expect(reply).toContain("Refused: the go-live gate has not passed.");
            expect(reply).toContain("❌ Paper trading period");
            expect((await h.repos.settings.get()).liveConfirmed).toBe(false);
        });

        it("confirms in live mode once the gate passes", async () => {
            h = harness({ mode: "live" });
            await seedPassingHistory(h);

            expect(await send("/golive")).toBe(
                "✅ Live trading confirmed. Orders still need your approval each evening.",
            );
            expect((await h.repos.settings.get()).liveConfirmed).toBe(true);
            expect(await send("/golive")).toBe("Live trading is already confirmed.");
        });
    });
});
