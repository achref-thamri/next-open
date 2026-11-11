import { describe, expect, it } from "vitest";
import { cents } from "../money.js";
import { bracketPrices, limitPrice, oneShareFits, sizeOrder } from "../sizing.js";

const equity = cents(10_000_000); // $100,000

describe("oneShareFits", () => {
    it("is true while one share costs at most a full position", () => {
        expect(oneShareFits(cents(58_000), cents(290_000), 0.2)).toBe(true);
        expect(oneShareFits(cents(58_001), cents(290_000), 0.2)).toBe(false);
    });
});

describe("sizeOrder", () => {
    it("buys whole shares up to the target, rounding down", () => {
        // 10% of $100,000 at $187.42 = 53.36 shares
        expect(sizeOrder({ equity, targetWeight: 0.1, currentQty: 0, limitPrice: cents(18_742) })).toEqual({
            side: "buy",
            qty: 53,
        });
    });

    it("buys exactly the target when it divides evenly despite float noise", () => {
        // 0.07 × 10,000,000 = 700,000.0000000001
        expect(sizeOrder({ equity, targetWeight: 0.07, currentQty: 0, limitPrice: cents(10_000) })).toEqual({
            side: "buy",
            qty: 70,
        });
    });

    it("tops up an existing position", () => {
        expect(sizeOrder({ equity, targetWeight: 0.1, currentQty: 40, limitPrice: cents(20_000) })).toEqual({
            side: "buy",
            qty: 10,
        });
    });

    it("returns nothing when one share exceeds the target", () => {
        // 1% of $100,000 = $1,000 < one share at $1,500
        expect(sizeOrder({ equity, targetWeight: 0.01, currentQty: 0, limitPrice: cents(150_000) })).toBeUndefined();
    });

    it("returns nothing when already at target", () => {
        expect(sizeOrder({ equity, targetWeight: 0.1, currentQty: 50, limitPrice: cents(20_000) })).toBeUndefined();
    });

    it("sells down to the target", () => {
        expect(sizeOrder({ equity, targetWeight: 0.05, currentQty: 50, limitPrice: cents(20_000) })).toEqual({
            side: "sell",
            qty: 25,
        });
    });

    it("sells everything on a zero target", () => {
        expect(sizeOrder({ equity, targetWeight: 0, currentQty: 37, limitPrice: cents(20_000) })).toEqual({
            side: "sell",
            qty: 37,
        });
    });

    it("treats a negative target as an exit, never a short", () => {
        expect(sizeOrder({ equity, targetWeight: -0.1, currentQty: 0, limitPrice: cents(20_000) })).toBeUndefined();
        expect(sizeOrder({ equity, targetWeight: -0.1, currentQty: 5, limitPrice: cents(20_000) })).toEqual({
            side: "sell",
            qty: 5,
        });
    });

    it("never buys with zero or negative equity", () => {
        expect(
            sizeOrder({ equity: cents(-100), targetWeight: 0.1, currentQty: 0, limitPrice: cents(100) }),
        ).toBeUndefined();
    });

    it("rejects invalid inputs", () => {
        expect(() => sizeOrder({ equity, targetWeight: 0.1, currentQty: 0, limitPrice: cents(0) })).toThrow(RangeError);
        expect(() => sizeOrder({ equity, targetWeight: 0.1, currentQty: 1.5, limitPrice: cents(100) })).toThrow(
            RangeError,
        );
    });
});

describe("limitPrice", () => {
    it("caps buys at the previous close plus the gap, rounded down", () => {
        expect(limitPrice(cents(18_742), "buy", 0.01)).toBe(18_929); // 189.2942
    });

    it("floors sells at the previous close minus the gap, rounded up", () => {
        expect(limitPrice(cents(18_742), "sell", 0.01)).toBe(18_555); // 185.5458
    });

    it("returns the previous close with no gap", () => {
        expect(limitPrice(cents(18_742), "buy", 0)).toBe(18_742);
        expect(limitPrice(cents(18_742), "sell", 0)).toBe(18_742);
    });
});

describe("bracketPrices", () => {
    it("places stop below and target above the limit", () => {
        expect(bracketPrices(cents(10_000), 0.08, 0.15)).toEqual({ stopLossPrice: 9_200, takeProfitPrice: 11_500 });
    });

    it("rounds the stop down and the target up", () => {
        expect(bracketPrices(cents(18_929), 0.07, 0.12)).toEqual({ stopLossPrice: 17_603, takeProfitPrice: 21_201 });
    });

    it("keeps at least one cent between the legs and the limit", () => {
        expect(bracketPrices(cents(500), 0, 0)).toEqual({ stopLossPrice: 499, takeProfitPrice: 501 });
    });
});
