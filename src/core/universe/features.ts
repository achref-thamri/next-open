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
