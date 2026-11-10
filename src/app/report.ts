import { percent } from "../core/format.js";
import { evaluateGoLiveGate, type GoLiveResult } from "../core/goLiveGate.js";
import { cents, formatCents } from "../core/money.js";
import { maxDrawdown, sharpeRatio, totalFees, totalReturn, turnover, winRate } from "../core/metrics.js";
import { realizedShareTax, totalTax } from "../core/tax.js";
import { closedTrades, gainsByYear } from "../core/trades.js";
import { tradingDateOf, type Cents, type Position } from "../core/types.js";
import type { AppDeps } from "./deps.js";

export interface Performance {
    days: number;
    accountReturn: number;
    benchmarkReturn: number;
    accountMaxDrawdown: number;
    benchmarkMaxDrawdown: number;
    sharpe: number | undefined;
    winRate: number | undefined;
    turnover: number;
    fees: Cents;
    /** Estimated tax on realised gains so far. */
    realizedTax: Cents;
    gate: GoLiveResult;
}

/** Performance since day one and the go-live gate, from stored snapshots and fills plus open positions. */
export async function performance(
    deps: Pick<AppDeps, "repos" | "clock" | "config">,
    positions: readonly Position[],
): Promise<Performance> {
    const { repos, clock, config } = deps;
    const [snapshots, fills, failure] = await Promise.all([
        repos.equity.list(),
        repos.fills.list(),
        repos.runs.lastUnexplainedFailure(),
    ]);
    const trades = closedTrades(fills);
    const equity = snapshots.map((s) => s.equity);
    const benchmark = snapshots.map((s) => s.benchmarkValue);

    return {
        days: snapshots.length,
        accountReturn: totalReturn(equity),
        benchmarkReturn: totalReturn(benchmark),
        accountMaxDrawdown: maxDrawdown(equity),
        benchmarkMaxDrawdown: maxDrawdown(benchmark),
        sharpe: sharpeRatio(equity),
        winRate: winRate(trades),
        turnover: turnover(fills, equity),
        fees: totalFees(fills),
        realizedTax: totalTax(realizedShareTax(gainsByYear(trades), config.tax)),
        gate: evaluateGoLiveGate({
            snapshots,
            closedTrades: trades,
            unrealizedPl: cents(positions.reduce((sum, p) => sum + p.unrealizedPl, 0)),
            lastUnexplainedFailure: failure && tradingDateOf(failure.startedAt),
            today: tradingDateOf(clock.now()),
            taxRates: config.tax,
        }),
    };
}

const pct = (fraction: number | undefined) => (fraction === undefined ? "n/a" : percent(fraction));

/** The /report and weekly report text. */
export function reportText(p: Performance): string {
    const lines = [
        `📊 Performance over ${p.days} trading day${p.days === 1 ? "" : "s"}`,
        `Return: account ${pct(p.accountReturn)} vs benchmark ${pct(p.benchmarkReturn)}`,
        `Max drawdown: account ${pct(p.accountMaxDrawdown)} vs benchmark ${pct(p.benchmarkMaxDrawdown)}`,
        `Sharpe ${p.sharpe === undefined ? "n/a" : p.sharpe.toFixed(2)} · win rate ${pct(p.winRate)} · turnover ${p.turnover.toFixed(2)}×`,
        `Fees ${formatCents(p.fees)} · estimated tax on realised gains ${formatCents(p.realizedTax)}`,
        "",
        `Go-live gate: ${p.gate.pass ? "✅ PASSED" : "not yet"}`,
        ...p.gate.criteria.map((c) => `${c.pass ? "✅" : "❌"} ${c.name}: ${c.detail}`),
    ];
    return lines.join("\n");
}
