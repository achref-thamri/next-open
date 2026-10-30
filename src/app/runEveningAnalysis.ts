import { centsToDollars } from "../core/money.js";
import { runRiskChecks, simulatePortfolio, type CheckedOrder, type OrderRequest } from "../core/risk/index.js";
import { limitPrice, sizeOrder } from "../core/sizing.js";
import { positionOpenDates } from "../core/trades.js";
import {
    toTicker,
    tradingDateOf,
    type Candidate,
    type DailyBar,
    type Decision,
    type Position,
    type Proposal,
    type Ticker,
    type TradingDate,
} from "../core/types.js";
import { annualizedVolatility, barFeatures, periodReturns } from "../core/universe/features.js";
import { filterUniverse, type SecurityFacts } from "../core/universe/filters.js";
import { rankCandidates } from "../core/universe/ranking.js";
import { newId } from "../lib/ids.js";
import type { NewsItem } from "../ports/news.js";
import type { CandidateRecord, DecisionRecord } from "../ports/repositories.js";
import { addDays, tradingDays } from "./calendar.js";
import type { AppDeps } from "./deps.js";
import { eveningSummaryText, proposalText } from "./messages.js";
import { buildPrompt, type PromptCandidate, type PromptInput } from "./prompt.js";
import { runJob, skip, type JobResult } from "./runJob.js";
import { syncBroker, type BrokerState } from "./sync.js";
import { validateDecisions } from "./validateDecisions.js";

/** ETFs used only for market context (never traded). */
const CONTEXT_SYMBOLS = [{ symbol: "SPY", description: "S&P 500" }] as const;
const FEATURE_HISTORY_DAYS = 45;
const RETURN_HISTORY_DAYS = 130;
const MARKET_HEADLINES = 15;
const HEADLINES_PER_TICKER = 3;
const RECENT_DECISIONS = 20;

/**
 * The evening job (spec §4.1): sync → candidates → filter → rank → LLM → validate → size → risk checks →
 * store → notify. In paper mode proposals are approved at once; in live mode they wait for the owner.
 */
export async function runEveningAnalysis(deps: AppDeps): Promise<JobResult> {
    const asOf = tradingDateOf(deps.clock.now());
    return runJob(deps, "evening_analysis", asOf, async (runId) => {
        const days = await tradingDays(deps.broker, asOf);
        if (!days.today) return skip(`${asOf} is not a trading day`);
        const earlier = await deps.repos.proposals.list({ tradeDate: days.next.date });
        if (earlier.length > 0) return skip(`proposals for ${days.next.date} already exist`);
        return analyse(deps, runId, asOf, days.next.date);
    });
}

