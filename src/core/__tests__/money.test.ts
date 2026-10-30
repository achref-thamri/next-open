import { describe, expect, it } from "vitest";
import { cents, centsToDollars, dollarsToCents, formatCents, multiplyCents, sumCents } from "../money.js";

describe("cents", () => {
    it("accepts integers", () => {
        expect(cents(123)).toBe(123);
        expect(cents(-5)).toBe(-5);
    });

    it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])("rejects %s", (value) => {
        expect(() => cents(value)).toThrow(RangeError);
    });
});

describe("dollarsToCents", () => {
    it.each([
        [0, 0],
        [1, 100],
        [187.42, 18_742],
        [0.1 + 0.2, 30],
        [1.005, 101],
        [1.015, 102],
        [2.675, 268],
        [19.999, 2000],
        [0.004, 0],
        [-1.005, -101],
        [-0.004, 0],
        [12_345_678.9, 1_234_567_890],
    ])("%s dollars -> %s cents", (dollars, expected) => {
        expect(dollarsToCents(dollars)).toBe(expected);
    });

    it("never returns negative zero", () => {
        expect(Object.is(dollarsToCents(-0.001), 0)).toBe(true);
    });

    it("rejects non-finite input", () => {
        expect(() => dollarsToCents(Number.NaN)).toThrow(RangeError);
    });
});

describe("centsToDollars", () => {
    it("round-trips", () => {
        expect(centsToDollars(dollarsToCents(187.42))).toBe(187.42);
        expect(centsToDollars(cents(-1))).toBe(-0.01);
    });
});

describe("multiplyCents", () => {
    it("rounds to the nearest cent by default", () => {
        expect(multiplyCents(cents(18_742), 1.01)).toBe(18_929);
        expect(multiplyCents(cents(1_000_000), 0.1)).toBe(100_000);
    });

    it("rounds down or up when asked", () => {
        expect(multiplyCents(cents(18_742), 1.01, "down")).toBe(18_929);
        expect(multiplyCents(cents(18_742), 1.01, "up")).toBe(18_930);
        expect(multiplyCents(cents(18_742), 0.99, "down")).toBe(18_554);
        expect(multiplyCents(cents(18_742), 0.99, "up")).toBe(18_555);
    });

    it("ignores float noise at exact results", () => {
        // 0.07 * 100 = 7.000000000000001 in floating point
        expect(multiplyCents(cents(100), 0.07, "up")).toBe(7);
        expect(multiplyCents(cents(100), 0.57, "down")).toBe(57);
    });

    it("rounds negative halves away from zero", () => {
        expect(multiplyCents(cents(-5), 0.5)).toBe(-3);
        expect(multiplyCents(cents(5), 0.5)).toBe(3);
    });
});

describe("sumCents", () => {
    it("adds amounts", () => {
        expect(sumCents([cents(1), cents(2), cents(-4)])).toBe(-1);
        expect(sumCents([])).toBe(0);
    });
});

describe("formatCents", () => {
    it.each([
        [0, "$0.00"],
        [5, "$0.05"],
        [123_456, "$1,234.56"],
        [-123_456, "-$1,234.56"],
    ])("%s -> %s", (amount, expected) => {
        expect(formatCents(cents(amount))).toBe(expected);
    });
});
