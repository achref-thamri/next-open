import { cents, type Cents } from "./money.js";
import type { Account, DailyBar, Fill, Position, Side, Ticker, TradingDate } from "./types.js";

/*
 * Virtual portfolios for comparing strategies in paper mode. Orders are simulated from daily bars with the
 * same rules as the real broker: day limit orders at the open, bracket legs triggered by the day's range.
 */

export interface VirtualPosition {
    ticker: Ticker;
    qty: number;
    /** Total cost basis in cents. */
    cost: number;
    stopLossPrice: Cents | undefined;
    takeProfitPrice: Cents | undefined;
    openedOn: TradingDate;
    /** Latest known close, for valuation when a day has no bar. */
    lastPrice: Cents;
}

export interface VirtualPortfolio {
    cash: Cents;
    positions: VirtualPosition[];
}

export interface VirtualOrder {
    ticker: Ticker;
    side: Side;
    qty: number;
    limitPrice: Cents;
    stopLossPrice: Cents | undefined;
    takeProfitPrice: Cents | undefined;
}

export type FillReason = "entry" | "exit" | "stop_loss" | "take_profit";

export interface SimulatedFill extends Fill {
    reason: FillReason;
}

export interface DayResult {
    portfolio: VirtualPortfolio;
    fills: SimulatedFill[];
    /** Orders that did not fill (limit not reached, no bar, not enough cash or shares). */
    unfilled: VirtualOrder[];
}

/**
 * One trading day: orders execute at the open (sells first, then buys while cash lasts, no margin), then
 * protective legs trigger on the day's range (stop-loss before take-profit, filled at the open when the
 * price gapped through), then positions are marked at the close.
 */
export function simulateDay(
    start: VirtualPortfolio,
    orders: readonly VirtualOrder[],
    bars: ReadonlyMap<Ticker, DailyBar>,
    date: TradingDate,
): DayResult {
    let cash: number = start.cash;
    const positions = new Map(start.positions.map((p) => [p.ticker, { ...p }]));
    const fills: SimulatedFill[] = [];
    const unfilled: VirtualOrder[] = [];
    const fill = (ticker: Ticker, side: Side, qty: number, price: Cents, reason: FillReason) => {
        fills.push({ ticker, side, qty, price, fee: cents(0), date, reason });
    };

    const sorted = [...orders.filter((o) => o.side === "sell"), ...orders.filter((o) => o.side === "buy")];
    for (const order of sorted) {
        const bar = bars.get(order.ticker);
        const held = positions.get(order.ticker);
        if (!bar || !Number.isSafeInteger(order.qty) || order.qty <= 0) {
            unfilled.push(order);
            continue;
        }
        if (order.side === "sell") {
            if (!held || bar.open < order.limitPrice) {
                unfilled.push(order);
                continue;
            }
            const qty = Math.min(order.qty, held.qty);
            cash += qty * bar.open;
            fill(order.ticker, "sell", qty, bar.open, "exit");
            reduce(positions, held, qty);
            continue;
        }
        const value = order.qty * bar.open;
        if (bar.open > order.limitPrice || value > cash) {
            unfilled.push(order);
            continue;
        }
        cash -= value;
        fill(order.ticker, "buy", order.qty, bar.open, "entry");
        positions.set(order.ticker, {
            ticker: order.ticker,
            qty: (held?.qty ?? 0) + order.qty,
            cost: (held?.cost ?? 0) + value,
            stopLossPrice: order.stopLossPrice ?? held?.stopLossPrice,
            takeProfitPrice: order.takeProfitPrice ?? held?.takeProfitPrice,
            openedOn: held?.openedOn ?? date,
            lastPrice: bar.open,
        });
    }

    for (const position of [...positions.values()]) {
        const bar = bars.get(position.ticker);
        if (!bar) continue;
        const { stopLossPrice: stop, takeProfitPrice: target } = position;
        if (stop !== undefined && bar.low <= stop) {
            const price = cents(Math.min(stop, bar.open));
            cash += position.qty * price;
            fill(position.ticker, "sell", position.qty, price, "stop_loss");
            positions.delete(position.ticker);
        } else if (target !== undefined && bar.high >= target) {
            const price = cents(Math.max(target, bar.open));
            cash += position.qty * price;
            fill(position.ticker, "sell", position.qty, price, "take_profit");
            positions.delete(position.ticker);
        } else {
            position.lastPrice = bar.close;
        }
    }

    return { portfolio: { cash: cents(cash), positions: [...positions.values()] }, fills, unfilled };
}

function reduce(positions: Map<Ticker, VirtualPosition>, held: VirtualPosition, qty: number): void {
    const remaining = held.qty - qty;
    if (remaining <= 0) {
        positions.delete(held.ticker);
        return;
    }
    held.cost = (held.cost * remaining) / held.qty;
    held.qty = remaining;
}

/** Cash plus positions at their latest known price. */
export function portfolioValue(portfolio: VirtualPortfolio): Cents {
    return cents(portfolio.cash + portfolio.positions.reduce((sum, p) => sum + p.qty * p.lastPrice, 0));
}

/** The portfolio in the broker's terms, so sizing and risk checks work unchanged. */
export function asBrokerState(
    portfolio: VirtualPortfolio,
    previousCloseEquity: Cents,
): { account: Account; positions: Position[] } {
    return {
        account: { equity: portfolioValue(portfolio), cash: portfolio.cash, previousCloseEquity },
        positions: portfolio.positions.map((p) => ({
            ticker: p.ticker,
            qty: p.qty,
            avgEntryPrice: cents(Math.round(p.cost / p.qty)),
            currentPrice: p.lastPrice,
            marketValue: cents(p.qty * p.lastPrice),
            unrealizedPl: cents(Math.round(p.qty * p.lastPrice - p.cost)),
        })),
    };
}
