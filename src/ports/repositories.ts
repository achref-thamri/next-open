import type { Cents } from "../core/money.js";
import type {
    Candidate,
    Decision,
    EquitySnapshot,
    Proposal,
    ProposalStatus,
    Side,
    Ticker,
    TradingDate,
} from "../core/types.js";
import type { BrokerFill, OrderRole, OrderStatus } from "./broker.js";
import type { CompanyProfile } from "./fundamentals.js";
import type { LlmCallRecord } from "./llm.js";

export type RunType =
    | "liquid_list"
    | "evening_analysis"
    | "approval_reminder"
    | "execute_at_open"
    | "end_of_day"
    | "weekly_report"
    | "backup";
export type RunStatus = "running" | "succeeded" | "skipped" | "failed";

export interface RunRecord {
    id: string;
    type: RunType;
    tradeDate: TradingDate;
    startedAt: Date;
    finishedAt: Date | undefined;
    status: RunStatus;
    error: string | undefined;
    /** Set by the owner once a failure is understood; unexplained failures block going live. */
    explained: boolean;
}

export interface RunsRepository {
    start(run: Pick<RunRecord, "id" | "type" | "tradeDate" | "startedAt">): Promise<void>;
    finish(
        id: string,
        result: { status: Exclude<RunStatus, "running">; finishedAt: Date; error?: string },
    ): Promise<void>;
    get(id: string): Promise<RunRecord | undefined>;
    /** The most recent run of a type for a trade date. */
    latest(type: RunType, tradeDate: TradingDate): Promise<RunRecord | undefined>;
    lastUnexplainedFailure(): Promise<RunRecord | undefined>;
    markExplained(id: string): Promise<void>;
}

export interface CandidateRecord {
    candidate: Candidate;
    passed: boolean;
    rejectReason: string | undefined;
}

export interface CandidatesRepository {
    saveMany(runId: string, records: readonly CandidateRecord[]): Promise<void>;
    listByRun(runId: string): Promise<CandidateRecord[]>;
}

export interface LlmCallsRepository {
    /** Returns the new call id. */
    save(runId: string, call: LlmCallRecord): Promise<string>;
}

export interface DecisionRecord extends Decision {
    id: string;
    runId: string;
    llmCallId: string;
    tradeDate: TradingDate;
    createdAt: Date;
}

export interface DecisionsRepository {
    saveMany(records: readonly DecisionRecord[]): Promise<void>;
    latestForTicker(ticker: Ticker): Promise<DecisionRecord | undefined>;
    /** Most recent first. */
    recent(limit: number): Promise<DecisionRecord[]>;
}

export interface ProposalsRepository {
    saveMany(proposals: readonly Proposal[]): Promise<void>;
    get(id: string): Promise<Proposal | undefined>;
    list(filter: { tradeDate?: TradingDate; statuses?: readonly ProposalStatus[] }): Promise<Proposal[]>;
    /** Moves to `to` only from one of `from`. Returns false when the status was something else (idempotency). */
    transition(id: string, from: readonly ProposalStatus[], to: ProposalStatus): Promise<boolean>;
    /** Records the result of the execution-time risk re-check. */
    updateRisk(id: string, qty: number, riskNotes: readonly string[]): Promise<void>;
}

export interface OrderRecord {
    clientOrderId: string;
    brokerOrderId: string;
    /** Undefined for orders the bot did not place itself (e.g. bracket legs). */
    proposalId: string | undefined;
    tradeDate: TradingDate;
    ticker: Ticker;
    side: Side;
    role: OrderRole;
    qty: number;
    filledQty: number;
    filledAvgPrice: Cents | undefined;
    limitPrice: Cents | undefined;
    status: OrderStatus;
    submittedAt: Date;
    updatedAt: Date;
}

export interface OrdersRepository {
    /** Inserts or updates by client order id. */
    upsert(order: OrderRecord): Promise<void>;
    getByClientOrderId(clientOrderId: string): Promise<OrderRecord | undefined>;
    list(filter: { tradeDate?: TradingDate; statuses?: readonly OrderStatus[] }): Promise<OrderRecord[]>;
}

export interface FillsRepository {
    /** Ignores fills already stored (by id). */
    saveMany(fills: readonly BrokerFill[]): Promise<void>;
    /** All fills in execution order. */
    list(): Promise<BrokerFill[]>;
    latest(): Promise<BrokerFill | undefined>;
}

export interface EquitySnapshotsRepository {
    /** One snapshot per date; a second save for the same date replaces it. */
    save(snapshot: EquitySnapshot): Promise<void>;
    /** Oldest first. */
    list(): Promise<EquitySnapshot[]>;
    latest(): Promise<EquitySnapshot | undefined>;
}

/** The virtual buy-and-hold benchmark, fixed on day one. */
export interface BenchmarkPosition {
    symbol: string;
    /** Fractional shares bought with the starting equity. */
    shares: number;
    startDate: TradingDate;
    startValue: Cents;
}

export interface BotSettings {
    halted: boolean;
    haltReason: string | undefined;
    /** Owner confirmed /golive while TRADING_MODE=live. */
    liveConfirmed: boolean;
    benchmark: BenchmarkPosition | undefined;
}

export interface SettingsRepository {
    get(): Promise<BotSettings>;
    update(patch: Partial<BotSettings>): Promise<BotSettings>;
}

export interface CachedProfile extends CompanyProfile {
    fetchedAt: Date;
}

export interface ProfilesRepository {
    get(ticker: Ticker): Promise<CachedProfile | undefined>;
    getMany(tickers: readonly Ticker[]): Promise<Map<Ticker, CachedProfile>>;
    save(profile: CachedProfile): Promise<void>;
}

export interface LiquidList {
    /** The Sunday the list was built for. */
    date: TradingDate;
    tickers: Ticker[];
    /** False while the profile cache is still filling over several days. */
    complete: boolean;
}

export interface LiquidListsRepository {
    save(list: LiquidList): Promise<void>;
    latest(): Promise<LiquidList | undefined>;
    latestComplete(): Promise<LiquidList | undefined>;
}

export interface ApiUsageRepository {
    /** Adds to the counter for an API and day, returning the new total. */
    increment(api: string, day: string, by?: number): Promise<number>;
    get(api: string, day: string): Promise<number>;
}

/** All persistence, one repository per table group. Each method is atomic on its own. */
export interface Repositories {
    runs: RunsRepository;
    candidates: CandidatesRepository;
    llmCalls: LlmCallsRepository;
    decisions: DecisionsRepository;
    proposals: ProposalsRepository;
    orders: OrdersRepository;
    fills: FillsRepository;
    equity: EquitySnapshotsRepository;
    settings: SettingsRepository;
    profiles: ProfilesRepository;
    liquidLists: LiquidListsRepository;
    apiUsage: ApiUsageRepository;
}
