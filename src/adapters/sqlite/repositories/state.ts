import type { Cents } from "../../../core/money.js";
import type { EquitySnapshot, SecurityKind, Ticker, TradingDate } from "../../../core/types.js";
import type {
    ApiUsageRepository,
    AppSettings,
    CachedProfile,
    EquitySnapshotsRepository,
    LiquidList,
    LiquidListsRepository,
    ProfilesRepository,
    SettingsRepository,
} from "../../../ports/repositories.js";
import type { Db } from "../db.js";
import { bool, fromIso, orUndefined, placeholders, promised, toIso } from "./util.js";

interface SnapshotRow {
    date: string;
    equity: number;
    cash: number;
    benchmark_value: number;
}

const toSnapshot = (row: SnapshotRow): EquitySnapshot => ({
    date: row.date as TradingDate,
    equity: row.equity as Cents,
    cash: row.cash as Cents,
    benchmarkValue: row.benchmark_value as Cents,
});

export class SqliteEquitySnapshotsRepository implements EquitySnapshotsRepository {
    constructor(private readonly db: Db) {}

    save(snapshot: EquitySnapshot): Promise<void> {
        return promised(() => {
            this.db
                .prepare(
                    `INSERT INTO equity_snapshots (date, equity, cash, benchmark_value) VALUES (?, ?, ?, ?)
                     ON CONFLICT (date) DO UPDATE SET equity = excluded.equity, cash = excluded.cash,
                        benchmark_value = excluded.benchmark_value`,
                )
                .run(snapshot.date, snapshot.equity, snapshot.cash, snapshot.benchmarkValue);
        });
    }

    list(): Promise<EquitySnapshot[]> {
        return promised(() =>
            (this.db.prepare("SELECT * FROM equity_snapshots ORDER BY date").all() as SnapshotRow[]).map(toSnapshot),
        );
    }

    latest(): Promise<EquitySnapshot | undefined> {
        return promised(() => {
            const row = this.db.prepare("SELECT * FROM equity_snapshots ORDER BY date DESC LIMIT 1").get() as
                SnapshotRow | undefined;
            return row && toSnapshot(row);
        });
    }
}

export const DEFAULT_SETTINGS: AppSettings = {
    halted: false,
    haltReason: undefined,
    liveConfirmed: false,
    benchmark: undefined,
    running: false,
    crashAlertedAt: undefined,
};

/** Settings as one JSON value per key; unknown keys are ignored, missing keys take defaults. */
export class SqliteSettingsRepository implements SettingsRepository {
    constructor(private readonly db: Db) {}

    get(): Promise<AppSettings> {
        return promised(() => this.read());
    }

    update(patch: Partial<AppSettings>): Promise<AppSettings> {
        return promised(() => {
            const upsert = this.db.prepare(
                "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            );
            this.db.transaction(() => {
                for (const [key, value] of Object.entries(patch)) {
                    if (key in DEFAULT_SETTINGS) upsert.run(key, JSON.stringify(value ?? null));
                }
            })();
            return this.read();
        });
    }

    private read(): AppSettings {
        const rows = this.db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
        const settings: Record<string, unknown> = { ...DEFAULT_SETTINGS };
        for (const { key, value } of rows) {
            if (key in DEFAULT_SETTINGS) settings[key] = JSON.parse(value) ?? undefined;
        }
        return settings as unknown as AppSettings;
    }
}

interface ProfileRow {
    ticker: string;
    name: string;
    kind: string;
    market_cap_usd: number | null;
    fetched_at: string;
}

const toProfile = (row: ProfileRow): CachedProfile => ({
    ticker: row.ticker as Ticker,
    name: row.name,
    kind: row.kind as SecurityKind,
    marketCapUsd: orUndefined(row.market_cap_usd),
    fetchedAt: fromIso(row.fetched_at),
});

export class SqliteProfilesRepository implements ProfilesRepository {
    constructor(private readonly db: Db) {}

