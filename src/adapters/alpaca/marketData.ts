import { z } from "zod";
import { dollarsToCents } from "../../core/money.js";
import {
    isTicker,
    newYorkInstant,
    tradingDateOf,
    type DailyBar,
    type Ticker,
    type TradingDate,
} from "../../core/types.js";
import type { MarketData, TradableAsset } from "../../ports/marketData.js";
import type { News, NewsItem } from "../../ports/news.js";
import type { AlpacaClient } from "./client.js";

/** Symbols per bars request; keeps URLs short. */
const SYMBOLS_PER_REQUEST = 100;
/** The free plan refuses SIP data newer than 15 minutes. */
const SIP_DELAY_MS = 16 * 60_000;
const NEWS_PAGE_SIZE = 50;

const assetsSchema = z.array(
    z.object({
        symbol: z.string(),
        name: z.string(),
        exchange: z.string(),
        status: z.string(),
        tradable: z.boolean(),
    }),
);

const barSchema = z.object({
    t: z.string(),
    o: z.number(),
    h: z.number(),
    l: z.number(),
    c: z.number(),
    v: z.number(),
});
const barsSchema = z.object({
    bars: z.record(z.string(), z.array(barSchema)).nullish(),
    next_page_token: z.string().nullish(),
});

const newsSchema = z.object({
    news: z.array(
        z.object({
            id: z.number(),
            headline: z.string(),
            summary: z.string().nullish(),
            source: z.string(),
            created_at: z.string(),
            symbols: z.array(z.string()),
        }),
    ),
    next_page_token: z.string().nullish(),
});

/** Assets and daily bars from Alpaca. Bars always use the SIP feed: IEX volume is ~2% of the real figure. */
export class AlpacaMarketData implements MarketData {
    constructor(
        private readonly client: AlpacaClient,
        private readonly now: () => Date = () => new Date(),
    ) {}

    async listTradableAssets(): Promise<TradableAsset[]> {
        const assets = await this.client.trading("/v2/assets", assetsSchema, {
            query: { status: "active", asset_class: "us_equity" },
        });
        return assets
            .filter((a) => a.tradable && a.status === "active" && isTicker(a.symbol))
            .map((a) => ({ ticker: a.symbol as Ticker, exchange: a.exchange, name: a.name }));
    }

    async getDailyBars(
        tickers: readonly Ticker[],
        from: TradingDate,
        to: TradingDate,
    ): Promise<Map<Ticker, DailyBar[]>> {
        const result = new Map<Ticker, DailyBar[]>();
        const start = newYorkInstant(from, "00:00");
        const latest = new Date(this.now().getTime() - SIP_DELAY_MS);
        const endOfDay = newYorkInstant(to, "23:59");
        const end = endOfDay < latest ? endOfDay : latest;
        if (end <= start) return result;

        for (let i = 0; i < tickers.length; i += SYMBOLS_PER_REQUEST) {
            const symbols = tickers.slice(i, i + SYMBOLS_PER_REQUEST);
            let pageToken: string | undefined;
            do {
                const page = await this.client.data("/v2/stocks/bars", barsSchema, {
                    symbols,
                    timeframe: "1Day",
                    start: start.toISOString(),
                    end: end.toISOString(),
                    feed: "sip",
                    adjustment: "all",
                    limit: 10_000,
                    page_token: pageToken,
                });
                for (const [symbol, bars] of Object.entries(page.bars ?? {})) {
                    const list = result.get(symbol as Ticker) ?? [];
                    list.push(...bars.map(toBar));
                    result.set(symbol as Ticker, list);
                }
                pageToken = page.next_page_token ?? undefined;
            } while (pageToken);
        }
        for (const bars of result.values()) bars.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
        return result;
    }
}

function toBar(bar: z.output<typeof barSchema>): DailyBar {
    return {
        date: tradingDateOf(new Date(bar.t)),
        open: dollarsToCents(bar.o),
        high: dollarsToCents(bar.h),
        low: dollarsToCents(bar.l),
        close: dollarsToCents(bar.c),
        volume: bar.v,
    };
}

/** Market news from Alpaca (Benzinga). */
export class AlpacaNews implements News {
    constructor(private readonly client: AlpacaClient) {}

    async getNews(query: {
        since: Date;
        until: Date;
        tickers?: readonly Ticker[];
        limit: number;
    }): Promise<NewsItem[]> {
        if (query.tickers?.length === 0) return [];
        const items: NewsItem[] = [];
        let pageToken: string | undefined;
        do {
            const page = await this.client.data("/v1beta1/news", newsSchema, {
                start: query.since.toISOString(),
                end: query.until.toISOString(),
                symbols: query.tickers,
                limit: Math.min(NEWS_PAGE_SIZE, query.limit - items.length),
                sort: "desc",
                include_content: false,
                exclude_contentless: true,
                page_token: pageToken,
            });
            for (const n of page.news) {
                items.push({
                    id: String(n.id),
                    headline: n.headline,
                    summary: n.summary ?? "",
                    source: n.source,
                    createdAt: new Date(n.created_at),
                    tickers: n.symbols.filter(isTicker),
                });
            }
            pageToken = page.next_page_token ?? undefined;
        } while (pageToken && items.length < query.limit);
        return items.slice(0, query.limit);
    }
}
