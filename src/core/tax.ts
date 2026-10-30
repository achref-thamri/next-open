import type { TaxRates } from "../config/schema.js";
import { cents, multiplyCents, type Cents } from "./money.js";

/*
 * Estimated Danish tax, in USD cents (spec §12). Estimates only: the real amount depends on the owner's other
 * share income, exchange rates on each trade date and SKAT's rules for the year.
 */

export interface YearTax {
    year: number;
    /** Net gain of the year (negative for a loss). */
    gain: Cents;
    /** Earlier losses used against this year's gain. */
    lossUsed: Cents;
    tax: Cents;
    /** Unused losses carried into the next year (positive amount). */
    lossCarriedForward: Cents;
}

/** The yearly aktieindkomst threshold converted to USD cents. */
export function shareThresholdCents(rates: TaxRates): Cents {
    return cents(Math.round((rates.shareThresholdDkk / rates.usdDkkRate) * 100));
}

/** Progressive share income tax on one year's positive taxable amount: low rate up to the threshold, high above. */
export function shareIncomeTax(taxable: Cents, rates: TaxRates): Cents {
    if (taxable <= 0) return cents(0);
    const threshold = shareThresholdCents(rates);
    const low = Math.min(taxable, threshold);
    return cents(
        multiplyCents(cents(low), rates.shareLowRate) + multiplyCents(cents(taxable - low), rates.shareHighRate),
    );
}

/**
 * Tax on realised share gains per calendar year. Gains and losses net within the year; a net loss is carried
 * forward against later years' gains (listed-share losses only offset listed-share gains).
 */
export function realizedShareTax(gainsByYear: ReadonlyMap<number, Cents>, rates: TaxRates): YearTax[] {
    return carryLosses(gainsByYear, (taxable) => shareIncomeTax(taxable, rates));
}

/**
 * Mark-to-market (lagerbeskatning) tax for the benchmark ETF: each year's change in value is taxed at a flat
 * rate, and a fall is carried forward against later rises. `values` are year-end values (the last one may be
 * the current value); `startValue` is the value on day one.
 */
export function markToMarketTax(
    startValue: Cents,
    values: readonly { year: number; value: Cents }[],
    rates: TaxRates,
): YearTax[] {
    const gains = new Map<number, Cents>();
    let previous = startValue;
    for (const { year, value } of [...values].sort((a, b) => a.year - b.year)) {
        gains.set(year, cents(value - previous));
        previous = value;
    }
    return carryLosses(gains, (taxable) => multiplyCents(taxable, rates.benchmarkRate));
}

export function totalTax(years: readonly YearTax[]): Cents {
    return cents(years.reduce((sum, y) => sum + y.tax, 0));
}

function carryLosses(gainsByYear: ReadonlyMap<number, Cents>, taxOf: (taxable: Cents) => Cents): YearTax[] {
    let carried = 0;
    return [...gainsByYear.entries()]
        .sort(([a], [b]) => a - b)
        .map(([year, gain]) => {
            const lossUsed = gain > 0 ? Math.min(gain, carried) : 0;
            const taxable = gain - lossUsed;
            carried = carried - lossUsed + Math.max(0, 0 - gain);
            return {
                year,
                gain,
                lossUsed: cents(lossUsed),
                tax: taxable > 0 ? taxOf(cents(taxable)) : cents(0),
                lossCarriedForward: cents(carried),
            };
        });
}
