declare const centsBrand: unique symbol;

/** Integer US cents. All cash, equity, prices, P/L and fees in core use this type. */
export type Cents = number & { readonly [centsBrand]: true };

export type Rounding = "down" | "up" | "nearest";

/** Validates an integer amount of cents. */
export function cents(value: number): Cents {
    if (!Number.isSafeInteger(value)) throw new RangeError(`Cents must be a safe integer, got ${value}`);
    return value as Cents;
}

/**
 * Converts a dollar amount from an external API to cents, rounding half away from zero.
 * Uses 15 significant digits first so float noise (1.005 * 100 = 100.49999...) does not flip the rounding.
 */
export function dollarsToCents(dollars: number): Cents {
    if (!Number.isFinite(dollars)) throw new RangeError(`Dollar amount must be finite, got ${dollars}`);
    const scaled = Number((Math.abs(dollars) * 100).toPrecision(15));
    return cents(Math.sign(dollars) * Math.round(scaled) || 0);
}

/** Cents to dollars, for adapter requests and display. */
export function centsToDollars(amount: Cents): number {
    return amount / 100;
}

/** Multiplies an amount by a factor (a weight, a percentage, a share count) and rounds to whole cents. */
export function multiplyCents(amount: Cents, factor: number, rounding: Rounding = "nearest"): Cents {
    if (!Number.isFinite(factor)) throw new RangeError(`Factor must be finite, got ${factor}`);
    return cents(round(Number((amount * factor).toPrecision(15)), rounding));
}

export function sumCents(amounts: Iterable<Cents>): Cents {
    let total = 0;
    for (const amount of amounts) total += amount;
    return cents(total);
}

/** Formats cents as dollars for messages, e.g. -123456 -> "-$1,234.56". */
export function formatCents(amount: Cents): string {
    const sign = amount < 0 ? "-" : "";
    return `${sign}$${(Math.abs(amount) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function round(value: number, rounding: Rounding): number {
    switch (rounding) {
        case "down":
            return Math.floor(value);
        case "up":
            return Math.ceil(value);
        case "nearest":
            return Math.sign(value) * Math.round(Math.abs(value)) || 0;
    }
}
