import { describe, expect, it } from "vitest";
import { taxSchema } from "../../config/schema.js";
import { evaluateGoLiveGate, monthsBetween, type GoLiveInput } from "../goLiveGate.js";
import { cents } from "../money.js";
import { toTicker, toTradingDate, type EquitySnapshot } from "../types.js";

const d = toTradingDate;
// Threshold $10,000 for round numbers.
const taxRates = taxSchema.parse({ shareThresholdDkk: 100_000, usdDkkRate: 10, benchmarkRate: 0.27 });

function snap(date: string, equityDollars: number, benchmarkDollars: number): EquitySnapshot {
    return {
        date: d(date),
        equity: cents(equityDollars * 100),
        cash: cents(0),
        benchmarkValue: cents(benchmarkDollars * 100),
    };
}

/** Four months of paper trading where the bot clearly beats the benchmark with a similar drawdown. */
function passing(overrides: Partial<GoLiveInput> = {}): GoLiveInput {
    return {
        snapshots: [
            snap("2026-11-02", 10_000, 10_000),
            snap("2026-12-31", 9_800, 9_700),
            snap("2027-03-02", 11_500, 10_300),
        ],
        closedTrades: [{ ticker: toTicker("AAA"), date: d("2027-02-01"), qty: 1, realizedPl: cents(100_000) }],
        unrealizedPl: cents(50_000),
        lastUnexplainedFailure: undefined,
        today: d("2027-03-02"),
        taxRates,
        ...overrides,
    };
}

const criterion = (input: GoLiveInput, name: string) => evaluateGoLiveGate(input).criteria.find((c) => c.name === name);

describe("evaluateGoLiveGate", () => {
    it("passes when all four criteria hold", () => {
        const result = evaluateGoLiveGate(passing());

        expect(result.criteria.map((c) => [c.name, c.pass])).toEqual([
            ["Paper trading period", true],
            ["Beats benchmark after fees and tax", true],
            ["Max drawdown", true],
            ["No unexplained bugs", true],
        ]);
        expect(result.pass).toBe(true);
    });

    it("computes after-tax returns on a liquidation basis", () => {
        const result = evaluateGoLiveGate(passing());

        // bot: $1,500 gain in 2027 → 27% = $405 → (11,500 - 405) / 10,000 - 1
        expect(result.botReturnAfterTax).toBeCloseTo(0.1095);
        // benchmark: -$300 in 2026 carried, +$600 in 2027 → $300 taxed at 27% = $81
        expect(result.benchmarkReturnAfterTax).toBeCloseTo(0.0219);
    });

    it("fails with less than 3 months of paper trading", () => {
        const input = passing({ today: d("2027-02-01") });

        expect(criterion(input, "Paper trading period")).toEqual({
            name: "Paper trading period",
            pass: false,
            detail: "2 months (need 3, prefer 6)",
        });
        expect(evaluateGoLiveGate(input).pass).toBe(false);
    });

    it("fails when the benchmark wins after tax", () => {
        const input = passing({
            snapshots: [snap("2026-11-02", 10_000, 10_000), snap("2027-03-02", 10_500, 10_600)],
            closedTrades: [],
            unrealizedPl: cents(50_000),
        });

        expect(criterion(input, "Beats benchmark after fees and tax")?.pass).toBe(false);
        expect(evaluateGoLiveGate(input).pass).toBe(false);
    });

    it("fails when tax turns a pre-tax win into a loss", () => {
        // bot +$1,000 pre-tax vs benchmark +$800; bot pays $270, benchmark untaxed in this case
        const input = passing({
            snapshots: [snap("2026-11-02", 10_000, 10_000), snap("2027-03-02", 11_000, 10_800)],
            closedTrades: [{ ticker: toTicker("AAA"), date: d("2027-01-04"), qty: 1, realizedPl: cents(100_000) }],
            unrealizedPl: cents(0),
            taxRates: { ...taxRates, benchmarkRate: 0.0 },
        });

        expect(criterion(input, "Beats benchmark after fees and tax")?.pass).toBe(false);
    });

    it("fails when the bot's drawdown is more than 5 points worse", () => {
        const input = passing({
            snapshots: [
                snap("2026-11-02", 10_000, 10_000),
                snap("2026-12-01", 8_900, 9_600),
                snap("2027-03-02", 11_500, 10_300),
            ],
        });

        expect(criterion(input, "Max drawdown")).toMatchObject({ pass: false });
        expect(evaluateGoLiveGate(input).pass).toBe(false);
    });

    it("passes a drawdown exactly 5 points worse", () => {
        const input = passing({
            snapshots: [
                snap("2026-11-02", 10_000, 10_000),
                snap("2026-12-01", 9_000, 9_500),
                snap("2027-03-02", 11_500, 10_300),
            ],
        });

        expect(criterion(input, "Max drawdown")?.pass).toBe(true);
    });

    it("fails with an unexplained bug in the last 30 days", () => {
        const recent = passing({ lastUnexplainedFailure: d("2027-02-01") });
        const old = passing({ lastUnexplainedFailure: d("2027-01-30") });

        expect(criterion(recent, "No unexplained bugs")).toEqual({
            name: "No unexplained bugs",
            pass: false,
            detail: "last on 2027-02-01, 29 days ago (need more than 30)",
        });
        expect(evaluateGoLiveGate(recent).pass).toBe(false);
        expect(criterion(old, "No unexplained bugs")?.pass).toBe(true);
    });

    it("fails everything measurable without history", () => {
        const result = evaluateGoLiveGate(passing({ snapshots: [] }));

        expect(result.pass).toBe(false);
        expect(result.criteria[0]?.pass).toBe(false);
        expect(result.criteria[1]?.pass).toBe(false);
    });
});

describe("monthsBetween", () => {
    it.each([
        ["2026-11-02", "2027-02-02", 3],
        ["2026-11-02", "2027-02-01", 2],
        ["2026-01-31", "2026-04-30", 2],
        ["2026-11-02", "2026-11-01", 0],
    ])("%s to %s is %s months", (from, to, months) => {
        expect(monthsBetween(d(from), d(to))).toBe(months);
    });
});
