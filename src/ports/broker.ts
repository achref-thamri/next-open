import type { Cents } from "../core/money.js";
import type { Account, Fill, OrderIntent, Position, Side, Ticker, TradingDate } from "../core/types.js";

/** A trading day with its regular session times (half days close early). */
export interface MarketDay {
    date: TradingDate;
    open: Date;
    close: Date;
}

export type OrderStatus = "open" | "partially_filled" | "filled" | "canceled" | "expired" | "rejected";

/** entry: a buy (bracket parent); exit: a plain sell; stop_loss / take_profit: bracket legs. */
export type OrderRole = "entry" | "exit" | "stop_loss" | "take_profit";

export interface BrokerOrder {
    id: string;
    clientOrderId: string;
    ticker: Ticker;
    side: Side;
    role: OrderRole;
    qty: number;
    filledQty: number;
    filledAvgPrice: Cents | undefined;
    limitPrice: Cents | undefined;
    stopPrice: Cents | undefined;
    status: OrderStatus;
    submittedAt: Date;
    /** Bracket legs of an entry order. */
    legs: BrokerOrder[];
}

export interface BrokerFill extends Fill {
    id: string;
    orderId: string;
    time: Date;
}

export const OPEN_ORDER_STATUSES: readonly OrderStatus[] = ["open", "partially_filled"];

/** The brokerage account. The broker is the source of truth for cash, positions and orders. */
export interface Broker {
    getAccount(): Promise<Account>;
    getPositions(): Promise<Position[]>;
    /** Trading days in the inclusive date range. */
    getCalendar(from: TradingDate, to: TradingDate): Promise<MarketDay[]>;
    /**
     * Places a limit order; buys carry stop-loss and take-profit legs. Idempotent on `clientOrderId`:
     * placing it again returns the existing order instead of a duplicate.
     */
    placeOrder(intent: OrderIntent): Promise<BrokerOrder>;
    getOrderByClientId(clientOrderId: string): Promise<BrokerOrder | undefined>;
    /** Open orders, bracket legs nested under their entry. */
    listOpenOrders(): Promise<BrokerOrder[]>;
    /** Cancels an order; cancelling a finished order is a no-op. */
    cancelOrder(orderId: string): Promise<void>;
    /** Executions since the given time, oldest first. */
    getFills(since: Date): Promise<BrokerFill[]>;
    /** Throws unless margin and short selling are switched off on the account. */
    verifyAccountSafety(): Promise<void>;
}
