import { dailyLossBreached } from "../core/risk/index.js";
import { cents, formatCents } from "../core/money.js";
import { toTicker, tradingDateOf, type Account, type Cents, type TradingDate } from "../core/types.js";
import { OPEN_ORDER_STATUSES, type BrokerFill, type BrokerOrder } from "../ports/broker.js";
import type { BenchmarkPosition } from "../ports/repositories.js";
import { tradingDays } from "./calendar.js";
import type { AppDeps } from "./deps.js";
import { toOrderRecord } from "./executeAtOpen.js";
import { performance, reportText } from "./report.js";
import { runJob, skip, type JobResult } from "./runJob.js";
import { simulateShadowDay } from "./shadowStrategies.js";
import { withComparison } from "./strategyReport.js";
import { syncBroker } from "./sync.js";

/**
 * The end-of-day job (spec §4.4): cancel unfilled entries, sync, snapshot equity and the benchmark, check the
 * daily loss stop and send the daily summary. Runs after the close once SIP bars for the day are available.
 */
export async function recordEndOfDay(deps: AppDeps): Promise<JobResult> {
    const today = tradingDateOf(deps.clock.now());
    return runJob(deps, "end_of_day", today, async () => {
        const days = await tradingDays(deps.broker, today);
        if (!days.today) return skip(`${today} is not a trading day`);
        await endOfDay(deps, today);
        return undefined;
    });
}

async function endOfDay(deps: AppDeps, today: TradingDate): Promise<void> {
    const { repos, notifier, config, clock } = deps;

    const unfilled = await closeOutEntries(deps, today);
    const { account, positions } = await syncBroker(deps);

    const benchmark = (await repos.settings.get()).benchmark ?? (await startBenchmark(deps, account, today));
    const benchmarkValue = await benchmarkValueOn(deps, benchmark, today);
    const previous = await repos.equity.latest();
    await repos.equity.save({ date: today, equity: account.equity, cash: account.cash, benchmarkValue });

    const lines = [
        `📅 ${today}: equity ${formatCents(account.equity)} (${change(account.equity, account.previousCloseEquity)} today)`,
    ];
    if (previous && previous.date !== today) {
        lines.push(
            `Benchmark ${config.benchmarkSymbol}: ${formatCents(benchmarkValue)} (${change(benchmarkValue, previous.benchmarkValue)} today)`,
        );
    } else {
        lines.push(`Benchmark ${config.benchmarkSymbol}: ${formatCents(benchmarkValue)}`);
    }

    const fills = (await repos.fills.list()).filter((f) => f.date === today);
    const exits = await protectiveExits(deps, fills);
    for (const fill of fills) {
        const kind = exits.get(fill.orderId);
        const icon = kind === "stop_loss" ? "🛡️ stop-loss" : kind === "take_profit" ? "🎯 take-profit" : fill.side;
        lines.push(`${icon} ${fill.qty} ${fill.ticker} at ${formatCents(fill.price)}`);
    }
    for (const order of unfilled) {
        lines.push(
            `Not filled: buy ${order.qty - order.filledQty} ${order.ticker} (limit ${formatCents(order.limitPrice ?? cents(0))} not reached), cancelled`,
        );
    }

    const settings = await repos.settings.get();
    if (
        !settings.halted &&
        dailyLossBreached(account.equity, account.previousCloseEquity, config.risk.dailyLossStopPct)
    ) {
        await repos.settings.update({ halted: true, haltReason: `daily loss stop on ${today}` });
        lines.push("🛑 Daily loss stop hit: trading is halted. Send /resume to start again.");
    }

    const perf = await performance({ repos, clock, config }, positions);
    lines.push(`Since day one: account ${pctText(perf.accountReturn)} vs benchmark ${pctText(perf.benchmarkReturn)}`);
    const strategies = await simulateShadowDay(deps, today);
    if (strategies.length > 0) lines.push("", "Virtual strategies:", ...strategies);
    await notifier.send(lines.join("\n"));
}

/**
 * Stores the final status of today's orders and cancels entries that did not fill completely (they are gtc
 * brackets so their stops persist). Returns the cancelled entries; partial fills keep their legs.
 */
async function closeOutEntries(deps: AppDeps, today: TradingDate): Promise<BrokerOrder[]> {
    const { broker, repos, clock } = deps;
    const open = await repos.orders.list({ tradeDate: today, statuses: OPEN_ORDER_STATUSES });
    const unfilled: BrokerOrder[] = [];
    for (const record of open) {
        const order = await broker.getOrderByClientId(record.clientOrderId);
        if (!order) continue;
        if (order.role === "entry" && OPEN_ORDER_STATUSES.includes(order.status)) {
            await broker.cancelOrder(order.id);
            const cancelled = (await broker.getOrderByClientId(record.clientOrderId)) ?? order;
            await repos.orders.upsert(toOrderRecord(cancelled, record.proposalId, today, clock.now()));
            unfilled.push(cancelled);
        } else {
            await repos.orders.upsert(toOrderRecord(order, record.proposalId, today, clock.now()));
        }
    }
    return unfilled;
}

/** Maps broker order ids of bracket legs that filled today to their role. */
async function protectiveExits(deps: AppDeps, fills: BrokerFill[]): Promise<Map<string, string>> {
    const roles = new Map<string, string>();
    const sells = fills.filter((f) => f.side === "sell");
    if (sells.length === 0) return roles;
    const entries = (await deps.repos.orders.list({})).filter(
        (o) => o.role === "entry" && sells.some((s) => s.ticker === o.ticker),
    );
    for (const entry of entries) {
        const order = await deps.broker.getOrderByClientId(entry.clientOrderId);
        for (const leg of order?.legs ?? []) roles.set(leg.id, leg.role);
    }
    return roles;
}

/** Day one: a virtual buy of the benchmark with the account's starting equity. */
async function startBenchmark(deps: AppDeps, account: Account, today: TradingDate): Promise<BenchmarkPosition> {
    const price = await benchmarkClose(deps, today);
    const benchmark: BenchmarkPosition = {
        symbol: deps.config.benchmarkSymbol,
        shares: account.equity / price,
        startDate: today,
        startValue: account.equity,
    };
    await deps.repos.settings.update({ benchmark });
    return benchmark;
}

async function benchmarkValueOn(deps: AppDeps, benchmark: BenchmarkPosition, today: TradingDate): Promise<Cents> {
    return cents(Math.round(benchmark.shares * (await benchmarkClose(deps, today, benchmark.symbol))));
}

async function benchmarkClose(deps: AppDeps, today: TradingDate, symbol = deps.config.benchmarkSymbol): Promise<Cents> {
    const ticker = toTicker(symbol);
    const bars = await deps.marketData.getDailyBars([ticker], today, today);
    const close = bars.get(ticker)?.at(-1)?.close;
    if (close === undefined) throw new Error(`No ${symbol} close for ${today} yet`);
    return close;
}

function change(now: number, before: number): string {
    return before > 0 ? pctText(now / before - 1, true) : "n/a";
}

function pctText(fraction: number, signed = false): string {
    return `${signed && fraction >= 0 ? "+" : ""}${(fraction * 100).toFixed(2)}%`;
}

/** Sunday job: the weekly performance report and go-live gate. */
export async function sendWeeklyReport(deps: AppDeps): Promise<JobResult> {
    return runJob(deps, "weekly_report", tradingDateOf(deps.clock.now()), async () => {
        const { positions } = await syncBroker(deps);
        const report = reportText(await performance(deps, positions));
        await deps.notifier.send(`🗓️ Weekly report\n${await withComparison(deps, report)}`);
        return undefined;
    });
}
