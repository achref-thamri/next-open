import type { DailyBar, Ticker, TradingDate } from "../core/types.js";

export interface TradableAsset {
    ticker: Ticker;
    exchange: string;
    name: string;
}

/** Prices and the list of tradable US equities. */
export interface MarketData {
    /** Active, tradable US equities. */
    listTradableAssets(): Promise<TradableAsset[]>;
    /** Daily SIP bars per ticker in the inclusive range, oldest first. Tickers without bars are absent. */
    getDailyBars(tickers: readonly Ticker[], from: TradingDate, to: TradingDate): Promise<Map<Ticker, DailyBar[]>>;
}
