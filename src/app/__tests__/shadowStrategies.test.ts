import { beforeEach, describe, expect, it } from "vitest";
import { cents } from "../../core/money.js";
import { toTicker, toTradingDate, type DailyBar } from "../../core/types.js";
import type { LlmPrompt } from "../../ports/llm.js";
import { runEveningAnalysis } from "../runEveningAnalysis.js";
import { simulateShadowDay } from "../shadowStrategies.js";
import { ASOF, decision, harness, llmOutput, NEXT, seedLiquidList, seedStock, type Harness } from "./harness.js";

const AAA = toTicker("AAA");
const BBB = toTicker("BBB");
const isPatient = (prompt: LlmPrompt) => prompt.system.includes("Style for this portfolio");

function addBar(h: Harness, ticker: string, bar: Omit<DailyBar, "date" | "volume">): void {
    h.marketData.bars.get(toTicker(ticker))?.push({ date: NEXT, volume: 1_000_000, ...bar });
}

describe("virtual strategies", () => {
    let h: Harness;

    beforeEach(async () => {
        h = harness();
        seedStock(h, "AAA", { lastMove: 0.05, lastVolumeMultiple: 3 }); // up into the close: momentum candidate
        seedStock(h, "BBB", { lastMove: -0.02 }); // last month down: not a momentum candidate
        seedStock(h, "SPY");
        seedStock(h, "VT");
        await seedLiquidList(h, ["AAA", "BBB"]);
        h.llm.respondWith((prompt) =>
            isPatient(prompt) ? llmOutput(decision("BBB", { targetWeight: 0.05 })) : llmOutput(decision("AAA")),
        );
    });

    it("opens a portfolio per strategy and stores each strategy's orders for the next day", async () => {
        await runEveningAnalysis(h);

        for (const strategy of ["claude_patient", "momentum"] as const) {
            expect(await h.repos.shadow.getAccount(strategy)).toMatchObject({
                portfolio: { cash: 10_000_000, positions: [] },
                startDate: ASOF,
                startValue: 10_000_000,
            });
        }
        // 9% of $100,000 at a limit of $105 × 1.01 = $106.05
        expect(await h.repos.shadow.pendingOrders("momentum", NEXT)).toMatchObject([
            { ticker: AAA, side: "buy", qty: 84, limitPrice: 10_605, stopLossPrice: 9_014, status: "pending" },
        ]);
        expect(await h.repos.shadow.pendingOrders("claude_patient", NEXT)).toMatchObject([
            { ticker: BBB, side: "buy", reasoning: "Reason for BBB." },
        ]);
    });

    it("asks Claude separately for the patient portfolio, with its own style", async () => {
        await runEveningAnalysis(h);

        expect(h.llm.prompts.map(isPatient)).toEqual([false, true]);
        expect(h.llm.prompts[1]?.system).toContain("When in doubt, hold.");
    });

    it("leaves the real account alone when a virtual strategy fails", async () => {
        h.llm.respondWith((prompt) => (isPatient(prompt) ? "garbage" : llmOutput(decision("AAA"))));

        const result = await runEveningAnalysis(h);

        expect(result.status).toBe("succeeded");
        expect(await h.repos.proposals.list({ tradeDate: NEXT })).toHaveLength(1);
        expect(await h.repos.shadow.pendingOrders("claude_patient", NEXT)).toEqual([]);
        expect(await h.repos.shadow.pendingOrders("momentum", NEXT)).toHaveLength(1);
    });

    it("still runs the virtual strategies when the real one fails", async () => {
        h.llm.respondWith((prompt) => (isPatient(prompt) ? llmOutput(decision("BBB")) : "garbage"));

        const result = await runEveningAnalysis(h);

        expect(result.status).toBe("failed");
        expect(await h.repos.shadow.pendingOrders("momentum", NEXT)).toHaveLength(1);
        expect(await h.repos.shadow.pendingOrders("claude_patient", NEXT)).toHaveLength(1);
    });

    it("simulates the next day once from its bars and reports each strategy", async () => {
        await runEveningAnalysis(h);
        addBar(h, "AAA", { open: cents(10_550), high: cents(10_800), low: cents(10_500), close: cents(10_700) });
        addBar(h, "BBB", { open: cents(9_800), high: cents(9_800), low: cents(9_000), close: cents(9_200) });
        h.clock.set("2026-11-03T21:20:00Z");

        const lines = await simulateShadowDay(h, NEXT);

        // Momentum: 84 AAA bought at $105.50, worth $107.00 at the close: +$126
        expect(lines).toContain("Momentum rule: $100,126.00 (+0.13% since start)");
        expect(await h.repos.shadow.fills("momentum")).toMatchObject([
            { ticker: AAA, side: "buy", qty: 84, price: 10_550, reason: "entry" },
        ]);
        // Patient: BBB bought at $98, then the day fell through its stop
        expect((await h.repos.shadow.fills("claude_patient")).map((f) => f.reason)).toEqual(["entry", "stop_loss"]);
        expect(await h.repos.shadow.snapshots("momentum")).toEqual([{ date: NEXT, equity: 10_012_600 }]);

        expect(await simulateShadowDay(h, NEXT)).toEqual([]);
        expect(await h.repos.shadow.fills("momentum")).toHaveLength(1);
    });

    it("includes the virtual portfolios' holdings in the evening's data and sells them at the rebalance", async () => {
        // Friday evening: the next trading day starts a new week, so momentum rebalances.
        const friday = toTradingDate("2026-11-06");
        h.clock.set("2026-11-06T21:30:00Z");
        for (const symbol of ["AAA", "BBB", "SPY", "VT", "XYZ"]) {
            seedStock(h, symbol, { until: friday, lastMove: symbol === "AAA" ? 0.05 : 0 });
        }
        await h.repos.shadow.openAccount({
            strategy: "momentum",
            portfolio: {
                cash: cents(9_000_000),
                positions: [
                    {
                        ticker: toTicker("XYZ"),
                        qty: 100,
                        cost: 1_000_000,
                        stopLossPrice: undefined,
                        takeProfitPrice: undefined,
                        openedOn: ASOF,
                        lastPrice: cents(10_000),
                    },
                ],
            },
            startDate: ASOF,
            startValue: cents(10_000_000),
        });

        await runEveningAnalysis(h);

        expect(h.marketData.barRequests[0]).toContain("XYZ");
        // XYZ is not in the liquid list, so momentum sells it at the rebalance.
        const monday = toTradingDate("2026-11-09");
        expect((await h.repos.shadow.pendingOrders("momentum", monday)).map((o) => [o.ticker, o.side, o.qty])).toEqual([
            ["XYZ", "sell", 100],
            ["AAA", "buy", 84],
        ]);
    });
});
