import { describe, expect, it } from "vitest";
import { cents } from "../../core/money.js";
import { toTicker, toTradingDate } from "../../core/types.js";
import { handleCommand } from "../commands.js";
import { compareStrategies, comparisonText } from "../strategyReport.js";
import { harness, OWNER, type Harness } from "./harness.js";

const d = toTradingDate;

async function seedHistory(h: Harness): Promise<void> {
    // The real account started a day earlier; the comparison window starts with the virtual portfolios.
    for (const [date, equity, vt] of [
        ["2026-11-02", 9_900_000, 9_950_000],
        ["2026-11-03", 10_000_000, 10_000_000],
        ["2026-11-04", 10_150_000, 10_050_000],
    ] as const) {
        await h.repos.equity.save({ date: d(date), equity: cents(equity), cash: cents(0), benchmarkValue: cents(vt) });
    }
    for (const strategy of ["claude_patient", "momentum"] as const) {
        await h.repos.shadow.openAccount({
            strategy,
            portfolio: { cash: cents(10_000_000), positions: [] },
            startDate: d("2026-11-02"),
            startValue: cents(10_000_000),
        });
    }
    const day = (
        strategy: "claude_patient" | "momentum",
        date: string,
        equity: number,
        fills: { side: "buy" | "sell"; price: number }[] = [],
    ) =>
        h.repos.shadow.recordDay({
            strategy,
            date: d(date),
            portfolio: { cash: cents(equity), positions: [] },
            fills: fills.map((f) => ({
                ticker: toTicker("AAA"),
                side: f.side,
                qty: 10,
                price: cents(f.price),
                fee: cents(0),
                date: d(date),
                reason: f.side === "buy" ? ("entry" as const) : ("take_profit" as const),
            })),
            filledOrderIds: [],
            equity: cents(equity),
        });
    await day("momentum", "2026-11-03", 10_000_000, [{ side: "buy", price: 10_000 }]);
    await day("momentum", "2026-11-04", 10_300_000, [{ side: "sell", price: 11_000 }]);
    await day("claude_patient", "2026-11-03", 10_000_000);
    await day("claude_patient", "2026-11-04", 9_900_000);
}

describe("strategy comparison", () => {
    it("is absent before the first simulated day", async () => {
        expect(await compareStrategies(harness())).toBeUndefined();
    });

    it("compares every strategy over the same window", async () => {
        const h = harness();
        await seedHistory(h);

        const comparison = await compareStrategies(h);

        if (!comparison) throw new Error("expected a comparison");
        expect(comparison.since).toBe("2026-11-03");
        expect(comparison.days).toBe(2);
        expect(comparisonText(comparison)).toBe(
            [
                "🏁 Strategies since 2026-11-03 (2 trading days):",
                "• Momentum rule: +3.0% · max drawdown 0.0% · 1 closed trade, 100% won",
                "• AI (real paper account): +1.5% · max drawdown 0.0% · 0 closed trades",
                "• VT buy-and-hold: +0.5% · max drawdown 0.0%",
                "• Patient AI: -1.0% · max drawdown 1.0% · 0 closed trades",
            ].join("\n"),
        );
    });

    it("is added to /report", async () => {
        const h = harness();
        await seedHistory(h);

        expect(await handleCommand(h, { chatId: OWNER, text: "/report" })).toContain("🏁 Strategies since 2026-11-03");
    });
});
