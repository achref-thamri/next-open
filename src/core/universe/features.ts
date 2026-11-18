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
const PERIOD_DAYS = { d1: 1, w1: 5, m1: 21, m3: 63, m6: 126, m12: 252 } as const;

export type PeriodReturns = Record<keyof typeof PERIOD_DAYS, number | undefined>;

/** Close-to-close returns over 1 day to 12 months; undefined when history is too short. */
export function periodReturns(bars: readonly DailyBar[]): PeriodReturns {
    const latest = bars.at(-1)?.close;
    const back = (days: number) => {
        const base = bars.at(-1 - days)?.close;
        return latest === undefined || base === undefined || base <= 0 ? undefined : latest / base - 1;
    };
    return {
        d1: back(PERIOD_DAYS.d1),
        w1: back(PERIOD_DAYS.w1),
        m1: back(PERIOD_DAYS.m1),
        m3: back(PERIOD_DAYS.m3),
        m6: back(PERIOD_DAYS.m6),
        m12: back(PERIOD_DAYS.m12),
    };
}

export interface TrendFeatures {
    /** Latest close against the highest close of the last year (up to 252 bars), e.g. -0.08 is 8% below it. */
    fromHigh52w: number;
    /** Latest close against its 200-day average; undefined with less than 200 bars. */
    vsMa200: number | undefined;
    /** Standard deviation of the last 20 daily returns, a typical day's move; undefined with fewer than two. */
    dailyVolatility: number | undefined;
}

/** Where a stock sits in its longer trend, from daily bars sorted oldest first; undefined without bars. */
export function trendFeatures(bars: readonly DailyBar[]): TrendFeatures | undefined {
    const latest = bars.at(-1)?.close;
    if (latest === undefined) return undefined;
    const year = bars.slice(-PERIOD_DAYS.m12 - 1).map((bar) => bar.close);
    const last200 = bars.slice(-200).map((bar) => bar.close);
    const vol = annualizedVolatility(bars, 20);
    return {
        fromHigh52w: latest / Math.max(...year) - 1,
        vsMa200: last200.length === 200 ? latest / mean(last200) - 1 : undefined,
        dailyVolatility: vol === undefined ? undefined : vol / Math.sqrt(TRADING_DAYS_PER_YEAR),
    };
}

/** Annualised volatility of daily returns over the last `days` returns; undefined with fewer than two. */
export function annualizedVolatility(bars: readonly DailyBar[], days: number): number | undefined {
    const closes = bars.slice(-days - 1).map((bar) => bar.close);
    const returns = closes.slice(1).map((close, index) => close / (closes[index] ?? close) - 1);
    if (returns.length < 2) return undefined;
    const mean = returns.reduce((sum, dailyReturn) => sum + dailyReturn, 0) / returns.length;
    const variance = returns.reduce((sum, dailyReturn) => sum + (dailyReturn - mean) ** 2, 0) / (returns.length - 1);
    return Math.sqrt(variance * TRADING_DAYS_PER_YEAR);
}
