import type { Cents } from "./money.js";

export type { Cents } from "./money.js";

declare const tickerBrand: unique symbol;
declare const tradingDateBrand: unique symbol;

/** Upper-case US ticker as Alpaca writes it, e.g. "AAPL" or "BRK.B". */
export type Ticker = string & { readonly [tickerBrand]: true };

/** Calendar date in America/New_York, "YYYY-MM-DD". */
export type TradingDate = string & { readonly [tradingDateBrand]: true };

const TICKER = /^[A-Z][A-Z0-9]{0,5}(\.[A-Z]{1,2})?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Normalises and validates a ticker. */
export function toTicker(value: string): Ticker {
    const ticker = value.trim().toUpperCase();
    if (!TICKER.test(ticker)) throw new RangeError(`Invalid ticker: "${value}"`);
    return ticker as Ticker;
}

export function isTicker(value: string): value is Ticker {
    return TICKER.test(value);
}

/** Validates a "YYYY-MM-DD" string that names a real calendar date. */
export function toTradingDate(value: string): TradingDate {
    const match = DATE.exec(value);
    if (match) {
        const [, y, m, d] = match.map(Number) as [number, number, number, number];
        const date = new Date(Date.UTC(y, m - 1, d));
        if (date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d) {
            return value as TradingDate;
        }
    }
    throw new RangeError(`Invalid trading date: "${value}"`);
}

const NEW_YORK_DATE = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
});

/** The New York calendar date of an instant. */
export function tradingDateOf(instant: Date): TradingDate {
    return toTradingDate(NEW_YORK_DATE.format(instant));
}

/** Whole shares, always positive (no shorting). */
export function isWholeShares(qty: number): boolean {
    return Number.isSafeInteger(qty) && qty > 0;
}

export type Side = "buy" | "sell";

export interface Account {
    equity: Cents;
    cash: Cents;
    /** Equity at the previous close, for the daily loss check. */
    previousCloseEquity: Cents;
}

export interface Position {
    ticker: Ticker;
    qty: number;
    avgEntryPrice: Cents;
    currentPrice: Cents;
    marketValue: Cents;
    unrealizedPl: Cents;
}

export interface Portfolio {
    account: Account;
    positions: readonly Position[];
}

/** What the universe filters need to know about a security. */
export type SecurityKind = "common_stock" | "etf" | "fund" | "other";

export interface Candidate {
    ticker: Ticker;
    exchange: string;
    kind: SecurityKind;
    /** Latest daily close. */
    close: Cents;
    /** Latest daily return as a fraction, e.g. -0.034. */
    changePct: number;
    /** Latest daily volume divided by the average volume. */
    relativeVolume: number;
    avgDollarVolumeUsd: number;
    /** Undefined when the fundamentals provider has no value. */
    marketCapUsd: number | undefined;
    isHolding: boolean;
}

export type DecisionAction = "buy" | "sell" | "hold";

/** One validated LLM decision (spec §6). */
export interface Decision {
    ticker: Ticker;
    action: DecisionAction;
    /** Fraction of equity, 0 means exit. */
    targetWeight: number;
    confidence: 1 | 2 | 3 | 4 | 5;
    stopLossPct: number;
    takeProfitPct: number;
    horizonDays: number;
    reasoning: string;
}

export type ProposalStatus = "pending" | "approved" | "rejected" | "expired" | "executed";

/** A decision turned into an order proposal after sizing and risk checks. */
export interface Proposal {
    id: string;
    runId: string;
    /** The trading day the order is meant for. */
    tradeDate: TradingDate;
    ticker: Ticker;
    side: Side;
    /** Quantity from sizing, before risk checks. */
    requestedQty: number;
    /** Quantity after risk checks; 0 when rejected. */
    qty: number;
    limitPrice: Cents;
    targetWeight: number;
    /** Only for buys: protective bracket legs as fractions of the limit price. */
    stopLossPct: number | undefined;
    takeProfitPct: number | undefined;
    confidence: Decision["confidence"];
    reasoning: string;
    status: ProposalStatus;
    /** Every trim and reject reason, shown to the owner. */
    riskNotes: readonly string[];
}

export type RiskOutcome =
    { kind: "accept" } | { kind: "trim"; qty: number; reason: string } | { kind: "reject"; reason: string };

/** An order as sent to the broker. Day limit orders; buys carry bracket legs. */
export interface OrderIntent {
    clientOrderId: string;
    ticker: Ticker;
    side: Side;
    qty: number;
    limitPrice: Cents;
    stopLossPrice: Cents | undefined;
    takeProfitPrice: Cents | undefined;
}

export interface EquitySnapshot {
    date: TradingDate;
    equity: Cents;
    cash: Cents;
    /** Value of the virtual buy-and-hold benchmark. */
    benchmarkValue: Cents;
}