    get(ticker: Ticker): Promise<CachedProfile | undefined> {
        return promised(() => {
            const row = this.db.prepare("SELECT * FROM profiles WHERE ticker = ?").get(ticker) as
                ProfileRow | undefined;
            return row && toProfile(row);
        });
    }

    getMany(tickers: readonly Ticker[]): Promise<Map<Ticker, CachedProfile>> {
        return promised(() => {
            const result = new Map<Ticker, CachedProfile>();
            // Stay well under SQLite's bound-parameter limit.
            for (let i = 0; i < tickers.length; i += 500) {
                const chunk = tickers.slice(i, i + 500);
                const rows = this.db
                    .prepare(`SELECT * FROM profiles WHERE ticker IN (${placeholders(chunk.length)})`)
                    .all(...chunk) as ProfileRow[];
                for (const row of rows) result.set(row.ticker as Ticker, toProfile(row));
            }
            return result;
        });
    }

    save(profile: CachedProfile): Promise<void> {
        return promised(() => {
            this.db
                .prepare(
                    `INSERT INTO profiles (ticker, name, kind, market_cap_usd, fetched_at) VALUES (?, ?, ?, ?, ?)
                     ON CONFLICT (ticker) DO UPDATE SET name = excluded.name, kind = excluded.kind,
                        market_cap_usd = excluded.market_cap_usd, fetched_at = excluded.fetched_at`,
                )
                .run(
                    profile.ticker,
                    profile.name,
                    profile.kind,
                    profile.marketCapUsd ?? null,
                    toIso(profile.fetchedAt),
                );
        });
    }
}

interface LiquidListRow {
    date: string;
    tickers: string;
    complete: number;
}

const toLiquidList = (row: LiquidListRow): LiquidList => ({
    date: row.date as TradingDate,
    tickers: JSON.parse(row.tickers) as Ticker[],
    complete: bool(row.complete),
});

export class SqliteLiquidListsRepository implements LiquidListsRepository {
    constructor(private readonly db: Db) {}

    save(list: LiquidList): Promise<void> {
        return promised(() => {
            this.db
                .prepare(
                    `INSERT INTO liquid_lists (date, tickers, complete) VALUES (?, ?, ?)
                     ON CONFLICT (date) DO UPDATE SET tickers = excluded.tickers, complete = excluded.complete`,
                )
                .run(list.date, JSON.stringify(list.tickers), Number(list.complete));
        });
    }

    latest(): Promise<LiquidList | undefined> {
        return promised(() => {
            const row = this.db.prepare("SELECT * FROM liquid_lists ORDER BY date DESC LIMIT 1").get() as
                LiquidListRow | undefined;
            return row && toLiquidList(row);
        });
    }

    latestComplete(): Promise<LiquidList | undefined> {
        return promised(() => {
            const row = this.db
                .prepare("SELECT * FROM liquid_lists WHERE complete = 1 ORDER BY date DESC LIMIT 1")
                .get() as LiquidListRow | undefined;
            return row && toLiquidList(row);
        });
    }
}

export class SqliteApiUsageRepository implements ApiUsageRepository {
    constructor(private readonly db: Db) {}

    increment(api: string, day: string, by = 1): Promise<number> {
        return promised(() => {
            const row = this.db
                .prepare(
                    `INSERT INTO api_usage (api, day, count) VALUES (?, ?, ?)
                     ON CONFLICT (api, day) DO UPDATE SET count = count + excluded.count RETURNING count`,
                )
                .get(api, day, by) as { count: number };
            return row.count;
        });
    }

    get(api: string, day: string): Promise<number> {
        return promised(() => {
            const row = this.db.prepare("SELECT count FROM api_usage WHERE api = ? AND day = ?").get(api, day) as
                { count: number } | undefined;
            return row?.count ?? 0;
        });
    }
}