async function analyse(deps: AppDeps, runId: string, asOf: TradingDate, tradeDate: TradingDate): Promise<JobResult> {
    const { config, repos, marketData, logger } = deps;
    const log = logger.child({ job: "evening_analysis", runId });

    const state = await syncBroker(deps);
    const liquid = await repos.liquidLists.latestComplete();
    if (!liquid) return skip("no complete liquid list yet; the weekly job is still filling the profile cache");

    const holdings = new Set(state.positions.map((p) => p.ticker));
    const since = new Date(deps.clock.now().getTime() - 24 * 3_600_000);
    const marketNews = await deps.news.getNews({ since, until: deps.clock.now(), limit: 50 });
    const newsTickers = new Set(marketNews.flatMap((n) => n.tickers));

    // Phase 1: a month of bars for everything that could be a candidate, enough for the filters and ranking.
    const universe = [...new Set([...liquid.tickers, ...holdings, ...newsTickers])];
    const [assets, profiles, recentBars] = await Promise.all([
        marketData.listTradableAssets(),
        repos.profiles.getMany(universe),
        marketData.getDailyBars(universe, addDays(asOf, -FEATURE_HISTORY_DAYS), asOf),
    ]);
    if (![...recentBars.values()].some((bars) => bars.at(-1)?.date === asOf)) {
        throw new Error(`No daily bars for ${asOf} yet; refusing to analyse stale data`);
    }
    const exchanges = new Map(assets.map((a) => [a.ticker, a.exchange]));
    const records: CandidateRecord[] = [];
    const pool: Candidate[] = [];
    for (const ticker of universe) {
        const isHolding = holdings.has(ticker);
        // A ticker without a bar for today (halted, delisted) is stale; only a holding is kept, at its broker price.
        const bars = recentBars.get(ticker);
        const candidate = buildCandidate(
            ticker,
            bars?.at(-1)?.date === asOf ? bars : undefined,
            state,
            exchanges,
            profiles,
            newsTickers,
            config.universe.avgVolumeDays,
        );
        if (!candidate) {
            if (isHolding) throw new Error(`No price data for holding ${ticker}`);
            continue;
        }
        const profile = profiles.get(ticker);
        const result: { pass: boolean; reason?: string } = profile
            ? filterUniverse(candidate, config.universe)
            : { pass: false, reason: "no company profile cached" };
        records.push({ candidate, passed: result.pass, rejectReason: result.pass ? undefined : result.reason });
        if (result.pass || isHolding) pool.push(candidate);
    }
    const shortlist = rankCandidates(pool, config.universe.maxCandidates);
    await repos.candidates.saveMany(runId, records);
    log.info({ universe: universe.length, passed: pool.length, shortlist: shortlist.length }, "candidates ranked");

    // Phase 2: three months of history for the shortlist, context ETFs and recently decided tickers.
    const recentDecisions = await repos.decisions.recent(RECENT_DECISIONS);
    const contextTickers = [...CONTEXT_SYMBOLS.map((c) => c.symbol), config.benchmarkSymbol].map(toTicker);
    const historyTickers = [
        ...new Set([...shortlist.map((c) => c.ticker), ...contextTickers, ...recentDecisions.map((d) => d.ticker)]),
    ];
    const [history, tickerNews, fills] = await Promise.all([
        marketData.getDailyBars(historyTickers, addDays(asOf, -RETURN_HISTORY_DAYS), asOf),
        deps.news.getNews({ since, until: deps.clock.now(), tickers: shortlist.map((c) => c.ticker), limit: 100 }),
        repos.fills.list(),
    ]);

    const prompt = buildPrompt(
        promptInput({
            asOf,
            tradeDate,
            state,
            shortlist,
            history,
            marketNews,
            tickerNews,
            recentDecisions,
            openDates: positionOpenDates(fills),
            contextTickers,
            deps,
        }),
    );
    const llmResult = await deps.llm.decide(prompt);
    const llmCallId = await repos.llmCalls.save(runId, llmResult.call);
    if (!llmResult.ok) throw new Error(`invalid LLM output: ${llmResult.error}`);

    const validation = validateDecisions(
        llmResult.output,
        new Set(shortlist.map((c) => c.ticker)),
        holdings,
        config.risk,
    );
    if (!validation.ok) throw new Error(`invalid LLM output: ${validation.errors.join("; ")}`);
    const createdAt = deps.clock.now();
    await repos.decisions.saveMany(
        validation.decisions.map((d): DecisionRecord => ({
            ...d,
            id: newId(),
            runId,
            llmCallId,
            tradeDate: asOf,
            createdAt,
        })),
    );

    const proposals = await propose(deps, runId, tradeDate, validation.decisions, shortlist, state);
    await repos.proposals.saveMany(proposals);
    await notify(deps, tradeDate, llmResult.output.marketView, proposals);
    return { status: "succeeded", message: `${proposals.filter((p) => p.qty > 0).length} proposals` };
}

function buildCandidate(
    ticker: Ticker,
    bars: DailyBar[] | undefined,
    state: BrokerState,
    exchanges: ReadonlyMap<Ticker, string>,
    profiles: ReadonlyMap<Ticker, { kind: Candidate["kind"]; marketCapUsd: number | undefined }>,
    newsTickers: ReadonlySet<Ticker>,
    avgVolumeDays: number,
): Candidate | undefined {
    const position = state.positions.find((p) => p.ticker === ticker);
    // A holding without recent bars (e.g. halted stock) still needs a decision, at the broker's price.
    const features =
        (bars && barFeatures(bars, avgVolumeDays)) ??
        (position && { close: position.currentPrice, changePct: 0, relativeVolume: 0, avgDollarVolumeUsd: 0 });
    if (!features) return undefined;
    const profile = profiles.get(ticker);
    return {
        ticker,
        exchange: exchanges.get(ticker) ?? "UNKNOWN",
        kind: profile?.kind ?? "other",
        marketCapUsd: profile?.marketCapUsd,
        isHolding: position !== undefined,
        inNews: newsTickers.has(ticker),
        ...features,
    };
}

interface PromptSources {
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
    deps: AppDeps;
}

