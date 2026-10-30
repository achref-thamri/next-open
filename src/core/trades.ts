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
