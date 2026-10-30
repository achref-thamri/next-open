import { describe, expect, it } from "vitest";
import { cents } from "../money.js";
import { closedTrades, positionOpenDates } from "../trades.js";
import { toTicker, toTradingDate, type Fill } from "../types.js";

function fill(ticker: string, side: Fill["side"], qty: number, priceCents: number, feeCents = 0, day = 2): Fill {
    return {
        ticker: toTicker(ticker),
        side,
        qty,
        price: cents(priceCents),
        fee: cents(feeCents),
        date: toTradingDate(`2026-11-${String(day).padStart(2, "0")}`),
    };
}

describe("closedTrades", () => {
    it("realises the gain of a simple round trip", () => {
        expect(closedTrades([fill("AAA", "buy", 10, 10_000), fill("AAA", "sell", 10, 12_000, 0, 5)])).toEqual([
            { ticker: "AAA", date: "2026-11-05", qty: 10, realizedPl: 20_000 },
        ]);
    });

    it("uses the average cost across several buys", () => {
        // 10 @ $100 + 10 @ $120 = average $110; sell 5 @ $130 = +$100
        const trades = closedTrades([
            fill("AAA", "buy", 10, 10_000),
            fill("AAA", "buy", 10, 12_000),
            fill("AAA", "sell", 5, 13_000),
        ]);

        expect(trades[0]?.realizedPl).toBe(10_000);
    });

    it("keeps the average cost after a partial sell", () => {
        // average $110 stays $110 for the remaining 15 shares; sell them @ $100 = -$150
        const trades = closedTrades([
            fill("AAA", "buy", 10, 10_000),
            fill("AAA", "buy", 10, 12_000),
            fill("AAA", "sell", 5, 13_000),
            fill("AAA", "sell", 15, 10_000),
        ]);

        expect(trades.map((t) => t.realizedPl)).toEqual([10_000, -15_000]);
    });

    it("includes buy fees in the cost and sell fees in the proceeds", () => {
        const trades = closedTrades([fill("AAA", "buy", 10, 10_000, 100), fill("AAA", "sell", 10, 10_000, 30)]);

        expect(trades[0]?.realizedPl).toBe(-130);
    });

    it("tracks tickers separately", () => {
        const trades = closedTrades([
            fill("AAA", "buy", 1, 10_000),
            fill("BBB", "buy", 1, 50_000),
            fill("AAA", "sell", 1, 11_000),
        ]);

        expect(trades).toEqual([{ ticker: "AAA", date: "2026-11-02", qty: 1, realizedPl: 1_000 }]);
    });

    it("refuses a sell larger than the shares bought", () => {
        expect(() => closedTrades([fill("AAA", "buy", 1, 100), fill("AAA", "sell", 2, 100)])).toThrow(RangeError);
    });
});

describe("positionOpenDates", () => {
    it("returns the first buy since each position was last flat", () => {
        const opened = positionOpenDates([
            fill("AAA", "buy", 5, 100, 0, 2),
            fill("AAA", "buy", 5, 100, 0, 3),
            fill("BBB", "buy", 1, 100, 0, 3),
            fill("BBB", "sell", 1, 100, 0, 4),
            fill("CCC", "buy", 1, 100, 0, 4),
            fill("CCC", "sell", 1, 100, 0, 5),
            fill("CCC", "buy", 2, 100, 0, 6),
        ]);

        expect(Object.fromEntries(opened)).toEqual({ AAA: "2026-11-02", CCC: "2026-11-06" });
    });
});
