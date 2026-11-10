import { percent } from "../format.js";
import type { Candidate, DailyBar, Decision, Ticker } from "../types.js";
import { periodReturns } from "../universe/features.js";

export interface MomentumRules {
    /** Positions held after a rebalance. */
    positions: number;
    /** A holding is kept while it ranks within this many. */
    keepWithin: number;
    targetWeight: number;
    stopLossPct: number;
}

/** Ten equal positions of 9% (10% cash), held while in the top 20, with a wide 15% stop. */
const MOMENTUM_RULES: MomentumRules = { positions: 10, keepWithin: 20, targetWeight: 0.09, stopLossPct: 0.15 };

/**
 * A plain momentum rule, no AI: rank eligible stocks by 3-month return (1-month return must also be positive,
 * so the trend is intact), sell holdings that dropped out of the top `keepWithin`, buy the best-ranked stocks
 * not held until `positions` are filled. Ties break by ticker.
 */
export function momentumDecisions(
    eligible: readonly Candidate[],
    history: ReadonlyMap<Ticker, readonly DailyBar[]>,
    holdings: ReadonlySet<Ticker>,
    rules: MomentumRules = MOMENTUM_RULES,
): Decision[] {
    const ranked = eligible
        .flatMap((c) => {
            const r = periodReturns(history.get(c.ticker) ?? []);
            return r.m3 !== undefined && r.m1 !== undefined && r.m1 > 0 ? [{ ticker: c.ticker, m3: r.m3 }] : [];
        })
        .sort((a, b) => b.m3 - a.m3 || (a.ticker < b.ticker ? -1 : 1));
    const rank = new Map(ranked.map((r, i) => [r.ticker, i + 1]));

    const decisions: Decision[] = [];
    let kept = 0;
    for (const ticker of [...holdings].sort()) {
        const place = rank.get(ticker);
        if (place !== undefined && place <= rules.keepWithin) {
            kept++;
            continue;
        }
        decisions.push(
            decision(
                ticker,
                "sell",
                0,
                place === undefined ? "Trend broken or no longer eligible." : `Dropped to rank ${place}.`,
            ),
        );
    }
    for (const { ticker, m3 } of ranked) {
        if (kept >= rules.positions) break;
        if (holdings.has(ticker)) continue;
        kept++;
        decisions.push(
            decision(
                ticker,
                "buy",
                rules.targetWeight,
                `Rank ${rank.get(ticker) ?? "?"} by 3-month return (+${percent(m3)}).`,
            ),
        );
    }
    return decisions;

    function decision(ticker: Ticker, action: "buy" | "sell", targetWeight: number, reasoning: string): Decision {
        return {
            ticker,
            action,
            targetWeight,
            confidence: 3,
            stopLossPct: rules.stopLossPct,
            // Momentum lets winners run: the target is far enough away never to trigger in practice.
            takeProfitPct: 1,
            horizonDays: 20,
            reasoning,
        };
    }
}
