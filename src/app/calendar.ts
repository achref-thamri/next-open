import { toTradingDate, type TradingDate } from "../core/types.js";
import type { Broker, MarketDay } from "../ports/broker.js";

/** Adds calendar days to a date. */
export function addDays(date: TradingDate, days: number): TradingDate {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return toTradingDate(d.toISOString().slice(0, 10));
}

export interface TradingDays {
    /** The market day for `date`, or undefined when the market is closed that day. */
    today: MarketDay | undefined;
    /** The next market day after `date`. */
    next: MarketDay;
}

/** Looks up `date` and the next trading day in the broker calendar. */
export async function tradingDays(broker: Broker, date: TradingDate): Promise<TradingDays> {
    const days = await broker.getCalendar(date, addDays(date, 14));
    const next = days.find((d) => d.date > date);
    if (!next) throw new Error(`No trading day found in the two weeks after ${date}`);
    return { today: days.find((d) => d.date === date), next };
}
