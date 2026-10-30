import type { TradingDate } from "../../../core/types.js";
import type { RunRecord, RunStatus, RunsRepository, RunType } from "../../../ports/repositories.js";
import type { Db } from "../db.js";
import { promised, bool, fromIso, optionalIso, orUndefined, toIso } from "./util.js";

interface Row {
    id: string;
    type: string;
    trade_date: string;
    started_at: string;
    finished_at: string | null;
    status: string;
    error: string | null;
    explained: number;
}

const toRecord = (row: Row): RunRecord => ({
    id: row.id,
    type: row.type as RunType,
    tradeDate: row.trade_date as TradingDate,
    startedAt: fromIso(row.started_at),
    finishedAt: optionalIso(row.finished_at),
    status: row.status as RunStatus,
    error: orUndefined(row.error),
    explained: bool(row.explained),
});

export class SqliteRunsRepository implements RunsRepository {
    constructor(private readonly db: Db) {}

    start(run: Pick<RunRecord, "id" | "type" | "tradeDate" | "startedAt">): Promise<void> {
        return promised(() => {
            this.db
                .prepare("INSERT INTO runs (id, type, trade_date, started_at, status) VALUES (?, ?, ?, ?, 'running')")
                .run(run.id, run.type, run.tradeDate, toIso(run.startedAt));
        });
    }

    finish(
        id: string,
        result: { status: Exclude<RunStatus, "running">; finishedAt: Date; error?: string },
    ): Promise<void> {
        return promised(() => {
            const { changes } = this.db
                .prepare("UPDATE runs SET status = ?, finished_at = ?, error = ? WHERE id = ?")
                .run(result.status, toIso(result.finishedAt), result.error ?? null, id);
            if (changes === 0) throw new Error(`Run not found: ${id}`);
        });
    }

    get(id: string): Promise<RunRecord | undefined> {
        return promised(() => {
            const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Row | undefined;
            return row && toRecord(row);
        });
    }

    latest(type: RunType, tradeDate: TradingDate): Promise<RunRecord | undefined> {
        return promised(() => {
            const row = this.db
                .prepare(
                    "SELECT * FROM runs WHERE type = ? AND trade_date = ? ORDER BY started_at DESC, id DESC LIMIT 1",
                )
                .get(type, tradeDate) as Row | undefined;
            return row && toRecord(row);
        });
    }

    lastUnexplainedFailure(): Promise<RunRecord | undefined> {
        return promised(() => {
            const row = this.db
                .prepare(
                    "SELECT * FROM runs WHERE status = 'failed' AND explained = 0 ORDER BY started_at DESC LIMIT 1",
                )
                .get() as Row | undefined;
            return row && toRecord(row);
        });
    }

    markExplained(id: string): Promise<void> {
        return promised(() => {
            this.db.prepare("UPDATE runs SET explained = 1 WHERE id = ?").run(id);
        });
    }
}
