import { cents, type Cents } from "./money.js";
import type { Fill, Ticker, TradingDate } from "./types.js";

/** The realised result of one sell. */
export interface ClosedTrade {
    ticker: Ticker;
    date: TradingDate;
    qty: number;
    /** Sale proceeds minus average cost, net of buy and sell fees. */
    realizedPl: Cents;
}

/**
 * Realised P/L per sell using the average cost method (gennemsnitsmetoden, the Danish rule for shares).
 * Buy fees are added to the cost basis; sell fees reduce the proceeds. Fills must be in execution order.
 */
export function closedTrades(fills: readonly Fill[]): ClosedTrade[] {
    const books = new Map<Ticker, { qty: number; cost: number }>();
    const trades: ClosedTrade[] = [];
    for (const fill of fills) {
        const book = books.get(fill.ticker) ?? { qty: 0, cost: 0 };
        if (fill.side === "buy") {
            books.set(fill.ticker, { qty: book.qty + fill.qty, cost: book.cost + fill.qty * fill.price + fill.fee });
            continue;
        }
        if (fill.qty > book.qty) {
            throw new RangeError(`Sell of ${fill.qty} ${fill.ticker} exceeds the ${book.qty} shares bought`);
        }
        const costOfSold = (book.cost * fill.qty) / book.qty;
        trades.push({
            ticker: fill.ticker,
            date: fill.date,
            qty: fill.qty,
            realizedPl: cents(Math.round(fill.qty * fill.price - fill.fee - costOfSold)),
        });
        books.set(fill.ticker, { qty: book.qty - fill.qty, cost: book.cost - costOfSold });
    }
    return trades;
}

/** Realised P/L summed per calendar year, for the yearly tax. */
export function gainsByYear(trades: readonly ClosedTrade[]): Map<number, Cents> {
    const gains = new Map<number, Cents>();
    for (const trade of trades) {
        const year = Number(trade.date.slice(0, 4));
        gains.set(year, cents((gains.get(year) ?? 0) + trade.realizedPl));
    }
    return gains;
}

/** The date each currently held position was opened (first buy after it was last flat). */
export function positionOpenDates(fills: readonly Fill[]): Map<Ticker, TradingDate> {
    const qty = new Map<Ticker, number>();
    const opened = new Map<Ticker, TradingDate>();
    for (const fill of fills) {
        const before = qty.get(fill.ticker) ?? 0;
        const after = before + (fill.side === "buy" ? fill.qty : -fill.qty);
        if (before <= 0 && after > 0) opened.set(fill.ticker, fill.date);
        if (after <= 0) opened.delete(fill.ticker);
        qty.set(fill.ticker, after);
    }
    return opened;
}
