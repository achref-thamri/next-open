import { setTimeout as sleep } from "node:timers/promises";
import * as zod from "zod";
import { cents, centsToDollars, dollarsToCents, type Cents } from "../../core/money.js";
import {
    newYorkInstant,
    toTicker,
    toTradingDate,
    tradingDateOf,
    type Account,
    type OrderIntent,
    type Position,
    type TradingDate,
} from "../../core/types.js";
import { HttpError, PermanentError } from "../../lib/errors.js";
import type { Logger } from "../../lib/logger.js";
import {
    OPEN_ORDER_STATUSES,
    type Broker,
    type BrokerFill,
    type BrokerOrder,
    type MarketDay,
    type OrderRole,
    type OrderStatus,
} from "../../ports/broker.js";
import type { AlpacaClient } from "./client.js";

const money = zod.string().transform((value) => dollarsToCents(Number(value)));
const optionalMoney = money.nullish().transform((value) => value ?? undefined);
const quantity = zod.string().transform(Number);

const accountSchema = zod.object({ equity: money, cash: money, last_equity: money });

const positionSchema = zod.object({
    symbol: zod.string(),
    qty: quantity,
    avg_entry_price: money,
    current_price: money,
    market_value: money,
    unrealized_pl: money,
});

const calendarSchema = zod.array(zod.object({ date: zod.string(), open: zod.string(), close: zod.string() }));

interface AlpacaOrder {
    id: string;
    client_order_id: string;
    symbol: string;
    side: "buy" | "sell";
    type: string;
    qty: number;
    filled_qty: number;
    filled_avg_price: Cents | undefined;
    limit_price: Cents | undefined;
    stop_price: Cents | undefined;
    status: string;
    submitted_at: string;
    legs: AlpacaOrder[];
}

const orderSchema: zod.ZodType<AlpacaOrder> = zod.lazy(() =>
    zod.object({
        id: zod.string(),
        client_order_id: zod.string(),
        symbol: zod.string(),
        side: zod.enum(["buy", "sell"]),
        type: zod.string(),
        qty: quantity,
        filled_qty: quantity,
        filled_avg_price: optionalMoney,
        limit_price: optionalMoney,
        stop_price: optionalMoney,
        status: zod.string(),
        submitted_at: zod.string(),
        legs: zod
            .array(orderSchema)
            .nullish()
            .transform((legs) => legs ?? []),
    }),
);

const fillSchema = zod.object({
    id: zod.string(),
    order_id: zod.string(),
    symbol: zod.string(),
    side: zod.enum(["buy", "sell", "sell_short"]),
    qty: quantity,
    price: money,
    transaction_time: zod.string(),
});

const configurationsSchema = zod.object({
    no_shorting: zod.boolean(),
    max_margin_multiplier: zod.string(),
});

const STATUS: ReadonlyMap<string, OrderStatus> = new Map([
    ["partially_filled", "partially_filled"],
    ["filled", "filled"],
    ["canceled", "canceled"],
    ["replaced", "canceled"],
    ["expired", "expired"],
    ["rejected", "rejected"],
]);

const CANCEL_CHECKS = 10;
const CANCEL_CHECK_MS = 500;

/** Alpaca as the broker. Buys are gtc bracket limit orders, sells are day limit orders (see plan, task 2.1). */
export class AlpacaBroker implements Broker {
    constructor(
        private readonly client: AlpacaClient,
        private readonly logger: Logger,
        private readonly wait: (ms: number) => Promise<unknown> = sleep,
    ) {}

    async getAccount(): Promise<Account> {
        const a = await this.client.trading("/v2/account", accountSchema);
        return { equity: a.equity, cash: a.cash, previousCloseEquity: a.last_equity };
    }

    async getPositions(): Promise<Position[]> {
        const positions = await this.client.trading("/v2/positions", zod.array(positionSchema));
        return positions.map((position) => ({
            ticker: toTicker(position.symbol),
            qty: position.qty,
            avgEntryPrice: position.avg_entry_price,
            currentPrice: position.current_price,
            marketValue: position.market_value,
            unrealizedPl: position.unrealized_pl,
        }));
    }

    async getCalendar(from: TradingDate, to: TradingDate): Promise<MarketDay[]> {
        const days = await this.client.trading("/v2/calendar", calendarSchema, { query: { start: from, end: to } });
        return days.map((day) => {
            const date = toTradingDate(day.date);
            return { date, open: newYorkInstant(date, day.open), close: newYorkInstant(date, day.close) };
        });
    }

    async placeOrder(intent: OrderIntent): Promise<BrokerOrder> {
        try {
            const order = await this.client.trading("/v2/orders", orderSchema, {
                method: "POST",
                body: orderBody(intent),
            });
            return toBrokerOrder(order);
        } catch (error) {
            // A retry after a lost response, or a rerun after a crash: the order is already there.
            if (error instanceof HttpError && error.status === 422 && /client_order_id/i.test(error.body)) {
                const existing = await this.getOrderByClientId(intent.clientOrderId);
                if (existing) return existing;
            }
            throw error;
        }
    }

    async getOrderByClientId(clientOrderId: string): Promise<BrokerOrder | undefined> {
        try {
            const order = await this.client.trading("/v2/orders:by_client_order_id", orderSchema, {
                query: { client_order_id: clientOrderId, nested: true },
            });
            return toBrokerOrder(order);
        } catch (error) {
            if (error instanceof HttpError && error.status === 404) return undefined;
            throw error;
        }
    }

