import type { Ticker, TradingDate } from "../../core/types.js";
import type { EarningsCalendar } from "../../ports/earnings.js";
import { FailureInjector } from "./failures.js";

/** Report dates from a map. */
export class FakeEarnings implements EarningsCalendar {
    readonly failures = new FailureInjector();
    readonly reports = new Map<Ticker, TradingDate>();

    async nextReports(from: TradingDate, to: TradingDate): Promise<Map<Ticker, TradingDate>> {
        await this.failures.check("nextReports");
        return new Map([...this.reports].filter(([, date]) => date >= from && date <= to));
    }
}