function promptInput(s: PromptSources): PromptInput {
    const { account, positions } = s.state;
    const equity = account.equity;
    const daysBetween = (from: TradingDate) => Math.round((Date.parse(s.asOf) - Date.parse(from)) / 86_400_000);
    const headlinesFor = (ticker: Ticker) =>
        s.tickerNews
            .filter((n) => n.tickers.includes(ticker))
            .slice(0, HEADLINES_PER_TICKER)
            .map((n) => n.headline);
    const closeOn = (ticker: Ticker, date: TradingDate) => s.history.get(ticker)?.find((b) => b.date === date)?.close;
    const latestClose = (ticker: Ticker) => s.history.get(ticker)?.at(-1)?.close;

    const candidates: PromptCandidate[] = s.shortlist.map((c) => ({
        ticker: c.ticker,
        priceUsd: centsToDollars(c.close),
        returns: periodReturns(s.history.get(c.ticker) ?? []),
        relativeVolume: c.relativeVolume,
        marketCapUsd: c.marketCapUsd,
        isHolding: c.isHolding,
        headlines: headlinesFor(c.ticker),
    }));
    const indexDescriptions = new Map<string, string>(CONTEXT_SYMBOLS.map((c) => [c.symbol, c.description]));

    return {
        asOf: s.asOf,
        tradeDate: s.tradeDate,
        portfolio: {
            equityUsd: centsToDollars(equity),
            cashUsd: centsToDollars(account.cash),
            positions: positions.map((p: Position) => {
                const opened = s.openDates.get(p.ticker);
                return {
                    ticker: p.ticker,
                    qty: p.qty,
                    avgEntryPriceUsd: centsToDollars(p.avgEntryPrice),
                    priceUsd: centsToDollars(p.currentPrice),
                    unrealizedPct: p.avgEntryPrice > 0 ? p.currentPrice / p.avgEntryPrice - 1 : 0,
                    weight: equity > 0 ? p.marketValue / equity : 0,
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
            headlines: s.marketNews.slice(0, MARKET_HEADLINES).map((n) => n.headline),
        },
        recentDecisions: s.recentDecisions.map((d) => {
            const then = closeOn(d.ticker, d.tradeDate);
            const now = latestClose(d.ticker);
            return {
                date: d.tradeDate,
                ticker: d.ticker,
                action: d.action,
                targetWeight: d.targetWeight,
                confidence: d.confidence,
                outcomePct: then && now ? now / then - 1 : undefined,
            };
        }),
        limits: s.deps.config.risk,
    };
}

/** Sizes buy and sell decisions into orders, runs the risk checks and turns the result into proposals. */
async function propose(
    deps: AppDeps,
    runId: string,
    tradeDate: TradingDate,
    decisions: Decision[],
    shortlist: Candidate[],
    state: BrokerState,
): Promise<Proposal[]> {
    const { config, repos, logger } = deps;
    const closes = new Map(shortlist.map((c) => [c.ticker, c.close]));
    const held = new Map(state.positions.map((p) => [p.ticker, p.qty]));
    const byOrderId = new Map<string, Decision>();
    const orders: OrderRequest[] = [];

    for (const decision of decisions) {
        if (decision.action === "hold") continue;
        const close = closes.get(decision.ticker);
        if (close === undefined) continue;
        const price = limitPrice(close, decision.action, config.risk.maxEntryGapPct);
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
        byOrderId.set(id, decision);
        orders.push({ id, ticker: decision.ticker, side: sized.side, qty: sized.qty, limitPrice: price });
    }

    const settings = await repos.settings.get();
    const securities = new Map<Ticker, SecurityFacts>(shortlist.map((c) => [c.ticker, c]));
    const result = runRiskChecks(orders, simulatePortfolio(state.account, state.positions), {
        limits: config.risk,
        universeLimits: config.universe,
        halted: settings.halted,
        account: state.account,
        securities,
    });
    if (result.halt && !settings.halted) {
        await repos.settings.update({ halted: true, haltReason: "daily loss stop" });
        await deps.notifier.send("🛑 Daily loss stop hit: trading is halted. Send /resume to start again.");
    }

    return result.orders.map((checked) => toProposal(checked, byOrderId, runId, tradeDate, config.mode === "paper"));
}

function toProposal(
    checked: CheckedOrder,
    decisions: ReadonlyMap<string, Decision>,
    runId: string,
    tradeDate: TradingDate,
    autoApprove: boolean,
): Proposal {
    const { order } = checked;
    const decision = decisions.get(order.id);
    if (!decision) throw new Error(`No decision for order ${order.id}`);
    const isBuy = order.side === "buy";
    return {
        id: order.id,
        runId,
        tradeDate,
        ticker: order.ticker,
        side: order.side,
        requestedQty: order.qty,
        qty: checked.qty,
        limitPrice: order.limitPrice,
        targetWeight: decision.targetWeight,
        stopLossPct: isBuy ? decision.stopLossPct : undefined,
        takeProfitPct: isBuy ? decision.takeProfitPct : undefined,
        confidence: decision.confidence,
        reasoning: decision.reasoning,
        status: checked.qty === 0 ? "rejected" : autoApprove ? "approved" : "pending",
        riskNotes: checked.notes,
    };
}

async function notify(deps: AppDeps, tradeDate: TradingDate, marketView: string, proposals: Proposal[]): Promise<void> {
    const autoApproved = deps.config.mode === "paper";
    await deps.notifier.send(eveningSummaryText(tradeDate, marketView, proposals, autoApproved));
    if (autoApproved) return;
    const pending = proposals.filter((p) => p.status === "pending");
    for (const proposal of pending) await deps.notifier.sendProposal(proposalText(proposal), proposal.id);
    if (pending.length > 1)
        await deps.notifier.sendApproveAll(`Approve all ${pending.length} orders for ${tradeDate}?`, tradeDate);
}
