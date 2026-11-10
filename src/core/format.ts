/** A fraction as a percentage with fixed decimals: 0.1234 -> "12.3%". */
export function percent(fraction: number, digits = 1): string {
    return `${(fraction * 100).toFixed(digits)}%`;
}

/** Like `percent`, with a plus sign on zero and gains: 0.05 -> "+5.0%". */
export function signedPercent(fraction: number, digits = 1): string {
    return `${fraction >= 0 ? "+" : ""}${percent(fraction, digits)}`;
}

/** Rounded to a tenth with no trailing zero, for limits and weights: 0.1 -> "10%", 0.125 -> "12.5%". */
export function shortPercent(fraction: number): string {
    return `${Math.round(fraction * 1000) / 10}%`;
}
