import type { DailyBar, Ticker, TradingDate } from "../../core/types.js";
import { HttpError } from "../../lib/errors.js";
import type { MarketData, TradableAsset } from "../../ports/marketData.js";
import { FailureInjector } from "./failures.js";

export class FakeMarketData implements MarketData {
    readonly failures = new FailureInjector();
    readonly assets: TradableAsset[] = [];
    readonly bars = new Map<Ticker, DailyBar[]>();
    /** Ticker lists of every getDailyBars call, for assertions. */
    readonly barRequests: Ticker[][] = [];

    async listTradableAssets(): Promise<TradableAsset[]> {
        await this.failures.check("listTradableAssets");
        return this.assets.map((a) => ({ ...a }));
    }

    async getDailyBars(
        tickers: readonly Ticker[],
        from: TradingDate,
        to: TradingDate,
    ): Promise<Map<Ticker, DailyBar[]>> {
        await this.failures.check("getDailyBars");
        this.barRequests.push([...tickers]);
        // Like Alpaca: one symbol it has never heard of fails the whole request (B3SA3, 2026-11-09).
        const unknown = tickers.find((t) => !this.bars.has(t) && !this.assets.some((a) => a.ticker === t));
        if (unknown !== undefined) {
            const body = JSON.stringify({ message: `invalid symbol: ${unknown}` });
            throw new HttpError(`Alpaca GET /v2/stocks/bars: 400 invalid symbol: ${unknown}`, 400, body);
        }
        const result = new Map<Ticker, DailyBar[]>();
        for (const ticker of tickers) {
            const bars = (this.bars.get(ticker) ?? []).filter((b) => b.date >= from && b.date <= to);
            if (bars.length > 0)
                result.set(
                    ticker,
                    bars.map((b) => ({ ...b })),
                );
        }
        return result;
    }
}
