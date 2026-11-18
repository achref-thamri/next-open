import type { RiskLimits } from "../config/schema.js";
import { centsToDollars, type Cents } from "../core/money.js";
import type { OrderRequest } from "../core/risk/index.js";
import { limitPrice, sizeOrder, stopFloor } from "../core/sizing.js";
import {
    toTicker,
    type Candidate,
    type DailyBar,
    type Decision,
    type Position,
    type Ticker,
    type TradingDate,
} from "../core/types.js";
import { annualizedVolatility, barFeatures, periodReturns, trendFeatures } from "../core/universe/features.js";
import { newId } from "../lib/ids.js";
import type { Logger } from "../lib/logger.js";
import type { NewsItem } from "../ports/news.js";
import type { DecisionRecord } from "../ports/repositories.js";
import type { PromptCandidate, PromptInput } from "./prompt.js";
import type { BrokerState } from "./sync.js";

/** ETFs used only for market context (never traded). */
export const CONTEXT_SYMBOLS = [{ symbol: "SPY", description: "S&P 500" }] as const;
const MARKET_HEADLINES = 15;
const HEADLINES_PER_TICKER = 3;

export function buildCandidate(
    ticker: Ticker,
    bars: DailyBar[] | undefined,
    /** Price for a holding without a bar today (halted stock); undefined for anything not held. */
    holdingPrice: Cents | undefined,
    exchanges: ReadonlyMap<Ticker, string>,
    profiles: ReadonlyMap<Ticker, { kind: Candidate["kind"]; marketCapUsd: number | undefined }>,
    newsTickers: ReadonlySet<Ticker>,
    avgVolumeDays: number,
): Candidate | undefined {
    // A holding without recent bars (e.g. halted stock) still needs a decision, at its last known price.
    const features =
        (bars && barFeatures(bars, avgVolumeDays)) ??
        (holdingPrice !== undefined
            ? { close: holdingPrice, changePct: 0, relativeVolume: 0, avgDollarVolumeUsd: 0 }
            : undefined);
    if (!features) return undefined;
    const profile = profiles.get(ticker);
    const uptrend6m = bars ? uptrend(bars) : undefined;
    return {
        ticker,
        exchange: exchanges.get(ticker) ?? "UNKNOWN",
        kind: profile?.kind ?? "other",
        marketCapUsd: profile?.marketCapUsd,
        isHolding: holdingPrice !== undefined,
        inNews: newsTickers.has(ticker),
        ...features,
        ...(uptrend6m === undefined ? {} : { uptrend6m }),
    };
}

/** The 6-month return of a stock above its 200-day average, the trend signal the shortlist ranks by. */
function uptrend(bars: readonly DailyBar[]): number | undefined {
    const m6 = periodReturns(bars).m6;
    const vsMa200 = trendFeatures(bars)?.vsMa200;
    return m6 !== undefined && vsMa200 !== undefined && vsMa200 > 0 ? m6 : undefined;
}

export interface PromptSources {
    asOf: TradingDate;
    tradeDate: TradingDate;
    state: BrokerState;
    shortlist: Candidate[];
    history: ReadonlyMap<Ticker, DailyBar[]>;
    marketNews: NewsItem[];
    tickerNews: NewsItem[];
    recentDecisions: DecisionRecord[];
    openDates: ReadonlyMap<Ticker, TradingDate>;
    contextTickers: Ticker[];
    limits: RiskLimits;
    /** Next earnings report per ticker; tickers without one in the window are missing. */
    earnings?: ReadonlyMap<Ticker, TradingDate>;
    style?: string;
}

