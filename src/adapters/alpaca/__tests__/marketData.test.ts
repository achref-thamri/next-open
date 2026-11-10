import { readFileSync } from "node:fs";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { toTicker, toTradingDate } from "../../../core/types.js";
import { RateLimiter } from "../../../lib/http.js";
import { AlpacaClient } from "../client.js";
import { AlpacaMarketData, AlpacaNews } from "../marketData.js";

const fixture = (name: string): unknown =>
    JSON.parse(readFileSync(new URL(`../__fixtures__/${name}`, import.meta.url), "utf8"));

function setup(respond: (url: URL) => unknown, now = new Date("2026-10-31T12:00:00Z")) {
    const urls: URL[] = [];
    const fetch = (input: string): Promise<Response> => {
        const url = new URL(input);
        urls.push(url);
        return Promise.resolve(new Response(JSON.stringify(respond(url)), { status: 200 }));
    };
    const client = new AlpacaClient({
        keyId: "k",
        secretKey: "s",
        mode: "paper",
        logger: pino({ level: "silent" }),
        fetch: fetch as typeof globalThis.fetch,
        limiter: new RateLimiter(1e9),
    });
    return { marketData: new AlpacaMarketData(client, () => now), news: new AlpacaNews(client), urls };
}

const from = toTradingDate("2026-10-20");
const to = toTradingDate("2026-10-30");

describe("AlpacaMarketData", () => {
    it("lists active tradable assets with valid tickers", async () => {
        const { marketData, urls } = setup(() => [
            fixture("assets-aapl.json"),
            { symbol: "XYZ", name: "Halted", exchange: "NYSE", status: "active", tradable: false },
            { symbol: "ABC/WS", name: "Warrant", exchange: "NYSE", status: "active", tradable: true },
        ]);

        expect(await marketData.listTradableAssets()).toEqual([
            { ticker: "AAPL", exchange: "NASDAQ", name: "Apple Inc. Common Stock" },
        ]);
        expect(urls[0]?.searchParams.get("asset_class")).toBe("us_equity");
    });

    it("maps SIP daily bars to New York dates in cents", async () => {
        const { marketData } = setup(() => fixture("bars-sip.json"));

        const bars = (await marketData.getDailyBars([toTicker("AAPL")], from, to)).get(toTicker("AAPL")) ?? [];

        expect(bars[0]).toEqual({
            date: "2026-10-20",
            open: 33_303,
            high: 33_617,
            low: 33_190,
            close: 33_268,
            volume: 31_304_503,
        });
        expect(bars.map((b) => b.date)).toEqual([...bars.map((b) => b.date)].sort());
    });

    it("always requests the SIP feed with split and dividend adjustment", async () => {
        const { marketData, urls } = setup(() => ({ bars: {} }));

        await marketData.getDailyBars([toTicker("AAPL")], from, to);

        expect(urls[0]?.searchParams.get("feed")).toBe("sip");
        expect(urls[0]?.searchParams.get("adjustment")).toBe("all");
        expect(urls.some((u) => u.searchParams.get("feed") === "iex")).toBe(false);
    });

    it("batches symbols 100 per request", async () => {
        const { marketData, urls } = setup(() => ({ bars: {}, next_page_token: null }));
        const tickers = Array.from({ length: 250 }, (_, i) => toTicker(`T${i}`));

        await marketData.getDailyBars(tickers, from, to);

        expect(urls.map((u) => u.searchParams.get("symbols")?.split(",").length)).toEqual([100, 100, 50]);
    });

    it("follows pagination and merges pages per symbol", async () => {
        const bar = (day: string, close: number) => ({
            t: `2026-10-${day}T04:00:00Z`,
            o: close,
            h: close,
            l: close,
            c: close,
            v: 1,
        });
        const { marketData, urls } = setup((url) =>
            url.searchParams.get("page_token")
                ? { bars: { AAA: [bar("21", 11)] }, next_page_token: null }
                : { bars: { AAA: [bar("20", 10)], BBB: [bar("20", 20)] }, next_page_token: "next" },
        );

        const bars = await marketData.getDailyBars([toTicker("AAA"), toTicker("BBB")], from, to);

        expect(urls).toHaveLength(2);
        expect(bars.get(toTicker("AAA"))?.map((b) => b.close)).toEqual([1000, 1100]);
        expect(bars.get(toTicker("BBB"))?.map((b) => b.close)).toEqual([2000]);
    });

    it("never asks for SIP data from the last 15 minutes", async () => {
        const now = new Date("2026-10-30T20:30:00Z"); // 16:30 New York
        const { marketData, urls } = setup(() => ({ bars: {} }), now);

        await marketData.getDailyBars([toTicker("AAPL")], from, to);

        expect(new Date(urls[0]?.searchParams.get("end") ?? "").getTime()).toBeLessThanOrEqual(
            now.getTime() - 15 * 60_000,
        );
        expect(urls[0]?.searchParams.get("start")).toBe("2026-10-20T04:00:00.000Z");
    });
});

describe("AlpacaNews", () => {
    const since = new Date("2026-10-29T20:00:00Z");
    const until = new Date("2026-10-30T20:00:00Z");

    it("maps news items", async () => {
        const { news } = setup(() => ({ ...(fixture("news.json") as object), next_page_token: null }));

        const [first] = await news.getNews({ since, until, limit: 50 });

        expect(first).toMatchObject({
            id: "9000001",
            headline: "Midday Movers: Car Dealer Jumps After Strong Quarter, Biotech Names Mixed",
            source: "benzinga",
            createdAt: new Date("2026-10-30T14:15:51Z"),
        });
        expect(first?.tickers).toContain("AN");
    });

    it("pages until the limit and passes the tickers", async () => {
        const item = (id: number) => ({
            id,
            headline: `h${id}`,
            summary: "",
            source: "s",
            created_at: "2026-10-30T14:00:00Z",
            symbols: ["AAPL"],
        });
        const { news, urls } = setup((url) => ({
            news: Array.from({ length: Number(url.searchParams.get("limit")) }, (_, i) => item(i)),
            next_page_token: "more",
        }));

        const items = await news.getNews({ since, until, tickers: [toTicker("AAPL")], limit: 70 });

        expect(items).toHaveLength(70);
        expect(urls.map((u) => u.searchParams.get("limit"))).toEqual(["50", "20"]);
        expect(urls[0]?.searchParams.get("symbols")).toBe("AAPL");
    });

    it("returns nothing for an empty ticker list instead of all news", async () => {
        const { news, urls } = setup(() => ({ news: [] }));

        expect(await news.getNews({ since, until, tickers: [], limit: 10 })).toEqual([]);
        expect(urls).toEqual([]);
    });
});
