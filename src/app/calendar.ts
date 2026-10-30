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

const OFFSET = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "longOffset" });

/** The instant of a wall-clock time ("HH:MM") on a date in New York, honouring daylight saving time. */
export function newYorkInstant(date: TradingDate, time: string): Date {
    const naive = new Date(`${date}T${time}:00Z`);
    // The offset at noon UTC that day is the offset all trading hours use (DST switches at 02:00).
    const name = OFFSET.formatToParts(new Date(`${date}T12:00:00Z`)).find((p) => p.type === "timeZoneName")?.value;
    const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name ?? "");
    if (!match) throw new Error(`Cannot read the New York UTC offset for ${date}`);
    const [, sign, hours, minutes] = match;
    const offsetMs = (Number(hours) * 60 + Number(minutes)) * 60_000 * (sign === "-" ? -1 : 1);
    return new Date(naive.getTime() - offsetMs);
}
