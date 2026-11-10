import type { UniverseLimits } from "../../config/schema.js";
import { formatCents } from "../money.js";
import type { Candidate, Ticker } from "../types.js";

/** The facts the filters look at. */
export type SecurityFacts = Pick<
    Candidate,
    "ticker" | "exchange" | "kind" | "close" | "avgDollarVolumeUsd" | "marketCapUsd"
>;

/** Returns a reject reason, or undefined when the security passes. */
export type UniverseFilter = (security: SecurityFacts, limits: UniverseLimits) => string | undefined;

export type FilterResult = { pass: true } | { pass: false; reason: string };

/** National exchanges as Alpaca names them; anything else (OTC) is excluded. */
const LISTED_EXCHANGES = new Set(["NYSE", "NASDAQ", "AMEX", "ARCA", "NYSEARCA", "BATS"]);

export const commonStockOnly: UniverseFilter = ({ kind }) =>
    kind === "common_stock" ? undefined : `not a common stock (${kind})`;

export const listedExchange: UniverseFilter = ({ exchange }) =>
    LISTED_EXCHANGES.has(exchange) ? undefined : `not exchange-listed (${exchange})`;

export const minPrice: UniverseFilter = ({ close }, { minPriceUsd }) =>
    close >= minPriceUsd * 100 ? undefined : `price ${formatCents(close)} below $${minPriceUsd}`;

export const minMarketCap: UniverseFilter = ({ marketCapUsd }, { minMarketCapUsd }) => {
    if (marketCapUsd === undefined) return "market cap unknown";
    return marketCapUsd >= minMarketCapUsd
        ? undefined
        : `market cap ${usdShort(marketCapUsd)} below ${usdShort(minMarketCapUsd)}`;
};

export const minDollarVolume: UniverseFilter = ({ avgDollarVolumeUsd }, { minAvgDollarVolumeUsd }) =>
    avgDollarVolumeUsd >= minAvgDollarVolumeUsd
        ? undefined
        : `average dollar volume ${usdShort(avgDollarVolumeUsd)} below ${usdShort(minAvgDollarVolumeUsd)}`;

/** Cheapest and most decisive checks first, so the reported reason is the most basic one. */
const UNIVERSE_FILTERS: readonly UniverseFilter[] = [
    commonStockOnly,
    listedExchange,
    minPrice,
    minMarketCap,
    minDollarVolume,
];

/** Runs every filter and returns the first reject reason. */
export function filterUniverse(security: SecurityFacts, limits: UniverseLimits): FilterResult {
    for (const filter of UNIVERSE_FILTERS) {
        const reason = filter(security, limits);
        if (reason !== undefined) return { pass: false, reason };
    }
    return { pass: true };
}

export interface LiquidList {
    tickers: Ticker[];
    rejected: { ticker: Ticker; reason: string }[];
}

/** The weekly list of securities that pass every filter, sorted by ticker. */
export function buildLiquidList(securities: Iterable<SecurityFacts>, limits: UniverseLimits): LiquidList {
    const tickers: Ticker[] = [];
    const rejected: LiquidList["rejected"] = [];
    for (const security of securities) {
        const result = filterUniverse(security, limits);
        if (result.pass) tickers.push(security.ticker);
        else rejected.push({ ticker: security.ticker, reason: result.reason });
    }
    tickers.sort();
    return { tickers, rejected };
}

function usdShort(usd: number): string {
    if (usd >= 1e9) return `$${round2(usd / 1e9)}B`;
    if (usd >= 1e6) return `$${round2(usd / 1e6)}M`;
    return `$${Math.round(usd)}`;
}

function round2(value: number): number {
    return Math.round(value * 100) / 100;
}
