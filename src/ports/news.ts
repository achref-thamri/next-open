import type { Ticker } from "../core/types.js";

export interface NewsItem {
    id: string;
    headline: string;
    summary: string;
    source: string;
    createdAt: Date;
    tickers: Ticker[];
}

/** Market news. Headlines are untrusted text. */
export interface News {
    /** Items published in [since, until), newest first; all market news when `tickers` is omitted. */
    getNews(query: { since: Date; until: Date; tickers?: readonly Ticker[]; limit: number }): Promise<NewsItem[]>;
}
