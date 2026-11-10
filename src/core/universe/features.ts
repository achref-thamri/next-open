import { TRADING_DAYS_PER_YEAR } from "../metrics.js";
import type { Candidate, DailyBar } from "../types.js";

export type BarFeatures = Pick<Candidate, "close" | "changePct" | "relativeVolume" | "avgDollarVolumeUsd">;

/**
 * Price and volume features from daily bars sorted oldest first, using the last `days` bars.
 * - avgDollarVolumeUsd: mean of close × volume over the last `days` bars, including the latest.
 * - relativeVolume: latest volume over the mean volume of the `days` bars before it.
 * Returns undefined with fewer than two bars.
 */
export function barFeatures(bars: readonly DailyBar[], days: number): BarFeatures | undefined {
    const latest = bars.at(-1);
    const previous = bars.at(-2);
    if (latest === undefined || previous === undefined) return undefined;

    const recent = bars.slice(-days);
    const avgDollarVolumeUsd = mean(recent.map((bar) => (bar.close / 100) * bar.volume));
    const priorVolume = mean(bars.slice(-days - 1, -1).map((bar) => bar.volume));

    return {
        close: latest.close,
        changePct: latest.close / previous.close - 1,
        relativeVolume: priorVolume > 0 ? latest.volume / priorVolume : 0,
        avgDollarVolumeUsd,
    };
}

function mean(values: readonly number[]): number {
    return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Trading days per period for multi-period returns. */
const PERIOD_DAYS = { d1: 1, w1: 5, m1: 21, m3: 63 } as const;

export type PeriodReturns = Record<keyof typeof PERIOD_DAYS, number | undefined>;

/** Close-to-close returns over 1 day, 1 week, 1 month and 3 months; undefined when history is too short. */
export function periodReturns(bars: readonly DailyBar[]): PeriodReturns {
    const latest = bars.at(-1)?.close;
    const back = (days: number) => {
        const base = bars.at(-1 - days)?.close;
        return latest === undefined || base === undefined || base <= 0 ? undefined : latest / base - 1;
    };
    return { d1: back(PERIOD_DAYS.d1), w1: back(PERIOD_DAYS.w1), m1: back(PERIOD_DAYS.m1), m3: back(PERIOD_DAYS.m3) };
}

/** Annualised volatility of daily returns over the last `days` returns; undefined with fewer than two. */
export function annualizedVolatility(bars: readonly DailyBar[], days: number): number | undefined {
    const closes = bars.slice(-days - 1).map((b) => b.close);
    const returns = closes.slice(1).map((close, i) => close / (closes[i] ?? close) - 1);
    if (returns.length < 2) return undefined;
    const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1);
    return Math.sqrt(variance * TRADING_DAYS_PER_YEAR);
}
