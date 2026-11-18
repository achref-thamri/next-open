import type { Ticker, TradingDate } from "../core/types.js";

/** Scheduled earnings reports. */
export interface EarningsCalendar {
    /** The next report per ticker between two dates (inclusive), for every company in one call. */
    nextReports(from: TradingDate, to: TradingDate): Promise<Map<Ticker, TradingDate>>;
}