export function promptInput(s: PromptSources): PromptInput {
    const { account, positions } = s.state;
    const equity = account.equity;
    const daysBetween = (from: TradingDate) => Math.round((Date.parse(s.asOf) - Date.parse(from)) / 86_400_000);
    const headlinesFor = (ticker: Ticker) =>
        s.tickerNews
            .filter((item) => item.tickers.includes(ticker))
            .slice(0, HEADLINES_PER_TICKER)
            .map((item) => item.headline);
    const earningsIn = (date: TradingDate | undefined) =>
        date === undefined ? {} : { daysToEarnings: -daysBetween(date) };
    const closeOn = (ticker: Ticker, date: TradingDate) =>
        s.history.get(ticker)?.find((bar) => bar.date === date)?.close;
    const latestClose = (ticker: Ticker) => s.history.get(ticker)?.at(-1)?.close;

    const candidates: PromptCandidate[] = s.shortlist.map((candidate) => ({
        ticker: candidate.ticker,
        ...earningsIn(s.earnings?.get(candidate.ticker)),
        priceUsd: centsToDollars(candidate.close),
        returns: periodReturns(s.history.get(candidate.ticker) ?? []),
        ...trendFeatures(s.history.get(candidate.ticker) ?? []),
        relativeVolume: candidate.relativeVolume,
        marketCapUsd: candidate.marketCapUsd,
        isHolding: candidate.isHolding,
        headlines: headlinesFor(candidate.ticker),
    }));
    const indexDescriptions = new Map<string, string>(
        CONTEXT_SYMBOLS.map((contextSymbol) => [contextSymbol.symbol, contextSymbol.description]),
    );

    return {
        asOf: s.asOf,
        tradeDate: s.tradeDate,
        portfolio: {
            equityUsd: centsToDollars(equity),
            cashUsd: centsToDollars(account.cash),
            positions: positions.map((position: Position) => {
                const opened = s.openDates.get(position.ticker);
                return {
                    ticker: position.ticker,
                    qty: position.qty,
                    avgEntryPriceUsd: centsToDollars(position.avgEntryPrice),
                    priceUsd: centsToDollars(position.currentPrice),
                    unrealizedPct: position.avgEntryPrice > 0 ? position.currentPrice / position.avgEntryPrice - 1 : 0,
                    weight: equity > 0 ? position.marketValue / equity : 0,
                    daysHeld: opened && daysBetween(opened),
                };
            }),
        },
        candidates,
        market: {
            indices: s.contextTickers.map((symbol) => ({
                symbol,
                description: indexDescriptions.get(symbol) ?? "benchmark (global stocks)",
                returns: periodReturns(s.history.get(symbol) ?? []),
            })),
            sp500Volatility20d: annualizedVolatility(s.history.get(toTicker("SPY")) ?? [], 20),
            headlines: s.marketNews.slice(0, MARKET_HEADLINES).map((item) => item.headline),
        },
        recentDecisions: s.recentDecisions.map((decision) => {
            const then = closeOn(decision.ticker, decision.tradeDate);
            const now = latestClose(decision.ticker);
            return {
                date: decision.tradeDate,
                ticker: decision.ticker,
                action: decision.action,
                targetWeight: decision.targetWeight,
                confidence: decision.confidence,
                outcomePct: then && now ? now / then - 1 : undefined,
            };
        }),
        limits: s.limits,
        ...(s.style === undefined ? {} : { style: s.style }),
    };
}

/** Turns buy and sell decisions into whole-share limit orders against a portfolio; holds and no-ops drop out. */
export function sizeDecisions(
    decisions: readonly Decision[],
    closes: ReadonlyMap<Ticker, Cents>,
    state: BrokerState,
    gapPct: number,
    logger: Logger,
): { orders: OrderRequest[]; decisionOf: Map<string, Decision> } {
    const held = new Map(state.positions.map((position) => [position.ticker, position.qty]));
    const decisionOf = new Map<string, Decision>();
    const orders: OrderRequest[] = [];
    for (const decision of decisions) {
        if (decision.action === "hold") continue;
        const close = closes.get(decision.ticker);
        if (close === undefined) continue;
        const price = limitPrice(close, decision.action, gapPct);
        const sized = sizeOrder({
            equity: state.account.equity,
            targetWeight: decision.targetWeight,
            currentQty: held.get(decision.ticker) ?? 0,
            limitPrice: price,
        });
        if (sized?.side !== decision.action) {
            logger.info({ ticker: decision.ticker, action: decision.action, sized }, "decision needs no order");
            continue;
        }
        const id = newId();
        decisionOf.set(id, decision);
        orders.push({
            id,
            ticker: decision.ticker,
            side: sized.side,
            qty: sized.qty,
            limitPrice: price,
            stopLossPct: sized.side === "buy" ? decision.stopLossPct : undefined,
        });
    }
    return { orders, decisionOf };
}

/** Buys with their stop-loss widened to the volatility floor (see `stopFloor`); other decisions unchanged. */
export function withStopFloors(decisions: readonly Decision[], history: ReadonlyMap<Ticker, DailyBar[]>): Decision[] {
    return decisions.map((decision) =>
        decision.action === "buy"
            ? {
                  ...decision,
                  stopLossPct: stopFloor(
                      decision.stopLossPct,
                      trendFeatures(history.get(decision.ticker) ?? [])?.dailyVolatility,
                  ),
              }
            : decision,
    );
}
