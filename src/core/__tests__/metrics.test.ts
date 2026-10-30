import { describe, expect, it } from "vitest";
import { cents } from "../money.js";
import { dailyReturns, maxDrawdown, sharpeRatio, totalFees, totalReturn, turnover, winRate } from "../metrics.js";
import type { ClosedTrade } from "../trades.js";
import { toTicker, toTradingDate, type Fill } from "../types.js";

const date = toTradingDate("2026-11-02");

function fill(side: Fill["side"], qty: number, priceCents: number, feeCents = 0): Fill {
    return { ticker: toTicker("AAA"), side, qty, price: cents(priceCents), fee: cents(feeCents), date };
}

function trade(pl: number): ClosedTrade {
    return { ticker: toTicker("AAA"), date, qty: 1, realizedPl: cents(pl) };
}

describe("totalReturn", () => {
    it("compares the last value with the first", () => {
        expect(totalReturn([100, 90, 125])).toBeCloseTo(0.25);
        expect(totalReturn([100, 80])).toBeCloseTo(-0.2);
    });

    it("is 0 for flat, single-day and empty series", () => {
        expect(totalReturn([100, 100, 100])).toBe(0);
        expect(totalReturn([100])).toBe(0);
        expect(totalReturn([])).toBe(0);
    });
});

describe("dailyReturns", () => {
    it("returns one value fewer than the series", () => {
        const returns = dailyReturns([100, 110, 99]);

        expect(returns).toHaveLength(2);
        expect(returns[0]).toBeCloseTo(0.1);
        expect(returns[1]).toBeCloseTo(-0.1);
    });
});

describe("maxDrawdown", () => {
    it("finds the largest peak-to-trough fall", () => {
        expect(maxDrawdown([100, 120, 90, 130, 117])).toBeCloseTo(0.25);
    });

    it("counts a fall that has not recovered", () => {
        expect(maxDrawdown([100, 110, 99])).toBeCloseTo(0.1);
    });

    it("is 0 for rising, flat and single-day series", () => {
        expect(maxDrawdown([100, 101, 102])).toBe(0);
        expect(maxDrawdown([100, 100])).toBe(0);
        expect(maxDrawdown([100])).toBe(0);
    });
});

describe("sharpeRatio", () => {
    it("annualises mean over sample standard deviation", () => {
        // returns 1% and 2%: mean 1.5%, sd 0.7071%, ratio 2.1213 × √252
        expect(sharpeRatio([100, 101, 103.02])).toBeCloseTo(33.675, 2);
    });

    it("subtracts the risk-free rate", () => {
        const withoutRf = sharpeRatio([100, 101, 103.02]) ?? 0;
        const withRf = sharpeRatio([100, 101, 103.02], 0.05) ?? 0;

        expect(withRf).toBeLessThan(withoutRf);
    });

    it("is negative for a falling series", () => {
        expect(sharpeRatio([100, 99, 97.02])).toBeCloseTo(-33.675, 2);
    });

    it("is undefined for flat and single-day series", () => {
        expect(sharpeRatio([100, 100, 100])).toBeUndefined();
        expect(sharpeRatio([100, 101])).toBeUndefined();
        expect(sharpeRatio([100])).toBeUndefined();
    });
});

describe("winRate", () => {
    it("counts trades with a positive result", () => {
        expect(winRate([trade(500), trade(-200), trade(0), trade(1)])).toBe(0.5);
    });

    it("is undefined without trades", () => {
        expect(winRate([])).toBeUndefined();
    });
});

describe("turnover", () => {
    it("divides value traded by average equity", () => {
        // $1,000 bought + $500 sold over an average equity of $10,000
        expect(turnover([fill("buy", 10, 10_000), fill("sell", 5, 10_000)], [900_000, 1_100_000])).toBeCloseTo(0.15);
    });

    it("is 0 without equity history", () => {
        expect(turnover([fill("buy", 1, 100)], [])).toBe(0);
    });
});

describe("totalFees", () => {
    it("sums fill fees", () => {
        expect(totalFees([fill("buy", 1, 100, 0), fill("sell", 1, 100, 3), fill("sell", 1, 100, 2)])).toBe(5);
    });
});
