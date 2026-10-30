import { describe, expect, it } from "vitest";
import { taxSchema } from "../../config/schema.js";
import { cents } from "../money.js";
import { markToMarketTax, realizedShareTax, shareIncomeTax, shareThresholdCents, totalTax } from "../tax.js";

// Threshold 100,000 DKK at 10 DKK/USD = $10,000
const rates = taxSchema.parse({ shareThresholdDkk: 100_000, usdDkkRate: 10, benchmarkRate: 0.27 });

const gains = (entries: [number, number][]) => new Map(entries.map(([year, gain]) => [year, cents(gain)]));

describe("shareThresholdCents", () => {
    it("converts the DKK threshold to USD cents", () => {
        expect(shareThresholdCents(rates)).toBe(1_000_000);
        expect(shareThresholdCents(taxSchema.parse({}))).toBe(1_221_538); // 79,400 / 6.5
    });
});

describe("shareIncomeTax", () => {
    it("taxes 27% below the threshold", () => {
        expect(shareIncomeTax(cents(500_000), rates)).toBe(135_000);
    });

    it("taxes exactly at the threshold at the low rate", () => {
        expect(shareIncomeTax(cents(1_000_000), rates)).toBe(270_000);
    });

    it("taxes the part above the threshold at 42%", () => {
        // $10,000 × 27% + $5,000 × 42%
        expect(shareIncomeTax(cents(1_500_000), rates)).toBe(480_000);
    });

    it("is zero for no gain or a loss", () => {
        expect(shareIncomeTax(cents(0), rates)).toBe(0);
        expect(shareIncomeTax(cents(-1_000), rates)).toBe(0);
    });
});

describe("realizedShareTax", () => {
    it("taxes each year's net gain on its own", () => {
        const years = realizedShareTax(
            gains([
                [2026, 500_000],
                [2027, 1_500_000],
            ]),
            rates,
        );

        expect(years.map((y) => y.tax)).toEqual([135_000, 480_000]);
    });

    it("carries a net loss forward against later gains", () => {
        const years = realizedShareTax(
            gains([
                [2027, 300_000],
                [2026, -200_000],
                [2028, 400_000],
            ]),
            rates,
        );

        expect(years).toEqual([
            { year: 2026, gain: -200_000, lossUsed: 0, tax: 0, lossCarriedForward: 200_000 },
            { year: 2027, gain: 300_000, lossUsed: 200_000, tax: 27_000, lossCarriedForward: 0 },
            { year: 2028, gain: 400_000, lossUsed: 0, tax: 108_000, lossCarriedForward: 0 },
        ]);
    });

    it("keeps carrying a loss larger than the next gain", () => {
        const years = realizedShareTax(
            gains([
                [2026, -500_000],
                [2027, 100_000],
            ]),
            rates,
        );

        expect(years[1]).toEqual({ year: 2027, gain: 100_000, lossUsed: 100_000, tax: 0, lossCarriedForward: 400_000 });
        expect(totalTax(years)).toBe(0);
    });
});

describe("markToMarketTax", () => {
    it("taxes each year's rise in value, unrealised included", () => {
        // start $10,000; end 2026 $11,000 (+$1,000); end 2027 $12,000 (+$1,000)
        const years = markToMarketTax(
            cents(1_000_000),
            [
                { year: 2026, value: cents(1_100_000) },
                { year: 2027, value: cents(1_200_000) },
            ],
            rates,
        );

        expect(years.map((y) => y.tax)).toEqual([27_000, 27_000]);
        expect(totalTax(years)).toBe(54_000);
    });

    it("measures each year from the previous year-end, across the year boundary", () => {
        // up $2,000 in 2026, down $1,500 in 2027 (carried), up $1,000 in 2028 (fully offset)
        const years = markToMarketTax(
            cents(1_000_000),
            [
                { year: 2028, value: cents(1_150_000) },
                { year: 2026, value: cents(1_200_000) },
                { year: 2027, value: cents(1_050_000) },
            ],
            rates,
        );

        expect(years.map((y) => [y.year, y.gain, y.tax, y.lossCarriedForward])).toEqual([
            [2026, 200_000, 54_000, 0],
            [2027, -150_000, 0, 150_000],
            [2028, 100_000, 0, 50_000],
        ]);
    });

    it("uses the configured benchmark rate", () => {
        const years = markToMarketTax(cents(1_000_000), [{ year: 2026, value: cents(1_100_000) }], {
            ...rates,
            benchmarkRate: 0.42,
        });

        expect(years[0]?.tax).toBe(42_000);
    });
});
