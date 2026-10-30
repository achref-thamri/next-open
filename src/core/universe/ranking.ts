import type { Candidate } from "../types.js";

/** How unusual today's move is: absolute return weighted by relative volume. */
export function moveScore(candidate: Pick<Candidate, "changePct" | "relativeVolume">): number {
    return Math.abs(candidate.changePct) * candidate.relativeVolume;
}

/**
 * The shortlist sent to the LLM, at most `max` long unless holdings alone exceed it.
 * Holdings always come first and are never cut. Remaining slots go to tickers in the news, then to the
 * highest move scores. Ties break by ticker so runs are reproducible.
 */
export function rankCandidates(candidates: readonly Candidate[], max: number): Candidate[] {
    const holdings = candidates.filter((c) => c.isHolding).sort(byTicker);
    const others = candidates
        .filter((c) => !c.isHolding)
        .sort((a, b) => Number(b.inNews) - Number(a.inNews) || moveScore(b) - moveScore(a) || byTicker(a, b));
    return [...holdings, ...others.slice(0, Math.max(0, max - holdings.length))];
}

function byTicker(a: Candidate, b: Candidate): number {
    return a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0;
}
