import type { Cents } from "../core/money.js";
import { maxDrawdown, winRate } from "../core/metrics.js";
import { closedTrades } from "../core/trades.js";
import type { Fill, TradingDate } from "../core/types.js";
import type { AppDeps } from "./deps.js";
import { SHADOW_STRATEGIES } from "./shadowStrategies.js";

export interface StrategyResult {
    name: string;
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
 * paper account, each virtual strategy and the VT benchmark. Undefined before the first simulated day.
 */
export async function compareStrategies(deps: Pick<AppDeps, "repos">): Promise<StrategyComparison | undefined> {
    const { repos } = deps;
    const virtual = await Promise.all(
        SHADOW_STRATEGIES.map(async (s) => ({
            name: s.name,
            snapshots: await repos.shadow.snapshots(s.id),
            fills: await repos.shadow.fills(s.id),
        })),
    );
    const since = virtual.flatMap((v) => (v.snapshots[0] ? [v.snapshots[0].date] : [])).sort()[0];
    if (since === undefined) return undefined;

    const real = (await repos.equity.list()).filter((s) => s.date >= since);
    const realFills = (await repos.fills.list()).filter((f) => f.date >= since);
    const results: StrategyResult[] = [
        result(
            "Claude (real paper account)",
            real.map((s) => s.equity),
            realFills,
        ),
        ...virtual.map((v) =>
            result(
                v.name,
                v.snapshots.map((s) => s.equity),
                v.fills,
            ),
        ),
        result(
            "VT buy-and-hold",
            real.map((s) => s.benchmarkValue),
            [],
        ),
    ];
    return { since, days: real.length, results };
}

function result(name: string, values: readonly Cents[], fills: readonly Fill[]): StrategyResult {
    const first = values[0];
    const last = values.at(-1);
    const trades = closedTrades(fills);
    return {
        name,
        return: first && last ? last / first - 1 : 0,
        maxDrawdown: maxDrawdown(values),
        trades: trades.length,
        winRate: winRate(trades),
    };
}

const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;

export function comparisonText(c: StrategyComparison): string {
    const lines = [`🏁 Strategies since ${c.since} (${c.days} trading day${c.days === 1 ? "" : "s"}):`];
    for (const r of [...c.results].sort((a, b) => b.return - a.return)) {
        const trades =
            r.name === "VT buy-and-hold"
                ? ""
                : ` · ${r.trades} closed trade${r.trades === 1 ? "" : "s"}${r.winRate === undefined ? "" : `, ${Math.round(r.winRate * 100)}% won`}`;
        lines.push(`• ${r.name}: ${pct(r.return)} · max drawdown ${(r.maxDrawdown * 100).toFixed(1)}%${trades}`);
    }
    return lines.join("\n");
}

/** Appends the strategy comparison to a report once there is one. */
export async function withComparison(deps: Pick<AppDeps, "repos">, report: string): Promise<string> {
    const comparison = await compareStrategies(deps);
    return comparison ? `${report}\n\n${comparisonText(comparison)}` : report;
}
