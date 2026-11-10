import { runRiskChecks, simulatePortfolio, type CheckedOrder } from "../core/risk/index.js";
import { positionOpenDates } from "../core/trades.js";
import {
    toTicker,
    tradingDateOf,
    type Candidate,
    type DailyBar,
    type Decision,
    type Fill,
    type Proposal,
    type Ticker,
    type TradingDate,
} from "../core/types.js";
import { filterUniverse, type SecurityFacts } from "../core/universe/filters.js";
import { rankCandidates } from "../core/universe/ranking.js";
import { newId } from "../lib/ids.js";
import type { NewsItem } from "../ports/news.js";
import type { CandidateRecord, DecisionRecord } from "../ports/repositories.js";
import { buildCandidate, CONTEXT_SYMBOLS, promptInput, sizeDecisions } from "./analysisShared.js";
import { addDays, tradingDays } from "./calendar.js";
import type { AppDeps } from "./deps.js";
import { eveningSummaryText, proposalText } from "./messages.js";
import { buildPrompt } from "./prompt.js";
import { runJob, skip, type JobResult } from "./runJob.js";
import { proposeShadowOrders, shadowHoldings } from "./shadowStrategies.js";
import { syncBroker, type BrokerState } from "./sync.js";
import { validateDecisions } from "./validateDecisions.js";

/** Three months of trading days plus margin: enough for returns, ranking and the momentum strategy. */
const HISTORY_DAYS = 130;
const RECENT_DECISIONS = 20;

/**
 * The evening job: sync → candidates → filter → rank → LLM → validate → size → risk checks →
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
    // A list that is still filling is used as it is: it already holds the most traded stocks.
    const liquid = await repos.liquidLists.latest();
    if (!liquid?.tickers.length) return skip("no stocks on the liquid list yet");

    const holdings = new Set(state.positions.map((p) => p.ticker));
    const since = new Date(deps.clock.now().getTime() - 24 * 3_600_000);
    const marketNews = await deps.news.getNews({ since, until: deps.clock.now(), limit: 50 });
    const newsTickers = new Set(marketNews.flatMap((n) => n.tickers));

    // Three months of bars for everything that could be a candidate, including the virtual portfolios' holdings.
    // News also tags tickers the broker doesn't list (B3SA3 in Brazil, 2026-11-09), and one of those makes Alpaca
    // refuse the whole bars request, so only tradable tickers and current holdings go in.
    const assets = await marketData.listTradableAssets();
    const tradable = new Set(assets.map((a) => a.ticker));
    const universe = [
        ...new Set([...liquid.tickers, ...holdings, ...newsTickers, ...(await shadowHoldings(deps))]),
    ].filter((ticker) => tradable.has(ticker) || holdings.has(ticker));
    const [profiles, recentBars] = await Promise.all([
        repos.profiles.getMany(universe),
        marketData.getDailyBars(universe, addDays(asOf, -HISTORY_DAYS), asOf),
    ]);
    if (![...recentBars.values()].some((bars) => bars.at(-1)?.date === asOf)) {
        throw new Error(`No daily bars for ${asOf} yet; refusing to analyse stale data`);
    }
    const exchanges = new Map(assets.map((a) => [a.ticker, a.exchange]));
    const records: CandidateRecord[] = [];
    const pool: Candidate[] = [];
    const candidates = new Map<Ticker, Candidate>();
    const eligible: Candidate[] = [];
    for (const ticker of universe) {
        const isHolding = holdings.has(ticker);
        // A ticker without a bar for today (halted, delisted) is stale; only a holding is kept, at its broker price.
        const bars = recentBars.get(ticker);
        const candidate = buildCandidate(
            ticker,
            bars?.at(-1)?.date === asOf ? bars : undefined,
            state.positions.find((p) => p.ticker === ticker)?.currentPrice,
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
        candidates.set(ticker, candidate);
        if (result.pass) eligible.push(candidate);
        if (result.pass || isHolding) pool.push(candidate);
    }
    const shortlist = rankCandidates(pool, config.universe.maxCandidates);
    await repos.candidates.saveMany(runId, records);
    log.info({ universe: universe.length, passed: pool.length, shortlist: shortlist.length }, "candidates ranked");

    // History for context ETFs and recently decided tickers that are not candidates tonight.
    const recentDecisions = await repos.decisions.recent(RECENT_DECISIONS);
    const contextTickers = [...CONTEXT_SYMBOLS.map((c) => c.symbol), config.benchmarkSymbol].map(toTicker);
    const extraTickers = [...new Set([...contextTickers, ...recentDecisions.map((d) => d.ticker)])].filter(
        (t) => !recentBars.has(t),
    );
    const [extraBars, tickerNews, fills] = await Promise.all([
        extraTickers.length > 0
            ? marketData.getDailyBars(extraTickers, addDays(asOf, -HISTORY_DAYS), asOf)
            : Promise.resolve(new Map<Ticker, DailyBar[]>()),
        deps.news.getNews({ since, until: deps.clock.now(), tickers: shortlist.map((c) => c.ticker), limit: 100 }),
        repos.fills.list(),
    ]);
    const history = new Map([...recentBars, ...extraBars]);

    // The real strategy first; the virtual ones run afterwards even when it fails, and never fail the run.
    let failure: Error | undefined;
    let result: JobResult | undefined;
    try {
        result = await decideAndPropose({
            deps,
            runId,
            asOf,
            tradeDate,
            state,
            shortlist,
            history,
            marketNews,
            tickerNews,
            recentDecisions,
            fills,
            contextTickers,
        });
    } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
    }
    await proposeShadowOrders(deps, {
        runId,
        asOf,
        tradeDate,
        candidates,
        eligible,
        history,
        marketNews,
        contextTickers,
        newsSince: since,
        startEquity: state.account.equity,
    });
    if (failure !== undefined) throw failure;
    return result ?? { status: "succeeded" };
}

interface DecideInput {
    deps: AppDeps;
    runId: string;
    asOf: TradingDate;
    tradeDate: TradingDate;
    state: BrokerState;
    shortlist: Candidate[];
    history: Map<Ticker, DailyBar[]>;
    marketNews: NewsItem[];
    tickerNews: NewsItem[];
    recentDecisions: DecisionRecord[];
    fills: Fill[];
    contextTickers: Ticker[];
}

/** The real strategy: prompt, Claude, validation, proposals and the owner's notification. */
async function decideAndPropose(input: DecideInput): Promise<JobResult> {
    const {
        deps,
        runId,
        asOf,
        tradeDate,
        state,
        shortlist,
        history,
        marketNews,
        tickerNews,
        recentDecisions,
        fills,
        contextTickers,
    } = input;
    const { config, repos } = deps;
    const holdings = new Set(state.positions.map((p) => p.ticker));

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
            limits: config.risk,
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
    const { orders, decisionOf: byOrderId } = sizeDecisions(
        decisions,
        closes,
        state,
        config.risk.maxEntryGapPct,
        logger,
    );

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
