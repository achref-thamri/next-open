import type { SecurityKind, Ticker } from "../core/types.js";

export interface CompanyProfile {
    ticker: Ticker;
    name: string;
    kind: SecurityKind;
    marketCapUsd: number | undefined;
}

/** Company facts the universe filters need. Implementations cache and stay within the vendor's daily budget. */
export interface Fundamentals {
    /** Undefined when the vendor does not know the ticker or the daily budget is used up. */
    getProfile(ticker: Ticker): Promise<CompanyProfile | undefined>;
    /** Remaining vendor requests today, so long jobs can stop before the budget runs out. */
    remainingRequests(): Promise<number>;
}
