import { cents, multiplyCents, type Cents } from "../../core/money.js";
import {
    tradingDateOf,
    type Account,
    type OrderIntent,
    type Position,
    type Ticker,
    type TradingDate,
} from "../../core/types.js";
import { PermanentError } from "../../lib/errors.js";
import {
    OPEN_ORDER_STATUSES,
    type Broker,
    type BrokerFill,
    type BrokerOrder,
    type MarketDay,
    type OrderRole,
} from "../../ports/broker.js";
import type { Clock } from "../../ports/clock.js";
import { FailureInjector } from "./failures.js";

interface Holding {
    qty: number;
    /** Total cost in cents, for the average entry price. */
    cost: number;
}

export interface FakeBrokerOptions {
    clock: Clock;
    cash: Cents;
    /** Fee charged on each sell fill, as a fraction of the proceeds (Alpaca: regulatory fees only). */
    sellFeeRate?: number;
}

/**
 * In-memory broker. Simulates limit fills at the open, bracket legs triggered by a day's range, day-order
 * expiry, share reservation by open sell orders, and `clientOrderId` idempotency. Tests drive the market with
 * `setPrice`, `openMarket`, `tradeRange` and `closeMarket`.
 */
export class FakeBroker implements Broker {
    readonly failures = new FailureInjector();
    readonly calendar: MarketDay[] = [];
    marginEnabled = false;
    shortingEnabled = false;

    private cash: number;
    private previousCloseEquity: number;
    private readonly holdings = new Map<Ticker, Holding>();
    private readonly prices = new Map<Ticker, Cents>();
    private readonly orders: BrokerOrder[] = [];
    private readonly fills: BrokerFill[] = [];
    private readonly dayOrders = new Set<string>();
    private nextId = 1;

    constructor(private readonly options: FakeBrokerOptions) {
        this.cash = options.cash;
        this.previousCloseEquity = options.cash;
    }

    // ---- Broker port ----

    async getAccount(): Promise<Account> {
        await this.failures.check("getAccount");
        return {
            equity: this.equity(),
            cash: cents(this.cash),
            previousCloseEquity: cents(this.previousCloseEquity),
        };
    }

    async getPositions(): Promise<Position[]> {
        await this.failures.check("getPositions");
        return [...this.holdings].map(([ticker, { qty, cost }]) => {
            const currentPrice = this.priceOf(ticker);
            return {
                ticker,
                qty,
                avgEntryPrice: cents(Math.round(cost / qty)),
                currentPrice,
                marketValue: cents(qty * currentPrice),
                unrealizedPl: cents(qty * currentPrice - cost),
            };
        });
    }

    async getCalendar(from: TradingDate, to: TradingDate): Promise<MarketDay[]> {
        await this.failures.check("getCalendar");
        return this.calendar.filter((day) => day.date >= from && day.date <= to);
    }

    async placeOrder(intent: OrderIntent): Promise<BrokerOrder> {
        await this.failures.check("placeOrder");
        const existing = this.orders.find((o) => o.clientOrderId === intent.clientOrderId);
        if (existing) return structuredClone(existing);

        if (!Number.isSafeInteger(intent.qty) || intent.qty <= 0) {
            throw new PermanentError(`qty must be a positive whole number, got ${intent.qty}`);
        }
        if (intent.side === "sell") {
            const available = this.availableToSell(intent.ticker);
            if (intent.qty > available) {
                throw new PermanentError(
                    `insufficient qty available for order (requested: ${intent.qty}, available: ${available})`,
                );
            }
        } else {
            if (intent.stopLossPrice === undefined || intent.takeProfitPrice === undefined) {
                throw new PermanentError("buy orders must be brackets with stop-loss and take-profit");
            }
            const needed = intent.qty * intent.limitPrice + this.openBuyCommitment();
            if (needed > this.cash) throw new PermanentError("insufficient buying power");
        }

        const order = this.newOrder(
            intent.clientOrderId,
            intent.ticker,
            intent.side,
            intent.side === "buy" ? "entry" : "exit",
            intent.qty,
            {
                limitPrice: intent.limitPrice,
            },
        );
        if (intent.side === "buy") {
            order.legs = [
                this.newOrder(`${intent.clientOrderId}-tp`, intent.ticker, "sell", "take_profit", intent.qty, {
                    limitPrice: intent.takeProfitPrice,
                }),
                this.newOrder(`${intent.clientOrderId}-sl`, intent.ticker, "sell", "stop_loss", intent.qty, {
                    stopPrice: intent.stopLossPrice,
                }),
            ];
        } else {
            this.dayOrders.add(order.id);
        }
        this.orders.push(order);
        return structuredClone(order);
    }

