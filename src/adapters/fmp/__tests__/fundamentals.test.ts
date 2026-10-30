import { readFileSync } from "node:fs";
import { pino } from "pino";
import { beforeEach, describe, expect, it } from "vitest";
import { toTicker } from "../../../core/types.js";
import type { Repositories } from "../../../ports/repositories.js";
import { FakeClock } from "../../fake/clock.js";
import { openDatabase } from "../../sqlite/db.js";
import { migrate } from "../../sqlite/migrate.js";
import { createSqliteRepositories } from "../../sqlite/repositories/index.js";
import { FmpFundamentals, fromFmpSymbol, toFmpSymbol } from "../fundamentals.js";

const fixture = (name: string) => readFileSync(new URL(`../__fixtures__/${name}`, import.meta.url), "utf8");
const AAPL = toTicker("AAPL");

describe("FmpFundamentals", () => {
    let repos: Repositories;
    let clock: FakeClock;
    let urls: URL[];
    let respond: (url: URL) => Response;

    beforeEach(() => {
        const db = openDatabase(":memory:");
        migrate(db);
        repos = createSqliteRepositories(db);
        clock = new FakeClock("2026-11-01T15:00:00Z");
        urls = [];
        respond = () => new Response(fixture("profile.json"));
    });

    function fmp(dailyBudget = 240) {
        return new FmpFundamentals({
            apiKey: "secret-key",
            profiles: repos.profiles,
            usage: repos.apiUsage,
            clock,
            logger: pino({ level: "silent" }),
            dailyBudget,
            retry: { sleep: () => Promise.resolve() },
            fetch: ((input: string) => {
                const url = new URL(input);
                urls.push(url);
                return Promise.resolve(respond(url));
            }) as typeof fetch,
        });
    }

    it("maps a profile and caches it", async () => {
        const adapter = fmp();

        const profile = await adapter.getProfile(AAPL);

        expect(profile).toEqual({
            ticker: AAPL,
            name: "Apple Inc.",
            kind: "common_stock",
            marketCapUsd: 5_050_461_930_800,
        });
        expect(urls[0]?.pathname).toBe("/stable/profile");
        expect(urls[0]?.searchParams.get("symbol")).toBe("AAPL");
        expect(urls[0]?.searchParams.get("apikey")).toBe("secret-key");
        expect((await repos.profiles.get(AAPL))?.fetchedAt).toEqual(clock.now());

        await adapter.getProfile(AAPL);
        expect(urls).toHaveLength(1);
    });

    it("refreshes profiles older than 30 days", async () => {
        const adapter = fmp();
        await adapter.getProfile(AAPL);

        clock.advance(29 * 86_400_000);
        await adapter.getProfile(AAPL);
        expect(urls).toHaveLength(1);

        clock.advance(2 * 86_400_000);
        await adapter.getProfile(AAPL);
        expect(urls).toHaveLength(2);
    });

    it("marks ETFs and funds", async () => {
        const base = JSON.parse(fixture("profile.json")) as Record<string, unknown>[];
        respond = (url) => {
            const isEtf = url.searchParams.get("symbol") === "VT";
            return new Response(
                JSON.stringify([{ ...base[0], symbol: url.searchParams.get("symbol"), isEtf, isFund: !isEtf }]),
            );
        };
        const adapter = fmp();

        expect((await adapter.getProfile(toTicker("VT")))?.kind).toBe("etf");
        expect((await adapter.getProfile(toTicker("XYZ")))?.kind).toBe("fund");
    });

    it("caches tickers FMP does not know as 'other'", async () => {
        respond = () => new Response("[]");

        expect((await fmp().getProfile(toTicker("ZZZZ")))?.kind).toBe("other");
        expect((await repos.profiles.get(toTicker("ZZZZ")))?.kind).toBe("other");
    });

    it("stops calling the API when the daily budget is used up", async () => {
        const adapter = fmp(2);

        await adapter.getProfile(toTicker("AAA"));
        await adapter.getProfile(toTicker("BBB"));
        expect(await adapter.remainingRequests()).toBe(0);

        expect(await adapter.getProfile(toTicker("CCC"))).toBeUndefined();
        expect(urls).toHaveLength(2);

        clock.advance(86_400_000);
        expect(await adapter.remainingRequests()).toBe(2);
    });

    it("answers from a stale cache when the budget is used up", async () => {
        await fmp().getProfile(AAPL);
        clock.advance(40 * 86_400_000);
        await repos.apiUsage.increment("fmp", "2026-12-11", 240);

        expect((await fmp().getProfile(AAPL))?.name).toBe("Apple Inc.");
        expect(urls).toHaveLength(1);
    });

    it("fetches market caps in batches of 100", async () => {
        respond = (url) =>
            new Response(
                JSON.stringify(
                    (url.searchParams.get("symbols") ?? "")
                        .split(",")
                        .map((symbol, i) => ({ symbol, marketCap: i === 0 ? null : 1e9 })),
                ),
            );
        const tickers = [toTicker("BRK.B"), ...Array.from({ length: 149 }, (_, i) => toTicker(`T${i}`))];

        const caps = await fmp().getMarketCaps(tickers);

        expect(urls.map((u) => u.pathname)).toEqual([
            "/stable/market-capitalization-batch",
            "/stable/market-capitalization-batch",
        ]);
        expect(urls[0]?.searchParams.get("symbols")?.startsWith("BRK-B,T0")).toBe(true);
        expect(caps.size).toBe(148);
        expect(caps.has(toTicker("BRK.B"))).toBe(false);
    });

    it("maps the recorded batch response", async () => {
        respond = () => new Response(fixture("market-cap-batch.json"));

        const caps = await fmp().getMarketCaps([AAPL, toTicker("MSFT")]);

        expect(Object.fromEntries(caps)).toEqual({ AAPL: 5_050_461_930_800, MSFT: 3_881_703_905_420 });
    });

    it("never puts the API key in error messages", async () => {
        respond = () => new Response(fixture("company-screener-402.txt"), { status: 402 });

        const error: unknown = await fmp()
            .getProfile(AAPL)
            .then(
                () => undefined,
                (e: unknown) => e,
            );

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe("FMP /profile: not included in the current plan");
        expect(JSON.stringify(error) + (error as Error).message).not.toContain("secret-key");
    });
});

describe("FMP symbols", () => {
    it("converts share classes", () => {
        expect(toFmpSymbol(toTicker("BRK.B"))).toBe("BRK-B");
        expect(fromFmpSymbol("BRK-B")).toBe("BRK.B");
        expect(fromFmpSymbol("^GSPC")).toBeUndefined();
    });
});
