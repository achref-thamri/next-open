import type { RiskLimits } from "../config/schema.js";
import { signedPercent } from "../core/format.js";
import { cents, formatCents, type Cents } from "../core/money.js";
import { runRiskChecks, simulatePortfolio } from "../core/risk/index.js";
import { asBrokerState, portfolioValue, simulateDay, type VirtualPortfolio } from "../core/simulation.js";
import { bracketPrices } from "../core/sizing.js";
import { momentumDecisions } from "../core/strategies/momentum.js";
import type { Candidate, DailyBar, Decision, Ticker, TradingDate } from "../core/types.js";
import { rankCandidates } from "../core/universe/ranking.js";
import type { NewsItem } from "../ports/news.js";
import type { ShadowAccount, ShadowOrder, StrategyId } from "../ports/repositories.js";
import { promptInput, sizeDecisions } from "./analysisShared.js";
import { weekOf } from "./buildLiquidList.js";
import type { AppDeps } from "./deps.js";
import { buildPrompt } from "./prompt.js";
import type { BrokerState } from "./sync.js";
import { validateDecisions } from "./validateDecisions.js";

/** What the evening run already gathered, shared by every strategy. */
export interface ShadowContext {
    runId: string;
    asOf: TradingDate;
    tradeDate: TradingDate;
    /** Every candidate built tonight, including the shadow portfolios' holdings. */
    candidates: ReadonlyMap<Ticker, Candidate>;
    /** Candidates that pass the universe filters. */
    eligible: readonly Candidate[];
    /** At least three months of daily bars. */
    history: ReadonlyMap<Ticker, DailyBar[]>;
    marketNews: NewsItem[];
    contextTickers: Ticker[];
    newsSince: Date;
    /** Starting value of a new virtual portfolio: the real account's equity, so all start equal. */
    startEquity: Cents;
}

interface ShadowStrategy {
    id: Exclude<StrategyId, "claude">;
    name: string;
    limits(risk: RiskLimits): RiskLimits;
    decide(
        deps: AppDeps,
        ctx: ShadowContext,
        account: ShadowAccount,
        state: BrokerState,
        limits: RiskLimits,
    ): Promise<Decision[]>;
}

const PATIENT_STYLE = `This portfolio is managed patiently. Hold positions for weeks to months and let the protective \
orders handle normal swings. Open a new position only on a clear, lasting reason, at most two a week. Sell only \
when the reason for holding is gone. When in doubt, hold.`;

export const SHADOW_STRATEGIES: readonly ShadowStrategy[] = [
    {
        id: "claude_patient",
        name: "Patient AI",
        limits: (risk) => ({ ...risk, maxOrdersPerDay: Math.min(risk.maxOrdersPerDay, 3) }),
        decide: patientDecisions,
    },
    {
        id: "momentum",
        name: "Momentum rule",
        limits: (risk) => risk,
        decide: (_deps, ctx, _account, state) => {
            const holdings = new Set(state.positions.map((p) => p.ticker));
            // Rebalance on the last trading day of the week, and on the first run.
            const rebalance = weekOf(ctx.tradeDate) !== weekOf(ctx.asOf) || holdings.size === 0;
            return Promise.resolve(rebalance ? momentumDecisions(ctx.eligible, ctx.history, holdings) : []);
        },
    },
];

/** Tickers held by any virtual portfolio, so the evening run builds candidates for them too. */
export async function shadowHoldings(deps: AppDeps): Promise<Ticker[]> {
    const tickers: Ticker[] = [];
    for (const strategy of SHADOW_STRATEGIES) {
        const account = await deps.repos.shadow.getAccount(strategy.id);
        tickers.push(...(account?.portfolio.positions.map((p) => p.ticker) ?? []));
    }
    return tickers;
}

/**
 * Evening: each virtual strategy decides on its own portfolio with tonight's data, and its orders for the next
 * trading day are sized, risk-checked with the same rules and stored. One strategy failing never affects the
 * real account or the other strategies.
 */
export async function proposeShadowOrders(deps: AppDeps, ctx: ShadowContext): Promise<void> {
    for (const strategy of SHADOW_STRATEGIES) {
        try {
            await proposeFor(deps, ctx, strategy);
        } catch (error) {
            deps.logger.error({ err: error, strategy: strategy.id }, "shadow strategy failed");
        }
    }
}

async function proposeFor(deps: AppDeps, ctx: ShadowContext, strategy: ShadowStrategy): Promise<void> {
    const { repos, config, logger } = deps;
    const account = await openAccount(deps, strategy.id, ctx);
    const snapshots = await repos.shadow.snapshots(strategy.id);
    const marked: VirtualPortfolio = {
        cash: account.portfolio.cash,
        positions: account.portfolio.positions.map((p) => ({
            ...p,
            lastPrice: ctx.candidates.get(p.ticker)?.close ?? p.lastPrice,
        })),
    };
    const state = asBrokerState(marked, snapshots.at(-1)?.equity ?? account.startValue);
    const limits = strategy.limits(config.risk);

    const decisions = await strategy.decide(deps, ctx, account, state, limits);
    const closes = new Map([...ctx.candidates.values()].map((c) => [c.ticker, c.close]));
    const { orders, decisionOf } = sizeDecisions(decisions, closes, state, limits.maxEntryGapPct, logger);
    const checked = runRiskChecks(orders, simulatePortfolio(state.account, state.positions), {
        limits,
        universeLimits: config.universe,
        halted: false,
        account: state.account,
        securities: ctx.candidates,
    });

    const shadowOrders: ShadowOrder[] = checked.orders.flatMap(({ order, qty }) => {
        const decision = decisionOf.get(order.id);
        if (qty === 0 || !decision) return [];
        const legs =
            order.side === "buy"
                ? bracketPrices(order.limitPrice, decision.stopLossPct, decision.takeProfitPct)
                : undefined;
        return [
            {
                id: order.id,
                ticker: order.ticker,
                side: order.side,
                qty,
                limitPrice: order.limitPrice,
                stopLossPrice: legs?.stopLossPrice,
                takeProfitPrice: legs?.takeProfitPrice,
                reasoning: decision.reasoning,
                status: "pending",
            },
        ];
    });
    await repos.shadow.saveOrders(strategy.id, ctx.tradeDate, shadowOrders);
    logger.info({ strategy: strategy.id, orders: shadowOrders.length }, "shadow orders stored");
}

