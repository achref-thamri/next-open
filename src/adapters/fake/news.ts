import type { News, NewsItem } from "../../ports/news.js";
import type { Ticker } from "../../core/types.js";
import { FailureInjector } from "./failures.js";

export class FakeNews implements News {
    readonly failures = new FailureInjector();
    readonly items: NewsItem[] = [];

    async getNews(query: {
        since: Date;
        until: Date;
        tickers?: readonly Ticker[];
        limit: number;
    }): Promise<NewsItem[]> {
        await this.failures.check("getNews");
        const { since, until, tickers, limit } = query;
        return this.items
            .filter((item) => item.createdAt >= since && item.createdAt < until)
            .filter((item) => !tickers || item.tickers.some((t) => tickers.includes(t)))
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
            .slice(0, limit);
    }
}
