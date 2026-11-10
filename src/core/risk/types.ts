import type { RiskLimits, UniverseLimits } from "../../config/schema.js";
import type { Cents } from "../money.js";
import type { SecurityFacts } from "../universe/filters.js";
import type { Account, RiskOutcome, Side, Ticker } from "../types.js";

/** An order the risk checks look at. */
export interface OrderRequest {
    id: string;
    ticker: Ticker;
    side: Side;
    qty: number;
    limitPrice: Cents;
}

/** Fixed inputs for one pipeline run. */
export interface RiskContext {
    limits: RiskLimits;
    universeLimits: UniverseLimits;
    halted: boolean;
    account: Account;
    /** Latest facts for the universe filters; a missing ticker is rejected for buys. */
    securities: ReadonlyMap<Ticker, SecurityFacts>;
}

/** The simulated portfolio, carried forward so later orders see the effect of earlier ones. */
export interface SimulatedPortfolio {
    cash: Cents;
    /** Shares held per ticker; tickers with zero shares are removed. */
    holdings: ReadonlyMap<Ticker, number>;
    /** Orders already placed or accepted today. */
    ordersToday: number;
    /** Value of orders already placed or accepted today. */
    tradedToday: Cents;
}

export type RiskRule = (order: OrderRequest, portfolio: SimulatedPortfolio, context: RiskContext) => RiskOutcome;

export const accept: RiskOutcome = { kind: "accept" };

export function reject(reason: string): RiskOutcome {
    return { kind: "reject", reason };
}

/** Trims to the largest whole-share quantity within the budget, or rejects when not even one share fits. */
export function trimToBudget(order: OrderRequest, budget: number, reason: string): RiskOutcome {
    const qty = Math.floor(Math.max(0, budget) / order.limitPrice);
    if (qty >= order.qty) return accept;
    return qty > 0 ? { kind: "trim", qty, reason } : reject(reason);
}
