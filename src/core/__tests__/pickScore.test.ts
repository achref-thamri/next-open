import { describe, expect, it } from "vitest";
import { cents } from "../money.js";
import { scorePicks } from "../pickScore.js";
import { toTicker, toTradingDate, type DailyBar } from "../types.js";

function bars(closes: number[]): DailyBar[] {
    return closes.map((close, index) => {
        const price = cents(close);
        return {
            date: toTradingDate(`2026-11-${String(index + 2).padStart(2, "0")}`),
            open: price,
            high: price,
            low: price,
            close: price,
            volume: 1,
        };
    });
}

const day = (dayOfMonth: number) => toTradingDate(`2026-11-${String(dayOfMonth).padStart(2, "0")}`);

describe("scorePicks", () => {
    const index = bars([100, 101, 102, 103]);
    const history = new Map([
        [toTicker("WIN"), bars([100, 110, 120, 130])],
        [toTicker("LOSE"), bars([100, 95, 90, 85])],
    ]);

    it("compares each pick with the index over the same days", () => {
        const [score] = scorePicks(
            [
                { ticker: toTicker("WIN"), date: day(2) },
                { ticker: toTicker("LOSE"), date: day(2) },
            ],
            history,
            index,
            [2],
        );

        // WIN +20% vs +2%, LOSE -10% vs +2%
        expect(score?.picks).toBe(2);
        expect(score?.avgExcess).toBeCloseTo((0.18 - 0.12) / 2);
        expect(score?.beatShare).toBe(0.5);
    });

    it("leaves out picks without enough days since", () => {
        const scores = scorePicks([{ ticker: toTicker("WIN"), date: day(4) }], history, index, [1, 5]);

        expect(scores.map((pickScore) => pickScore.picks)).toEqual([1, 0]);
        expect(scores[1]).toMatchObject({ avgExcess: 0, beatShare: 0 });
    });

    it("skips tickers without bars", () => {
        const [score] = scorePicks([{ ticker: toTicker("GONE"), date: day(2) }], history, index, [1]);

        expect(score?.picks).toBe(0);
    });
});
