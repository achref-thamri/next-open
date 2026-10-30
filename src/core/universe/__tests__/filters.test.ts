import { describe, expect, it } from "vitest";
import { cents } from "../../money.js";
import {
    buildLiquidList,
    commonStockOnly,
    filterUniverse,
    listedExchange,
    minDollarVolume,
    minMarketCap,
    minPrice,
} from "../filters.js";
import { candidate, limits } from "./fixtures.js";

describe("universe filters", () => {
    it("commonStockOnly rejects ETFs and funds", () => {
        expect(commonStockOnly(candidate(), limits)).toBeUndefined();
        expect(commonStockOnly(candidate({ kind: "etf" }), limits)).toBe("not a common stock (etf)");
        expect(commonStockOnly(candidate({ kind: "fund" }), limits)).toBe("not a common stock (fund)");
        expect(commonStockOnly(candidate({ kind: "other" }), limits)).toBeDefined();
    });

    it("listedExchange rejects OTC", () => {
        expect(listedExchange(candidate({ exchange: "NYSE" }), limits)).toBeUndefined();
        expect(listedExchange(candidate({ exchange: "OTC" }), limits)).toBe("not exchange-listed (OTC)");
    });

    it("minPrice passes at exactly $5 and rejects one cent below", () => {
        expect(minPrice(candidate({ close: cents(500) }), limits)).toBeUndefined();
        expect(minPrice(candidate({ close: cents(499) }), limits)).toBe("price $4.99 below $5");
    });

    it("minMarketCap passes at exactly $2B and rejects below or unknown", () => {
        expect(minMarketCap(candidate({ marketCapUsd: 2e9 }), limits)).toBeUndefined();
        expect(minMarketCap(candidate({ marketCapUsd: 1.95e9 }), limits)).toBe("market cap $1.95B below $2B");
        expect(minMarketCap(candidate({ marketCapUsd: 1.5e9 }), limits)).toBe("market cap $1.5B below $2B");
        expect(minMarketCap(candidate({ marketCapUsd: undefined }), limits)).toBe("market cap unknown");
    });

    it("minDollarVolume passes at exactly $20M and rejects below", () => {
        expect(minDollarVolume(candidate({ avgDollarVolumeUsd: 20e6 }), limits)).toBeUndefined();
        expect(minDollarVolume(candidate({ avgDollarVolumeUsd: 19_990_000 }), limits)).toBe(
            "average dollar volume $19.99M below $20M",
        );
    });

    it("uses the configured limits", () => {
        const strict = { ...limits, minPriceUsd: 10 };

        expect(minPrice(candidate({ close: cents(999) }), strict)).toBeDefined();
    });
});

describe("filterUniverse", () => {
    it("passes a liquid large-cap common stock", () => {
        expect(filterUniverse(candidate(), limits)).toEqual({ pass: true });
    });

    it("returns the first reject reason", () => {
        const etfOnOtcPenny = candidate({ kind: "etf", exchange: "OTC", close: cents(100) });

        expect(filterUniverse(etfOnOtcPenny, limits)).toEqual({ pass: false, reason: "not a common stock (etf)" });
        expect(filterUniverse(candidate({ exchange: "OTC", close: cents(100) }), limits)).toEqual({
            pass: false,
            reason: "not exchange-listed (OTC)",
        });
    });
});

describe("buildLiquidList", () => {
    it("keeps passing tickers sorted and lists rejects with reasons", () => {
        const list = buildLiquidList(
            [
                candidate({ ticker: "MSFT" }),
                candidate({ ticker: "SPY", kind: "etf", exchange: "ARCA" }),
                candidate({ ticker: "AAPL" }),
                candidate({ ticker: "TINY", marketCapUsd: 5e8 }),
            ],
            limits,
        );

        expect(list.tickers).toEqual(["AAPL", "MSFT"]);
        expect(list.rejected).toEqual([
            { ticker: "SPY", reason: "not a common stock (etf)" },
            { ticker: "TINY", reason: "market cap $500M below $2B" },
        ]);
    });
});