    async getOrderByClientId(clientOrderId: string): Promise<BrokerOrder | undefined> {
        await this.failures.check("getOrderByClientId");
        const order = this.orders.find((o) => o.clientOrderId === clientOrderId);
        return order && structuredClone(order);
    }

    async listOpenOrders(): Promise<BrokerOrder[]> {
        await this.failures.check("listOpenOrders");
        return this.orders
            .filter((o) => isOpen(o) || o.legs.some(isOpen))
            .map((o) => ({ ...structuredClone(o), legs: o.legs.filter(isOpen).map((l) => structuredClone(l)) }));
    }

    async cancelOrder(orderId: string): Promise<void> {
        await this.failures.check("cancelOrder");
        const parent = this.orders.find((o) => o.id === orderId || o.legs.some((l) => l.id === orderId));
        if (!parent) throw new PermanentError(`order not found: ${orderId}`);
        if (parent.id === orderId) {
            if (isOpen(parent)) parent.status = "canceled";
            // Cancelling an unfilled entry also cancels its legs; a filled entry has no open remainder.
            if (parent.filledQty === 0) for (const leg of parent.legs) cancel(leg);
            return;
        }
        // Legs are one-cancels-other: cancelling one cancels both.
        for (const leg of parent.legs) cancel(leg);
    }

    async getFills(since: Date): Promise<BrokerFill[]> {
        await this.failures.check("getFills");
        return this.fills.filter((f) => f.time >= since).map((f) => ({ ...f }));
    }

    async verifyAccountSafety(): Promise<void> {
        await this.failures.check("verifyAccountSafety");
        if (this.marginEnabled) throw new PermanentError("account has margin enabled");
        if (this.shortingEnabled) throw new PermanentError("account has short selling enabled");
    }

    // ---- Simulation controls ----

    setPrice(ticker: Ticker, price: Cents): void {
        this.prices.set(ticker, price);
    }

    /** Seeds a position as if bought earlier. */
    seedPosition(ticker: Ticker, qty: number, avgEntryPrice: Cents): void {
        this.holdings.set(ticker, { qty, cost: qty * avgEntryPrice });
        if (!this.prices.has(ticker)) this.prices.set(ticker, avgEntryPrice);
    }

    /** Opens the market at the given prices: open entry and exit orders fill when the open is through their limit. */
    openMarket(openPrices: ReadonlyMap<Ticker, Cents>): void {
        for (const [ticker, price] of openPrices) this.prices.set(ticker, price);
        for (const order of this.orders) {
            const open = openPrices.get(order.ticker);
            if (open === undefined || !isOpen(order) || order.limitPrice === undefined) continue;
            const marketable = order.side === "buy" ? open <= order.limitPrice : open >= order.limitPrice;
            if (marketable) this.fill(order, order.qty - order.filledQty, open);
        }
    }

    /** Partially fills an open entry or exit order at its limit price. */
    partialFill(clientOrderId: string, qty: number): void {
        const order = this.orders.find((o) => o.clientOrderId === clientOrderId);
        if (!order?.limitPrice || !isOpen(order)) throw new Error(`no open order ${clientOrderId}`);
        this.fill(order, qty, order.limitPrice);
    }

    /** Trades through a day's range: bracket legs of filled entries trigger (stop-loss checked first). */
    tradeRange(ticker: Ticker, low: Cents, high: Cents): void {
        for (const entry of this.orders.filter((o) => o.ticker === ticker && o.filledQty > 0)) {
            const stop = entry.legs.find((l) => l.role === "stop_loss" && isOpen(l));
            const take = entry.legs.find((l) => l.role === "take_profit" && isOpen(l));
            if (stop?.stopPrice !== undefined && low <= stop.stopPrice) {
                this.fill(stop, stop.qty, stop.stopPrice);
                if (take) cancel(take);
            } else if (take?.limitPrice !== undefined && high >= take.limitPrice) {
                this.fill(take, take.qty, take.limitPrice);
                if (stop) cancel(stop);
            }
        }
    }

