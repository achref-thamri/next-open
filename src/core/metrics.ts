import { sumCents, type Cents } from "./money.js";
import type { ClosedTrade } from "./trades.js";
import type { Fill } from "./types.js";

export const TRADING_DAYS_PER_YEAR = 252;

/** Return from the first to the last value, e.g. 0.05 for +5%. 0 with fewer than two values. */
export function totalReturn(values: readonly number[]): number {
    const first = values[0];
    const last = values.at(-1);
    return first === undefined || last === undefined || first <= 0 ? 0 : last / first - 1;
}

/** Day-over-day returns of a value series. */
export function dailyReturns(values: readonly number[]): number[] {
    const returns: number[] = [];
    for (let i = 1; i < values.length; i++) {
        const previous = values[i - 1] ?? 0;
        returns.push(previous > 0 ? (values[i] ?? 0) / previous - 1 : 0);
    }
    return returns;
}

/** Largest peak-to-trough fall as a positive fraction, e.g. 0.12 for a 12% drawdown. */
export function maxDrawdown(values: readonly number[]): number {
    let peak = -Infinity;
    let worst = 0;
    for (const value of values) {
        peak = Math.max(peak, value);
        if (peak > 0) worst = Math.max(worst, 1 - value / peak);
    }
    return worst;
}

/**
 * Annualised Sharpe ratio from daily values: mean daily excess return over its sample standard deviation,
 * times √252. Undefined with fewer than two returns or no volatility.
 */
export function sharpeRatio(values: readonly number[], riskFreeAnnual = 0): number | undefined {
    const riskFreeDaily = (1 + riskFreeAnnual) ** (1 / TRADING_DAYS_PER_YEAR) - 1;
    const excess = dailyReturns(values).map((r) => r - riskFreeDaily);
    if (excess.length < 2) return undefined;
    const mean = excess.reduce((sum, r) => sum + r, 0) / excess.length;
    const variance = excess.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (excess.length - 1);
    const sd = Math.sqrt(variance);
    return sd < 1e-12 ? undefined : (mean / sd) * Math.sqrt(TRADING_DAYS_PER_YEAR);
}

/** Share of closed trades with a positive result. Undefined when nothing was sold. */
export function winRate(trades: readonly ClosedTrade[]): number | undefined {
    if (trades.length === 0) return undefined;
    return trades.filter((t) => t.realizedPl > 0).length / trades.length;
}

/** Value traded (buys and sells) divided by average equity over the period. */
export function turnover(fills: readonly Fill[], equityValues: readonly number[]): number {
    if (equityValues.length === 0) return 0;
    const averageEquity = equityValues.reduce((sum, v) => sum + v, 0) / equityValues.length;
    const traded = fills.reduce((sum, f) => sum + f.qty * f.price, 0);
    return averageEquity > 0 ? traded / averageEquity : 0;
}

export function totalFees(fills: readonly Fill[]): Cents {
    return sumCents(fills.map((f) => f.fee));
}
