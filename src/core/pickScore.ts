import type { DailyBar, Ticker, TradingDate } from "./types.js";

export interface Pick {
    ticker: Ticker;
    /** The close the decision was made on. */
    date: TradingDate;
}

export interface PickScore {
    /** Trading days after the decision. */
    horizon: number;
    /** Picks with enough history to score. */
    picks: number;
    /** Mean of each pick's return minus the index return over the same days. */
    avgExcess: number;
    /** Share of picks that did better than the index. */
    beatShare: number;
}

/**
 * How buy picks did against an index, `horizon` trading days after the close they were decided on. Picks without a
 * bar that far ahead yet are left out, so a young record shows fewer picks rather than partial returns.
 */
export function scorePicks(
    picks: readonly Pick[],
    history: ReadonlyMap<Ticker, readonly DailyBar[]>,
    index: readonly DailyBar[],
    horizons: readonly number[],
): PickScore[] {
    return horizons.map((horizon) => {
        const excess = picks.flatMap((pick) => {
            const stock = forward(history.get(pick.ticker) ?? [], pick.date, horizon);
            const market = forward(index, pick.date, horizon);
            return stock === undefined || market === undefined ? [] : [stock - market];
        });
        return {
            horizon,
            picks: excess.length,
            avgExcess: excess.length === 0 ? 0 : excess.reduce((sum, x) => sum + x, 0) / excess.length,
            beatShare: excess.length === 0 ? 0 : excess.filter((x) => x > 0).length / excess.length,
        };
    });
}

function forward(bars: readonly DailyBar[], date: TradingDate, horizon: number): number | undefined {
    const start = bars.findIndex((b) => b.date === date);
    const from = bars[start];
    const to = bars[start + horizon];
    return start < 0 || from === undefined || to === undefined ? undefined : to.close / from.close - 1;
}
