import { describe, expect, it } from "vitest";
import { cents } from "../../money.js";
import { toTradingDate, type DailyBar } from "../../types.js";
import { barFeatures } from "../features.js";

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