async function openAccount(deps: AppDeps, strategy: StrategyId, ctx: ShadowContext): Promise<ShadowAccount> {
    const existing = await deps.repos.shadow.getAccount(strategy);
    if (existing) return existing;
    await deps.repos.shadow.openAccount({
        strategy,
        portfolio: { cash: ctx.startEquity, positions: [] },
        startDate: ctx.asOf,
        startValue: ctx.startEquity,
    });
    const opened = await deps.repos.shadow.getAccount(strategy);
    if (!opened) throw new Error(`Could not open the ${strategy} portfolio`);
    return opened;
}

/** The patient AI variant: the same data and model, its own portfolio, and a patient style. */
async function patientDecisions(
    deps: AppDeps,
    ctx: ShadowContext,
    account: ShadowAccount,
    state: BrokerState,
    limits: RiskLimits,
): Promise<Decision[]> {
    const held = new Set(state.positions.map((p) => p.ticker));
    const pool: Candidate[] = [];
    for (const c of ctx.eligible) if (!held.has(c.ticker)) pool.push({ ...c, isHolding: false });
    for (const ticker of held) {
        const c = ctx.candidates.get(ticker);
        if (!c) throw new Error(`No price data for ${ticker}`);
        pool.push({ ...c, isHolding: true });
    }
    const shortlist = rankCandidates(pool, deps.config.universe.maxCandidates);
    const tickerNews = await deps.news.getNews({
        since: ctx.newsSince,
        until: deps.clock.now(),
        tickers: shortlist.map((c) => c.ticker),
        limit: 100,
    });
    const prompt = buildPrompt(
        promptInput({
            asOf: ctx.asOf,
            tradeDate: ctx.tradeDate,
            state,
            shortlist,
            history: ctx.history,
            marketNews: ctx.marketNews,
            tickerNews,
            recentDecisions: [],
            openDates: new Map(account.portfolio.positions.map((p) => [p.ticker, p.openedOn])),
            contextTickers: ctx.contextTickers,
            limits,
            style: PATIENT_STYLE,
        }),
    );
    const result = await deps.llm.decide(prompt);
    await deps.repos.llmCalls.save(ctx.runId, result.call);
    if (!result.ok) throw new Error(`invalid LLM output: ${result.error}`);
    const validation = validateDecisions(result.output, new Set(shortlist.map((c) => c.ticker)), held, limits);
    if (!validation.ok) throw new Error(`invalid LLM output: ${validation.errors.join("; ")}`);
    return validation.decisions;
}

/**
 * End of day: simulate today's orders and protective legs for every virtual portfolio from today's bars, once
 * per day. Returns one summary line per strategy.
 */
export async function simulateShadowDay(deps: AppDeps, today: TradingDate): Promise<string[]> {
    const lines: string[] = [];
    for (const strategy of SHADOW_STRATEGIES) {
        try {
            const line = await simulateFor(deps, strategy, today);
            if (line) lines.push(line);
        } catch (error) {
            deps.logger.error({ err: error, strategy: strategy.id }, "shadow simulation failed");
            lines.push(
                `${strategy.name}: simulation failed (${error instanceof Error ? error.message : String(error)})`,
            );
        }
    }
    return lines;
}

async function simulateFor(deps: AppDeps, strategy: ShadowStrategy, today: TradingDate): Promise<string | undefined> {
    const { repos, marketData } = deps;
    const account = await repos.shadow.getAccount(strategy.id);
    if (!account) return undefined;
    if (account.lastSimulated !== undefined && account.lastSimulated >= today) return undefined;

    const orders = await repos.shadow.pendingOrders(strategy.id, today);
    const tickers = [...new Set([...orders.map((o) => o.ticker), ...account.portfolio.positions.map((p) => p.ticker)])];
    const bars = new Map<Ticker, DailyBar>();
    if (tickers.length > 0) {
        for (const [ticker, list] of await marketData.getDailyBars(tickers, today, today)) {
            const bar = list.find((b) => b.date === today);
            if (bar) bars.set(ticker, bar);
        }
    }
    const result = simulateDay(account.portfolio, orders, bars, today);
    const equity = portfolioValue(result.portfolio);
    await repos.shadow.recordDay({
        strategy: strategy.id,
        date: today,
        portfolio: result.portfolio,
        fills: result.fills,
        filledOrderIds: orders.filter((o) => !result.unfilled.includes(o)).map((o) => o.id),
        equity,
    });
    const change = account.startValue > 0 ? equity / account.startValue - 1 : 0;
    return `${strategy.name}: ${formatCents(cents(equity))} (${signedPercent(change, 2)} since start)`;
}
