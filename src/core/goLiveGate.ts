import type { TaxRates } from "../config/schema.js";
import { percent } from "./format.js";
import { cents, type Cents } from "./money.js";
import { maxDrawdown } from "./metrics.js";
import { markToMarketTax, realizedShareTax, totalTax } from "./tax.js";
import { gainsByYear, type ClosedTrade } from "./trades.js";
import type { EquitySnapshot, TradingDate } from "./types.js";

/** Fixed before trading started (docs/adr/0003-forward-testing-only.md); deliberately not configurable. */
const GO_LIVE_RULES = {
    minPaperMonths: 3,
    preferredPaperMonths: 6,
    maxExtraDrawdown: 0.05,
    bugFreeDays: 30,
} as const;

export interface GoLiveInput {
    /** Daily snapshots from the first paper day, oldest first. */
    snapshots: readonly EquitySnapshot[];
    closedTrades: readonly ClosedTrade[];
    /** Unrealised P/L of open positions, taxed as if sold today. */
    unrealizedPl: Cents;
    /** Date of the latest failed run that has not been explained. */
    lastUnexplainedFailure: TradingDate | undefined;
    today: TradingDate;
    taxRates: TaxRates;
}

interface Criterion {
    name: string;
    pass: boolean;
    /** Measured value and requirement, ready to show to the owner. */
    detail: string;
}

export interface GoLiveResult {
    pass: boolean;
    criteria: Criterion[];
    accountReturnAfterTax: number;
    benchmarkReturnAfterTax: number;
    accountMaxDrawdown: number;
    benchmarkMaxDrawdown: number;
}

/**
 * The four go-live criteria. Returns compare liquidation values: the account as if every position were
 * sold today, the benchmark after its yearly mark-to-market tax including the current year.
 */
export function evaluateGoLiveGate(input: GoLiveInput): GoLiveResult {
    const { snapshots, today } = input;
    const first = snapshots[0];
    const last = snapshots.at(-1);

    const months = first ? monthsBetween(first.date, today) : 0;
    const paperPeriod = {
        name: "Paper trading period",
        pass: months >= GO_LIVE_RULES.minPaperMonths,
        detail: `${months} month${months === 1 ? "" : "s"} (need ${GO_LIVE_RULES.minPaperMonths}, prefer ${GO_LIVE_RULES.preferredPaperMonths})`,
    };

    const accountReturnAfterTax = first && last ? afterTaxAccountReturn(input, first, last) : 0;
    const benchmarkReturnAfterTax = first && last ? afterTaxBenchmarkReturn(input, first, last) : 0;
    const beatsBenchmark = {
        name: "Beats benchmark after fees and tax",
        pass: snapshots.length > 1 && accountReturnAfterTax > benchmarkReturnAfterTax,
        detail: `account ${percent(accountReturnAfterTax)} vs benchmark ${percent(benchmarkReturnAfterTax)}`,
    };

    const accountMaxDrawdown = maxDrawdown(snapshots.map((s) => s.equity));
    const benchmarkMaxDrawdown = maxDrawdown(snapshots.map((s) => s.benchmarkValue));
    const drawdown = {
        name: "Max drawdown",
        pass: accountMaxDrawdown <= benchmarkMaxDrawdown + GO_LIVE_RULES.maxExtraDrawdown + 1e-12,
        detail: `account ${percent(accountMaxDrawdown)} vs benchmark ${percent(benchmarkMaxDrawdown)} (allowed ${GO_LIVE_RULES.maxExtraDrawdown * 100} points worse)`,
    };

    const failure = input.lastUnexplainedFailure;
    const quietDays = failure === undefined ? undefined : daysBetween(failure, today);
    const noBugs = {
        name: "No unexplained bugs",
        pass: quietDays === undefined || quietDays > GO_LIVE_RULES.bugFreeDays,
        detail:
            failure === undefined
                ? "none recorded"
                : `last on ${failure}, ${quietDays} days ago (need more than ${GO_LIVE_RULES.bugFreeDays})`,
    };

    const criteria = [paperPeriod, beatsBenchmark, drawdown, noBugs];
    return {
        pass: criteria.every((c) => c.pass),
        criteria,
        accountReturnAfterTax,
        benchmarkReturnAfterTax,
        accountMaxDrawdown,
        benchmarkMaxDrawdown,
    };
}

function afterTaxAccountReturn(input: GoLiveInput, first: EquitySnapshot, last: EquitySnapshot): number {
    const gains = gainsByYear(input.closedTrades);
    const year = yearOf(input.today);
    gains.set(year, cents((gains.get(year) ?? 0) + input.unrealizedPl));
    const tax = totalTax(realizedShareTax(gains, input.taxRates));
    return (last.equity - tax) / first.equity - 1;
}

function afterTaxBenchmarkReturn(input: GoLiveInput, first: EquitySnapshot, last: EquitySnapshot): number {
    const yearEnds = new Map<number, Cents>();
    for (const snapshot of input.snapshots) yearEnds.set(yearOf(snapshot.date), snapshot.benchmarkValue);
    const values = [...yearEnds].map(([year, value]) => ({ year, value }));
    const tax = totalTax(markToMarketTax(first.benchmarkValue, values, input.taxRates));
    return (last.benchmarkValue - tax) / first.benchmarkValue - 1;
}

function yearOf(date: TradingDate): number {
    return Number(date.slice(0, 4));
}

/** Whole calendar months from `from` to `to`; a month counts once the same day of month is reached. */
export function monthsBetween(from: TradingDate, to: TradingDate): number {
    const [fy, fm, fd] = from.split("-").map(Number) as [number, number, number];
    const [ty, tm, td] = to.split("-").map(Number) as [number, number, number];
    const months = (ty - fy) * 12 + (tm - fm) - (td < fd ? 1 : 0);
    return Math.max(0, months);
}

function daysBetween(from: TradingDate, to: TradingDate): number {
    return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}
