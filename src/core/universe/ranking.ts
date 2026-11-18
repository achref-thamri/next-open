import type { Candidate } from "../types.js";

/** How unusual today's move is: absolute return weighted by relative volume. */
export function moveScore(candidate: Pick<Candidate, "changePct" | "relativeVolume">): number {
    return Math.abs(candidate.changePct) * candidate.relativeVolume;
}

/**
 * The shortlist sent to the LLM, at most `max` long unless holdings alone exceed it.
 * Holdings always come first and are never cut. Half of the remaining slots go to the strongest uptrends (6-month
 * return above the 200-day average), the stocks with a track record of continuing; the rest go to tickers in the
 * news, then to the highest move scores. Ties break by ticker so runs are reproducible.
 */
export function rankCandidates(candidates: readonly Candidate[], max: number): Candidate[] {
    const holdings = candidates.filter((c) => c.isHolding).sort(byTicker);
    const others = candidates.filter((c) => !c.isHolding);
    const slots = Math.max(0, max - holdings.length);

    const trend = others
        .filter((c) => c.uptrend6m !== undefined)
        .sort((a, b) => (b.uptrend6m ?? 0) - (a.uptrend6m ?? 0) || byTicker(a, b))
        .slice(0, Math.floor(slots / 2));
    const picked = new Set(trend.map((c) => c.ticker));
    const events = others
        .filter((c) => !picked.has(c.ticker))
        .sort((a, b) => Number(b.inNews) - Number(a.inNews) || moveScore(b) - moveScore(a) || byTicker(a, b))
        .slice(0, slots - trend.length);
    return [...holdings, ...trend, ...events];
}

function byTicker(a: Candidate, b: Candidate): number {
    return a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0;
}
