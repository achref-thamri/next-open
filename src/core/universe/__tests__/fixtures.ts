import { universeSchema } from "../../../config/schema.js";
import { cents } from "../../money.js";
import { toTicker, type Candidate } from "../../types.js";

export const limits = universeSchema.parse({});

/** A candidate that passes every default filter. */
export function candidate(overrides: Partial<Omit<Candidate, "ticker">> & { ticker?: string } = {}): Candidate {
    const { ticker = "AAPL", ...rest } = overrides;
    return {
        ticker: toTicker(ticker),
        exchange: "NASDAQ",
        kind: "common_stock",
        close: cents(18_000),
        changePct: 0.01,
        relativeVolume: 1,
        avgDollarVolumeUsd: 50_000_000,
        marketCapUsd: 10_000_000_000,
        isHolding: false,
        inNews: false,
        ...rest,
    };
}
