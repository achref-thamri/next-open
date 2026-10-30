import type { Candidate, Decision, Ticker, TradingDate } from "../../../core/types.js";
import type { LlmCallRecord } from "../../../ports/llm.js";
import type {
    CandidateRecord,
    CandidatesRepository,
    DecisionRecord,
    DecisionsRepository,
    LlmCallsRepository,
} from "../../../ports/repositories.js";
import { newId } from "../../../lib/ids.js";
import type { Db } from "../db.js";
import { promised, bool, fromIso, orUndefined, toIso } from "./util.js";

export class SqliteCandidatesRepository implements CandidatesRepository {
    constructor(private readonly db: Db) {}

    saveMany(runId: string, records: readonly CandidateRecord[]): Promise<void> {
        return promised(() => {
            const insert = this.db.prepare(
                "INSERT INTO candidates (run_id, ticker, features, passed, reject_reason) VALUES (?, ?, ?, ?, ?)",
            );
            this.db.transaction(() => {
                for (const r of records) {
                    insert.run(
                        runId,
                        r.candidate.ticker,
                        JSON.stringify(r.candidate),
                        Number(r.passed),
                        r.rejectReason ?? null,
                    );
                }
            })();
        });
    }

    listByRun(runId: string): Promise<CandidateRecord[]> {
        return promised(() => {
            const rows = this.db
                .prepare("SELECT features, passed, reject_reason FROM candidates WHERE run_id = ? ORDER BY ticker")
                .all(runId) as { features: string; passed: number; reject_reason: string | null }[];
            return rows.map((row) => ({
                candidate: JSON.parse(row.features) as Candidate,
                passed: bool(row.passed),
                rejectReason: orUndefined(row.reject_reason),
            }));
        });
    }
}

export class SqliteLlmCallsRepository implements LlmCallsRepository {
    constructor(private readonly db: Db) {}

    save(runId: string, call: LlmCallRecord): Promise<string> {
        return promised(() => {
            const id = newId();
            this.db
                .prepare(
                    `INSERT INTO llm_calls (id, run_id, model, system_prompt, user_prompt, response, input_tokens,
                        output_tokens, cost_usd, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                )
                .run(
                    id,
                    runId,
                    call.model,
                    call.prompt.system,
                    call.prompt.user,
                    call.response,
                    call.inputTokens,
                    call.outputTokens,
                    call.costUsd,
                    call.durationMs,
                );
            return id;
        });
    }
}

interface DecisionRow {
    id: string;
    run_id: string;
    llm_call_id: string;
    trade_date: string;
    ticker: string;
    action: string;
    target_weight: number;
    confidence: number;
    stop_loss_pct: number;
    take_profit_pct: number;
    horizon_days: number;
    reasoning: string;
    created_at: string;
}

const toDecision = (row: DecisionRow): DecisionRecord => ({
    id: row.id,
    runId: row.run_id,
    llmCallId: row.llm_call_id,
    tradeDate: row.trade_date as TradingDate,
    ticker: row.ticker as Ticker,
    action: row.action as Decision["action"],
    targetWeight: row.target_weight,
    confidence: row.confidence as Decision["confidence"],
    stopLossPct: row.stop_loss_pct,
    takeProfitPct: row.take_profit_pct,
    horizonDays: row.horizon_days,
    reasoning: row.reasoning,
    createdAt: fromIso(row.created_at),
});

export class SqliteDecisionsRepository implements DecisionsRepository {
    constructor(private readonly db: Db) {}

    saveMany(records: readonly DecisionRecord[]): Promise<void> {
        return promised(() => {
            const insert = this.db.prepare(
                `INSERT INTO decisions (id, run_id, llm_call_id, trade_date, ticker, action, target_weight, confidence,
                    stop_loss_pct, take_profit_pct, horizon_days, reasoning, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            );
            this.db.transaction(() => {
                for (const d of records) {
                    insert.run(
                        d.id,
                        d.runId,
                        d.llmCallId,
                        d.tradeDate,
                        d.ticker,
                        d.action,
                        d.targetWeight,
                        d.confidence,
                        d.stopLossPct,
                        d.takeProfitPct,
                        d.horizonDays,
                        d.reasoning,
                        toIso(d.createdAt),
                    );
                }
            })();
        });
    }

    latestForTicker(ticker: Ticker): Promise<DecisionRecord | undefined> {
        return promised(() => {
            const row = this.db
                .prepare("SELECT * FROM decisions WHERE ticker = ? ORDER BY created_at DESC, id DESC LIMIT 1")
                .get(ticker) as DecisionRow | undefined;
            return row && toDecision(row);
        });
    }

    recent(limit: number): Promise<DecisionRecord[]> {
        return promised(() =>
            (
                this.db
                    .prepare("SELECT * FROM decisions ORDER BY created_at DESC, id DESC LIMIT ?")
                    .all(limit) as DecisionRow[]
            ).map(toDecision),
        );
    }
}
