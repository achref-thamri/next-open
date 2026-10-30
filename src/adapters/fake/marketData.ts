import type { DailyBar, Ticker, TradingDate } from "../../core/types.js";
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
