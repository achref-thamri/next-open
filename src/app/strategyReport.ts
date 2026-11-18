import { percent, signedPercent } from "../core/format.js";
import type { Cents } from "../core/money.js";
import { maxDrawdown, winRate } from "../core/metrics.js";
import { scorePicks, type PickScore } from "../core/pickScore.js";
import { closedTrades } from "../core/trades.js";
import { toTicker, tradingDateOf, type Fill, type TradingDate } from "../core/types.js";
import type { AppDeps } from "./deps.js";
import { SHADOW_STRATEGIES } from "./shadowStrategies.js";

interface StrategyResult {
    name: string;
    /** The buy-and-hold benchmark, which makes no trades. */
    isBenchmark: boolean;
    return: number;
    maxDrawdown: number;
    trades: number;
    winRate: number | undefined;
}

export interface StrategyComparison {
    since: TradingDate;
    days: number;
    results: StrategyResult[];
}

/**
 * Every strategy over the same window, from the first day the virtual portfolios were simulated: the real
 * paper account, each virtual strategy and the buy-and-hold benchmark. Undefined before the first simulated day.
 */
export async function compareStrategies(
    deps: Pick<AppDeps, "repos" | "config">,
): Promise<StrategyComparison | undefined> {
    const { repos, config } = deps;
    const virtual = await Promise.all(
        SHADOW_STRATEGIES.map(async (strategy) => ({
            name: strategy.name,
            snapshots: await repos.shadow.snapshots(strategy.id),
            fills: await repos.shadow.fills(strategy.id),
        })),
    );
    const since = virtual
        .flatMap((portfolio) => (portfolio.snapshots[0] ? [portfolio.snapshots[0].date] : []))
        .sort()[0];
    if (since === undefined) return undefined;

    const real = (await repos.equity.list()).filter((snapshot) => snapshot.date >= since);
    const realFills = (await repos.fills.list()).filter((brokerFill) => brokerFill.date >= since);
    const results: StrategyResult[] = [
        result(
            "AI (real paper account)",
            real.map((snapshot) => snapshot.equity),
            realFills,
        ),
        // A strategy added later is shown from its own first day, so its return covers a shorter window.
        ...virtual.flatMap((portfolio) => {
            const first = portfolio.snapshots[0]?.date;
            if (first === undefined) return [];
            const name = first > since ? `${portfolio.name} (from ${first})` : portfolio.name;
            return [
                result(
                    name,
                    portfolio.snapshots.map((snapshot) => snapshot.equity),
                    portfolio.fills,
                ),
            ];
        }),
        {
            ...result(
                `${config.benchmarkSymbol} buy-and-hold`,
                real.map((snapshot) => snapshot.benchmarkValue),
                [],
            ),
            isBenchmark: true,
        },
    ];
    return { since, days: real.length, results };
}

function result(name: string, values: readonly Cents[], fills: readonly Fill[]): StrategyResult {
    const first = values[0];
    const last = values.at(-1);
    const trades = closedTrades(fills);
    return {
        name,
        isBenchmark: false,
        return: first && last ? last / first - 1 : 0,
        maxDrawdown: maxDrawdown(values),
        trades: trades.length,
        winRate: winRate(trades),
    };
}

export function comparisonText(c: StrategyComparison): string {
    const lines = [`🏁 Strategies since ${c.since} (${c.days} trading day${c.days === 1 ? "" : "s"}):`];
    for (const r of [...c.results].sort((a, b) => b.return - a.return)) {
        const trades = r.isBenchmark
            ? ""
            : ` · ${r.trades} closed trade${r.trades === 1 ? "" : "s"}${r.winRate === undefined ? "" : `, ${Math.round(r.winRate * 100)}% won`}`;
        lines.push(`• ${r.name}: ${signedPercent(r.return)} · max drawdown ${percent(r.maxDrawdown)}${trades}`);
    }
    return lines.join("\n");
}

/** Appends the strategy comparison to a report once there is one. */
export async function withComparison(deps: Pick<AppDeps, "repos" | "config">, report: string): Promise<string> {
    const comparison = await compareStrategies(deps);
    return comparison ? `${report}\n\n${comparisonText(comparison)}` : report;
}

const PICK_HORIZONS = [5, 20] as const;
const PICK_INDEX = toTicker("SPY");
/** Far more buy decisions than a paper period makes. */
const MAX_PICKS = 1_000;

/**
 * How the AI's buy decisions did against the S&P 500 after 5 and 20 trading days, approved or not. This judges the
 * picks themselves, apart from sizing, stops and fills, and builds up much faster than closed trades.
 */
async function pickScores(deps: Pick<AppDeps, "repos" | "marketData" | "clock">): Promise<PickScore[]> {
    const buys = (await deps.repos.decisions.recent(MAX_PICKS)).filter((decision) => decision.action === "buy");
    const first = buys.map((decision) => decision.tradeDate).sort()[0];
    if (first === undefined) return [];
    const tickers = [...new Set([...buys.map((decision) => decision.ticker), PICK_INDEX])];
    const history = await deps.marketData.getDailyBars(tickers, first, tradingDateOf(deps.clock.now()));
    return scorePicks(
        buys.map((decision) => ({ ticker: decision.ticker, date: decision.tradeDate })),
        history,
        history.get(PICK_INDEX) ?? [],
        PICK_HORIZONS,
    );
}

export function pickScoreText(scores: readonly PickScore[]): string | undefined {
    if (scores.length === 0) return undefined;
    const lines = ["🎯 AI buy picks vs the S&P 500:"];
    for (const s of scores) {
        lines.push(
            s.picks === 0
                ? `• after ${s.horizon} trading days: no picks that old yet`
                : `• after ${s.horizon} trading days: ${signedPercent(s.avgExcess)} on average over ${s.picks} ` +
                      `pick${s.picks === 1 ? "" : "s"}, ${Math.round(s.beatShare * 100)}% beat it`,
        );
    }
    return lines.join("\n");
}

/** Appends the pick scorecard to a report once there are buy decisions. A data error never breaks the report. */
export async function withPickScores(
    deps: Pick<AppDeps, "repos" | "marketData" | "clock" | "logger">,
    report: string,
): Promise<string> {
    try {
        const text = pickScoreText(await pickScores(deps));
        return text ? `${report}\n\n${text}` : report;
    } catch (error) {
        deps.logger.warn({ err: error }, "pick scorecard unavailable");
        return report;
    }
}
