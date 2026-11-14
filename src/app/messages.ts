import { shortPercent } from "../core/format.js";
import { formatCents, multiplyCents } from "../core/money.js";
import { bracketPrices } from "../core/sizing.js";
import type { Proposal } from "../core/types.js";

/** One proposal for Telegram: what, how much, at what price, why, and any risk adjustments. */
export function proposalText(p: Proposal): string {
    const lines = [
        `${p.side === "buy" ? "🟢 BUY" : "🔴 SELL"} ${p.qty} ${p.ticker} at ${p.side === "buy" ? "≤" : "≥"} ${formatCents(p.limitPrice)}`,
        `Target ${shortPercent(p.targetWeight)} of equity · confidence ${p.confidence}/5 · ≈ ${formatCents(multiplyCents(p.limitPrice, p.qty))}`,
    ];
    if (p.side === "buy" && p.stopLossPct !== undefined && p.takeProfitPct !== undefined) {
        const { stopLossPrice, takeProfitPrice } = bracketPrices(
            p.previousClose,
            p.limitPrice,
            p.stopLossPct,
            p.takeProfitPct,
        );
        lines.push(
            `Stop ${formatCents(stopLossPrice)} (−${shortPercent(p.stopLossPct)}) · target ${formatCents(takeProfitPrice)} (+${shortPercent(p.takeProfitPct)})`,
        );
    }
    lines.push(p.reasoning);
    if (p.qty < p.requestedQty)
        lines.push(`Risk: ${p.qty === 0 ? "rejected" : `trimmed from ${p.requestedQty}`} (${p.riskNotes.join("; ")})`);
    return lines.join("\n");
}

/** The evening summary: market view, then every proposal. */
export function eveningSummaryText(
    tradeDate: string,
    marketView: string,
    proposals: readonly Proposal[],
    autoApproved: boolean,
): string {
    const active = proposals.filter((p) => p.qty > 0);
    const rejected = proposals.filter((p) => p.qty === 0);
    const header =
        active.length === 0
            ? `No trades for ${tradeDate}.`
            : `${active.length} order${active.length === 1 ? "" : "s"} for the open on ${tradeDate}${autoApproved ? " (paper: auto-approved)" : ""}.`;
    const parts = [header, `Market: ${marketView}`];
    if (autoApproved) parts.push(...active.map(proposalText));
    if (rejected.length > 0) {
        parts.push(
            `Rejected by risk checks:\n${rejected.map((p) => `• ${p.side} ${p.ticker}: ${p.riskNotes.join("; ")}`).join("\n")}`,
        );
    }
    return parts.join("\n\n");
}
