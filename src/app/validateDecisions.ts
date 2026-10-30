import type { RiskLimits } from "../config/schema.js";
import { isTicker, type Decision, type Ticker } from "../core/types.js";
import type { LlmDecisionOutput } from "../ports/llm.js";

export type DecisionValidation = { ok: true; decisions: Decision[] } | { ok: false; errors: string[] };

/**
 * Checks the model's decisions against the run: only shortlisted tickers, each at most once, weights and
 * protective distances in range, and every current holding present (selling is an explicit decision).
 * Any problem invalidates the whole answer, so no trades are made from it.
 */
export function validateDecisions(
    output: LlmDecisionOutput,
    shortlist: ReadonlySet<Ticker>,
    holdings: ReadonlySet<Ticker>,
    limits: RiskLimits,
): DecisionValidation {
    const errors: string[] = [];
    const seen = new Set<string>();
    for (const d of output.decisions) {
        const ticker = d.ticker;
        if (!isTicker(ticker) || !shortlist.has(ticker)) errors.push(`unknown ticker ${ticker}`);
        if (seen.has(ticker)) errors.push(`${ticker} appears more than once`);
        seen.add(ticker);
        if (!(d.targetWeight >= 0 && d.targetWeight <= limits.maxPositionWeight)) {
            errors.push(`${ticker} target weight ${d.targetWeight} outside 0..${limits.maxPositionWeight}`);
        }
        if (d.action === "buy" && d.targetWeight === 0) errors.push(`${ticker} buy with a zero target weight`);
        if (!(d.stopLossPct > 0 && d.stopLossPct < 0.5))
            errors.push(`${ticker} stop-loss ${d.stopLossPct} outside 0..0.5`);
        if (!(d.takeProfitPct > 0 && d.takeProfitPct <= 2)) {
            errors.push(`${ticker} take-profit ${d.takeProfitPct} outside 0..2`);
        }
    }
    for (const ticker of holdings) {
        if (!seen.has(ticker)) errors.push(`holding ${ticker} has no decision`);
    }
    return errors.length > 0
        ? { ok: false, errors }
        : { ok: true, decisions: output.decisions.map((d) => ({ ...d, ticker: d.ticker as Ticker })) };
}
