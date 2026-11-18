import * as zod from "zod";
import { isTicker, toTradingDate, type Ticker, type TradingDate } from "../../core/types.js";
import { requestJson, type Fetch } from "../../lib/http.js";
import type { EarningsCalendar } from "../../ports/earnings.js";

const URL = "https://finnhub.io/api/v1/calendar/earnings";
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const calendarSchema = zod.object({
    earningsCalendar: zod.array(zod.object({ symbol: zod.string(), date: zod.string() })).nullish(),
});

export interface FinnhubOptions {
    apiKey: string;
    fetch?: Fetch;
}

/**
 * Finnhub's earnings calendar. The free plan covers every US company, where FMP's free plan only covers a few
 * sample tickers (checked 2026-11-18). The key goes in a header, so it never appears in a URL or error message.
 */
export class FinnhubEarnings implements EarningsCalendar {
    constructor(private readonly options: FinnhubOptions) {}

    async nextReports(from: TradingDate, to: TradingDate): Promise<Map<Ticker, TradingDate>> {
        const response = await requestJson({
            url: `${URL}?${new URLSearchParams({ from, to }).toString()}`,
            label: "Finnhub earnings calendar",
            headers: { "X-Finnhub-Token": this.options.apiKey },
            schema: calendarSchema,
            ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
        });
        const reports = new Map<Ticker, TradingDate>();
        for (const row of response.earningsCalendar ?? []) {
            // Finnhub writes share classes with a dot like Alpaca; foreign listings and blank dates are skipped.
            if (!isTicker(row.symbol) || !DATE.test(row.date)) continue;
            const date = toTradingDate(row.date);
            const earlier = reports.get(row.symbol);
            if (earlier === undefined || date < earlier) reports.set(row.symbol, date);
        }
        return reports;
    }
}
