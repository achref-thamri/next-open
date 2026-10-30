import { describe, expect, it } from "vitest";
import { cents } from "../../money.js";
import { toTicker, toTradingDate, type Candidate, type DailyBar, type Ticker } from "../../types.js";
import { momentumDecisions } from "../momentum.js";

/** 64 daily bars with closes from `price(i)`. */
function series(price: (i: number) => number): DailyBar[] {
    return Array.from({ length: 64 }, (_, i) => {
        const close = cents(Math.round(price(i)));
        return { date: toTradingDate("2026-11-02"), open: close, high: close, low: close, close, volume: 1 };
    });
}

/** A steady trend with the given 3-month return. */
const trend = (m3: number) => series((i) => 10_000 * (1 + (m3 * i) / 63));

/** Up 50% for two months, then down 10% in the last month: 3-month return positive, 1-month negative. */
const rolledOver = () =>
    series((i) => (i <= 42 ? 10_000 * (1 + (0.5 * i) / 42) : 15_000 * (1 - (0.1 * (i - 42)) / 21)));

const candidate = (ticker: string) => ({ ticker: toTicker(ticker) }) as Candidate;

function setup(returns: Record<string, number>) {
    const history = new Map<Ticker, DailyBar[]>();
    for (const [ticker, r] of Object.entries(returns)) history.set(toTicker(ticker), trend(r));
    return { eligible: Object.keys(returns).map(candidate), history };
}

const rules = { positions: 2, keepWithin: 3, targetWeight: 0.09, stopLossPct: 0.15 };

describe("momentumDecisions", () => {
    it("buys the strongest 3-month trends up to the position count", () => {
        const { eligible, history } = setup({ AAA: 0.1, BBB: 0.3, CCC: 0.2, DDD: 0.05 });

        const decisions = momentumDecisions(eligible, history, new Set(), rules);

        expect(decisions.map((d) => [d.action, d.ticker, d.targetWeight])).toEqual([
            ["buy", "BBB", 0.09],
            ["buy", "CCC", 0.09],
        ]);
        expect(decisions[0]).toMatchObject({
            stopLossPct: 0.15,
            takeProfitPct: 1,
            reasoning: "Rank 1 by 3-month return (+30.0%).",
        });
    });

    it("keeps holdings within the keep rank and fills only free slots", () => {
        const { eligible, history } = setup({ AAA: 0.1, BBB: 0.3, CCC: 0.2, DDD: 0.05 });

        const decisions = momentumDecisions(eligible, history, new Set([toTicker("AAA")]), rules);

        expect(decisions.map((d) => [d.action, d.ticker])).toEqual([["buy", "BBB"]]);
    });

    it("sells holdings that fell out of the keep rank or are no longer eligible", () => {
        const { eligible, history } = setup({ AAA: 0.1, BBB: 0.3, CCC: 0.2, DDD: 0.05 });

        const decisions = momentumDecisions(eligible, history, new Set([toTicker("DDD"), toTicker("ZZZ")]), rules);

        expect(decisions.filter((d) => d.action === "sell").map((d) => [d.ticker, d.reasoning])).toEqual([
            ["DDD", "Dropped to rank 4."],
            ["ZZZ", "Trend broken or no longer eligible."],
        ]);
        expect(decisions.filter((d) => d.action === "buy").map((d) => d.ticker)).toEqual(["BBB", "CCC"]);
    });

    it("skips stocks whose last month turned down, and stocks without three months of history", () => {
        const { eligible, history } = setup({ BBB: 0.1 });
        history.set(toTicker("AAA"), rolledOver());
        eligible.push(candidate("AAA"));
        history.set(toTicker("NEW"), trend(0.5).slice(-30));
        eligible.push(candidate("NEW"));

        expect(momentumDecisions(eligible, history, new Set(), rules).map((d) => d.ticker)).toEqual(["BBB"]);
    });
});
