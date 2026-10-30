import { describe, expect, it } from "vitest";
import { isTicker, isWholeShares, toTicker, toTradingDate, tradingDateOf } from "../types.js";

describe("toTicker", () => {
    it.each([
        ["AAPL", "AAPL"],
        [" msft ", "MSFT"],
        ["brk.b", "BRK.B"],
        ["GOOGL", "GOOGL"],
    ])("normalises %j to %s", (input, expected) => {
        expect(toTicker(input)).toBe(expected);
    });

    it.each(["", "1ABC", "AAPL$", "BRK-B", "TOOLONGX", "BTC/USD"])("rejects %j", (input) => {
        expect(() => toTicker(input)).toThrow(RangeError);
    });

    it("guards without normalising", () => {
        expect(isTicker("AAPL")).toBe(true);
        expect(isTicker("aapl")).toBe(false);
    });
});

describe("toTradingDate", () => {
    it("accepts real dates", () => {
        expect(toTradingDate("2026-10-30")).toBe("2026-10-30");
        expect(toTradingDate("2028-02-29")).toBe("2028-02-29");
    });

    it.each(["2026-02-29", "2026-13-01", "2026-10-32", "2026-1-5", "20261030", "2026-10-30T00:00:00Z"])(
        "rejects %j",
        (input) => {
            expect(() => toTradingDate(input)).toThrow(RangeError);
        },
    );
});

describe("tradingDateOf", () => {
    it("uses the New York calendar date", () => {
        // 03:30 UTC is still the previous evening in New York.
        expect(tradingDateOf(new Date("2026-10-31T03:30:00Z"))).toBe("2026-10-30");
        expect(tradingDateOf(new Date("2026-10-30T14:00:00Z"))).toBe("2026-10-30");
    });

    it("follows daylight saving time (UTC-4 in summer, UTC-5 in winter)", () => {
        expect(tradingDateOf(new Date("2026-11-01T03:59:00Z"))).toBe("2026-10-31");
        expect(tradingDateOf(new Date("2026-11-01T04:00:00Z"))).toBe("2026-11-01");
        expect(tradingDateOf(new Date("2026-12-01T04:30:00Z"))).toBe("2026-11-30");
        expect(tradingDateOf(new Date("2026-12-01T05:00:00Z"))).toBe("2026-12-01");
    });
});

describe("isWholeShares", () => {
    it("accepts positive integers only", () => {
        expect(isWholeShares(1)).toBe(true);
        expect(isWholeShares(0)).toBe(false);
        expect(isWholeShares(-1)).toBe(false);
        expect(isWholeShares(1.5)).toBe(false);
    });
});