    async listOpenOrders(): Promise<BrokerOrder[]> {
        const orders = await this.client.trading("/v2/orders", zod.array(orderSchema), {
            query: { status: "open", nested: true, limit: 500, direction: "asc" },
        });
        return orders.map((order) => toBrokerOrder(order));
    }

    async cancelOrder(orderId: string): Promise<void> {
        try {
            await this.client.trading(`/v2/orders/${encodeURIComponent(orderId)}`, zod.unknown(), { method: "DELETE" });
        } catch (error) {
            // 422: the order is already filled, cancelled or expired, so there is nothing to cancel.
            if (error instanceof HttpError && error.status === 422) return;
            throw error;
        }
        // Alpaca cancels in the background and keeps the shares reserved until it has.
        for (let check = 1; check <= CANCEL_CHECKS; check++) {
            const order = await this.client.trading(`/v2/orders/${encodeURIComponent(orderId)}`, orderSchema);
            if (!OPEN_ORDER_STATUSES.includes(statusOf(order))) return;
            if (check < CANCEL_CHECKS) await this.wait(CANCEL_CHECK_MS);
        }
        throw new Error(`Order ${orderId} is still not cancelled after ${(CANCEL_CHECKS * CANCEL_CHECK_MS) / 1000}s`);
    }

    async getFills(since: Date): Promise<BrokerFill[]> {
        const fills: BrokerFill[] = [];
        let pageToken: string | undefined;
        do {
            const page = await this.client.trading("/v2/account/activities/FILL", zod.array(fillSchema), {
                query: { after: since.toISOString(), direction: "asc", page_size: 100, page_token: pageToken },
            });
            for (const f of page) {
                if (f.side === "sell_short")
                    throw new PermanentError(`Short sale fill ${f.id}: the account must not short`);
                const time = new Date(f.transaction_time);
                fills.push({
                    id: f.id,
                    orderId: f.order_id,
                    ticker: toTicker(f.symbol),
                    side: f.side,
                    qty: f.qty,
                    price: f.price,
                    // No commission. SEC and FINRA fees on sells post as one FEE activity a day and are already in
                    // the account's equity, so fills carry no fee (docs/operations.md, Going live).
                    fee: cents(0),
                    date: tradingDateOf(time),
                    time,
                });
            }
            pageToken = page.length === 100 ? page.at(-1)?.id : undefined;
        } while (pageToken);
        return fills;
    }

    /** Makes sure margin and shorting are off, switching them off if needed, and fails if that does not stick. */
    async verifyAccountSafety(): Promise<void> {
        const safe = (configuration: zod.output<typeof configurationsSchema>) =>
            configuration.no_shorting && Number(configuration.max_margin_multiplier) === 1;
        const current = await this.client.trading("/v2/account/configurations", configurationsSchema);
        if (safe(current)) return;
        this.logger.warn(current, "account allows margin or shorting; switching both off");
        const updated = await this.client.trading("/v2/account/configurations", configurationsSchema, {
            method: "PATCH",
            body: { no_shorting: true, max_margin_multiplier: "1" },
        });
        if (!safe(updated)) throw new PermanentError("Account still allows margin or short selling; refusing to trade");
    }
}

function orderBody(intent: OrderIntent): Record<string, unknown> {
    const price = (amount: Cents) => centsToDollars(amount).toFixed(2);
    const base = {
        symbol: intent.ticker,
        qty: String(intent.qty),
        side: intent.side,
        type: "limit",
        limit_price: price(intent.limitPrice),
        client_order_id: intent.clientOrderId,
    };
    if (intent.side === "sell") return { ...base, time_in_force: "day", order_class: "simple" };
    if (intent.stopLossPrice === undefined || intent.takeProfitPrice === undefined) {
        throw new PermanentError(`Buy ${intent.clientOrderId} needs stop-loss and take-profit prices`);
    }
    return {
        ...base,
        time_in_force: "gtc",
        order_class: "bracket",
        take_profit: { limit_price: price(intent.takeProfitPrice) },
        stop_loss: { stop_price: price(intent.stopLossPrice) },
    };
}

function toBrokerOrder(order: AlpacaOrder, parent?: AlpacaOrder): BrokerOrder {
    return {
        id: order.id,
        clientOrderId: order.client_order_id,
        ticker: toTicker(order.symbol),
        side: order.side,
        role: roleOf(order, parent),
        qty: order.qty,
        filledQty: order.filled_qty,
        filledAvgPrice: order.filled_avg_price,
        limitPrice: order.limit_price,
        stopPrice: order.stop_price,
        status: statusOf(order),
        submittedAt: new Date(order.submitted_at),
        legs: order.legs.map((leg) => toBrokerOrder(leg, order)),
    };
}

function statusOf(order: AlpacaOrder): OrderStatus {
    return STATUS.get(order.status) ?? "open";
}

function roleOf(order: AlpacaOrder, parent: AlpacaOrder | undefined): OrderRole {
    if (order.type === "stop" || order.type === "stop_limit") return "stop_loss";
    if (parent) return "take_profit";
    return order.side === "buy" ? "entry" : "exit";
}
