import { riskSchema, universeSchema } from "../../../config/schema.js";
import { cents } from "../../money.js";
import { toTicker, type Side, type Ticker } from "../../types.js";
import type { SecurityFacts } from "../../universe/filters.js";
import type { OrderRequest, RiskContext, SimulatedPortfolio } from "../types.js";

/** $100,000 equity; default limits: 10% position, 15 positions, 10% cash, 10 orders, 30% traded, -3% stop. */
export const EQUITY = cents(10_000_000);

export function order(ticker: string, side: Side, qty: number, priceCents = 10_000): OrderRequest {
    return { id: `${side}-${ticker}`, ticker: toTicker(ticker), side, qty, limitPrice: cents(priceCents) };
}

export function security(ticker: string, overrides: Partial<SecurityFacts> = {}): SecurityFacts {
    return {
        ticker: toTicker(ticker),
        exchange: "NYSE",
        kind: "common_stock",
        close: cents(10_000),
        avgDollarVolumeUsd: 1e8,
        marketCapUsd: 1e10,
        ...overrides,
    };
}

export function context(overrides: Partial<RiskContext> = {}, tickers: string[] = ["AAA", "BBB", "CCC"]): RiskContext {
    return {
        limits: riskSchema.parse({}),
        universeLimits: universeSchema.parse({}),
        halted: false,
        account: { equity: EQUITY, cash: cents(5_000_000), previousCloseEquity: EQUITY },
        securities: new Map(tickers.map((t) => [toTicker(t), security(t)])),
        ...overrides,
    };
}

export function portfolio(
    overrides: Partial<Omit<SimulatedPortfolio, "holdings">> & { holdings?: Record<string, number> } = {},
): SimulatedPortfolio {
    const { holdings = {}, ...rest } = overrides;
    return {
        cash: cents(5_000_000),
        holdings: new Map(Object.entries(holdings).map(([t, qty]) => [toTicker(t), qty] as [Ticker, number])),
        ordersToday: 0,
        tradedToday: cents(0),
        ...rest,
    };
}