    /** Closes the day: unfilled day orders expire, equity becomes the previous close for tomorrow. */
    closeMarket(closePrices: ReadonlyMap<Ticker, Cents> = new Map()): void {
        for (const [ticker, price] of closePrices) this.prices.set(ticker, price);
        for (const order of this.orders) {
            if (this.dayOrders.has(order.id) && isOpen(order)) order.status = "expired";
        }
        this.previousCloseEquity = this.equity();
    }

    /** Every order ever placed, for assertions. */
    allOrders(): readonly BrokerOrder[] {
        return this.orders;
    }

    // ---- Internals ----

    private newOrder(
        clientOrderId: string,
        ticker: Ticker,
        side: BrokerOrder["side"],
        role: OrderRole,
        qty: number,
        prices: { limitPrice?: Cents | undefined; stopPrice?: Cents | undefined },
    ): BrokerOrder {
        return {
            id: `order-${this.nextId++}`,
            clientOrderId,
            ticker,
            side,
            role,
            qty,
            filledQty: 0,
            filledAvgPrice: undefined,
            limitPrice: prices.limitPrice,
            stopPrice: prices.stopPrice,
            status: "open",
            submittedAt: this.options.clock.now(),
            legs: [],
        };
    }

    private fill(order: BrokerOrder, qty: number, price: Cents): void {
        const time = this.options.clock.now();
        const value = qty * price;
        const fee = order.side === "sell" ? multiplyCents(cents(value), this.options.sellFeeRate ?? 0, "up") : cents(0);
        const holding = this.holdings.get(order.ticker) ?? { qty: 0, cost: 0 };
        if (order.side === "buy") {
            this.cash -= value;
            this.holdings.set(order.ticker, { qty: holding.qty + qty, cost: holding.cost + value });
            // Legs protect only what was filled.
            for (const leg of order.legs) leg.qty = order.filledQty + qty;
        } else {
            this.cash += value - fee;
            const remaining = holding.qty - qty;
            if (remaining > 0)
                this.holdings.set(order.ticker, { qty: remaining, cost: (holding.cost * remaining) / holding.qty });
            else this.holdings.delete(order.ticker);
        }
        const filledBefore = order.filledQty * (order.filledAvgPrice ?? 0);
        order.filledQty += qty;
        order.filledAvgPrice = cents(Math.round((filledBefore + value) / order.filledQty));
        order.status = order.filledQty >= order.qty ? "filled" : "partially_filled";
        this.prices.set(order.ticker, price);
        this.fills.push({
            id: `fill-${this.fills.length + 1}`,
            orderId: order.id,
            ticker: order.ticker,
            side: order.side,
            qty,
            price,
            fee,
            date: tradingDateOf(time),
            time,
        });
    }

    /** Shares held minus shares reserved by open exit orders and active bracket legs. */
    private availableToSell(ticker: Ticker): number {
        const held = this.holdings.get(ticker)?.qty ?? 0;
        let reserved = 0;
        for (const order of this.orders.filter((o) => o.ticker === ticker)) {
            if (order.side === "sell" && isOpen(order)) reserved += order.qty - order.filledQty;
            // Both legs cover the same shares (one-cancels-other), so count them once.
            if (order.filledQty > 0 && order.legs.some(isOpen)) reserved += Math.max(...order.legs.map((l) => l.qty));
        }
        return held - reserved;
    }

    private openBuyCommitment(): number {
        return this.orders
            .filter((o) => o.side === "buy" && isOpen(o))
            .reduce((sum, o) => sum + (o.qty - o.filledQty) * (o.limitPrice ?? 0), 0);
    }

    private priceOf(ticker: Ticker): Cents {
        const price = this.prices.get(ticker);
        if (price === undefined) throw new Error(`FakeBroker: no price for ${ticker}`);
        return price;
    }

    private equity(): Cents {
        let value = this.cash;
        for (const [ticker, { qty }] of this.holdings) value += qty * this.priceOf(ticker);
        return cents(value);
    }
}

function isOpen(order: BrokerOrder): boolean {
    return OPEN_ORDER_STATUSES.includes(order.status);
}

function cancel(order: BrokerOrder): void {
    if (isOpen(order)) order.status = "canceled";
}
