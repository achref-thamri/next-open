import { describe, expect, it } from "vitest";
import { cents } from "../../money.js";
import { toTradingDate, type DailyBar } from "../../types.js";
import { annualizedVolatility, barFeatures, periodReturns } from "../features.js";

function bar(day: number, closeCents: number, volume: number): DailyBar {
    const price = cents(closeCents);
    return {
        date: toTradingDate(`2026-10-${String(day).padStart(2, "0")}`),
        open: price,
        high: price,
        low: price,
        close: price,
        volume,
    };
}

describe("barFeatures", () => {
    it("computes change, relative volume and average dollar volume", () => {
        const bars = [bar(1, 1000, 100), bar(2, 1000, 300), bar(3, 1100, 400)];

        const features = barFeatures(bars, 2);

        expect(features?.close).toBe(1100);
        expect(features?.changePct).toBeCloseTo(0.1);
        // 400 vs mean(100, 300)
        expect(features?.relativeVolume).toBe(2);
        // mean($10 × 300, $11 × 400)
        expect(features?.avgDollarVolumeUsd).toBe(3700);
    });

    it("uses whatever history exists when shorter than the window", () => {
        const features = barFeatures([bar(1, 1000, 100), bar(2, 900, 50)], 20);

        expect(features?.changePct).toBeCloseTo(-0.1);
        expect(features?.relativeVolume).toBe(0.5);
        expect(features?.avgDollarVolumeUsd).toBe(725);
    });

    it("returns zero relative volume when there was no prior volume", () => {
        expect(barFeatures([bar(1, 1000, 0), bar(2, 1000, 50)], 20)?.relativeVolume).toBe(0);
    });

    it("needs at least two bars", () => {
        expect(barFeatures([], 20)).toBeUndefined();
        expect(barFeatures([bar(1, 1000, 100)], 20)).toBeUndefined();
    });
});

describe("periodReturns", () => {
    const series = (count: number) => Array.from({ length: count }, (_, i) => bar(1, 1000 + i * 10, 1));

    it("measures 1-day, 1-week, 1-month and 3-month returns", () => {
        const returns = periodReturns(series(64));

        // latest close 1630; 1, 5, 21 and 63 bars back: 1620, 1580, 1420, 1000
        expect(returns.d1).toBeCloseTo(1630 / 1620 - 1);
        expect(returns.w1).toBeCloseTo(1630 / 1580 - 1);
        expect(returns.m1).toBeCloseTo(1630 / 1420 - 1);
        expect(returns.m3).toBeCloseTo(0.63);
    });

    it("leaves periods without enough history undefined", () => {
        const short = periodReturns(series(6));

        expect([short.d1 !== undefined, short.w1 !== undefined, short.m1, short.m3]).toEqual([
            true,
            true,
            undefined,
            undefined,
        ]);
        expect(periodReturns([])).toEqual({ d1: undefined, w1: undefined, m1: undefined, m3: undefined });
    });
});

describe("annualizedVolatility", () => {
    it("is zero for a steady trend and positive for a choppy series", () => {
        const flat = [bar(1, 1000, 1), bar(2, 1000, 1), bar(3, 1000, 1)];
        const choppy = [bar(1, 1000, 1), bar(2, 1100, 1), bar(3, 1000, 1), bar(4, 1100, 1)];

        expect(annualizedVolatility(flat, 20)).toBe(0);
        expect(annualizedVolatility(choppy, 20)).toBeGreaterThan(1);
    });

    it("needs at least two returns", () => {
        expect(annualizedVolatility([bar(1, 1000, 1), bar(2, 1000, 1)], 20)).toBeUndefined();
    });
});
