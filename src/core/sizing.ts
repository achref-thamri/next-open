import { cents, multiplyCents, type Cents } from "./money.js";
import type { Side } from "./types.js";

export interface SizingInput {
    equity: Cents;
    /** Fraction of equity; 0 means exit the position. */
    targetWeight: number;
    /** Shares held now (0 when not held). */
    currentQty: number;
    limitPrice: Cents;
}

export interface SizedOrder {
    side: Side;
    qty: number;
}

/**
 * Whole-share order that moves the position to its target weight at the limit price.
 * Buys round down so the target is never exceeded; a zero target sells everything.
 * Returns undefined when no whole-share change is needed.
 */
export function sizeOrder({ equity, targetWeight, currentQty, limitPrice }: SizingInput): SizedOrder | undefined {
    if (limitPrice <= 0) throw new RangeError(`Limit price must be positive, got ${limitPrice}`);
    if (!Number.isSafeInteger(currentQty) || currentQty < 0) {
        throw new RangeError(`Current quantity must be a whole number of shares, got ${currentQty}`);
    }
    const targetValue = Math.max(0, equity * Math.max(0, targetWeight));
    const targetQty = targetWeight > 0 ? Math.floor(targetValue / limitPrice + 1e-9) : 0;

    if (targetQty > currentQty) return { side: "buy", qty: targetQty - currentQty };
    if (targetQty < currentQty) return { side: "sell", qty: currentQty - targetQty };
    return undefined;
}

/**
 * Limit price relative to the previous close: buys at most `gapPct` above it (rounded down),
 * sells at least `gapPct` below it (rounded up), so the bot never chases an overnight gap.
 */
export function limitPrice(previousClose: Cents, side: Side, gapPct: number): Cents {
    return side === "buy"
        ? multiplyCents(previousClose, 1 + gapPct, "down")
        : multiplyCents(previousClose, 1 - gapPct, "up");
}

export interface BracketPrices {
    stopLossPrice: Cents;
    takeProfitPrice: Cents;
}

/** Stop-loss and take-profit prices for a buy, at least one cent away from the limit price. */
export function bracketPrices(limit: Cents, stopLossPct: number, takeProfitPct: number): BracketPrices {
    const stop = multiplyCents(limit, 1 - stopLossPct, "down");
    const take = multiplyCents(limit, 1 + takeProfitPct, "up");
    return {
        stopLossPrice: cents(Math.max(1, Math.min(stop, limit - 1))),
        takeProfitPrice: cents(Math.max(take, limit + 1)),
    };
}
