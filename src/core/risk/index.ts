import { cents } from "../money.js";
import type { Account, Position } from "../types.js";
import { dailyCapsRule } from "./dailyCaps.js";
import { dailyLossBreached, dailyLossRule } from "./dailyLoss.js";
import { haltedRule } from "./halted.js";
import { longOnlyRule } from "./longOnly.js";
import { maxPositionRule } from "./maxPosition.js";
import { maxPositionsRule } from "./maxPositions.js";
import { minCashRule } from "./minCash.js";
import type { OrderRequest, RiskContext, RiskRule, SimulatedPortfolio } from "./types.js";
import { universeRule } from "./universe.js";

export type { OrderRequest, RiskContext, RiskRule, SimulatedPortfolio } from "./types.js";
export { dailyLossBreached } from "./dailyLoss.js";

/** Spec §7 order, with the long-only guard right after the halt check. */
export const RISK_RULES: readonly RiskRule[] = [
    haltedRule,
    longOnlyRule,
    universeRule,
    maxPositionRule,
    maxPositionsRule,
    minCashRule,
    dailyCapsRule,
    dailyLossRule,
];

export type RiskStatus = "accepted" | "trimmed" | "rejected";

export interface CheckedOrder {
    order: OrderRequest;
    /** Final quantity; 0 when rejected. */
    qty: number;
    status: RiskStatus;
    /** Every trim and reject reason, in rule order. */
    notes: string[];
}

export interface RiskCheckResult {
    /** Sells first, then buys, each group in input order. */
    orders: CheckedOrder[];
    /** True when the daily loss stop was hit: the caller must persist the halt and alert. */
    halt: boolean;
    /** The portfolio after every accepted order. */
    portfolio: SimulatedPortfolio;
}

/** The starting simulated portfolio from the broker's account and positions. */
export function simulatePortfolio(
    account: Account,
    positions: readonly Position[],
    today: { orders: number; traded: number } = { orders: 0, traded: 0 },
): SimulatedPortfolio {
    return {
        cash: account.cash,
        holdings: new Map(positions.filter((p) => p.qty > 0).map((p) => [p.ticker, p.qty])),
        ordersToday: today.orders,
        tradedToday: cents(today.traded),
    };
}

/**
 * Runs every rule on every order. Sells go first so they free cash and slots for buys. A trim carries the
 * smaller quantity into the next rule; a reject stops the order. Accepted quantities update the simulated
 * portfolio before the next order is checked.
 */
export function runRiskChecks(
    orders: readonly OrderRequest[],
    start: SimulatedPortfolio,
    context: RiskContext,
    rules: readonly RiskRule[] = RISK_RULES,
): RiskCheckResult {
    const sorted = [...orders.filter((o) => o.side === "sell"), ...orders.filter((o) => o.side === "buy")];
    let portfolio = start;
    const checked = sorted.map((order): CheckedOrder => {
        const result = checkOrder(order, portfolio, context, rules);
        if (result.qty > 0) portfolio = applyOrder(portfolio, { ...order, qty: result.qty });
        return result;
    });

    const { account, limits } = context;
    return {
        orders: checked,
        halt: dailyLossBreached(account.equity, account.previousCloseEquity, limits.dailyLossStopPct),
        portfolio,
    };
}

function checkOrder(
    order: OrderRequest,
    portfolio: SimulatedPortfolio,
    context: RiskContext,
    rules: readonly RiskRule[],
): CheckedOrder {
    const notes: string[] = [];
    let qty = order.qty;
    for (const rule of rules) {
        const outcome = rule({ ...order, qty }, portfolio, context);
        if (outcome.kind === "reject") {
            notes.push(outcome.reason);
            return { order, qty: 0, status: "rejected", notes };
        }
        if (outcome.kind === "trim") {
            notes.push(outcome.reason);
            qty = Math.min(qty, outcome.qty);
        }
    }
    return { order, qty, status: qty < order.qty ? "trimmed" : "accepted", notes };
}

function applyOrder(portfolio: SimulatedPortfolio, order: OrderRequest): SimulatedPortfolio {
    const value = order.qty * order.limitPrice;
    const holdings = new Map(portfolio.holdings);
    const held = (holdings.get(order.ticker) ?? 0) + (order.side === "buy" ? order.qty : -order.qty);
    if (held > 0) holdings.set(order.ticker, held);
    else holdings.delete(order.ticker);
    return {
        cash: cents(portfolio.cash + (order.side === "buy" ? -value : value)),
        holdings,
        ordersToday: portfolio.ordersToday + 1,
        tradedToday: cents(portfolio.tradedToday + value),
    };
}
