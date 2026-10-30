import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./db.js";

const FILE = /^trading-bot-(\d{4}-\d{2}-\d{2})\.db$/;
const DAY_MS = 86_400_000;

/** Copies the live database with SQLite's online backup API (safe while the bot runs) to `<dir>/trading-bot-<date>.db`. */
export async function backupDatabase(db: Db, dir: string, date: string): Promise<string> {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `trading-bot-${date}.db`);
    await db.backup(path);
    return path;
}

/** Deletes backups (only files this module wrote) dated more than `keepDays` before `today`. Returns what was deleted. */
export function pruneBackups(dir: string, today: string, keepDays: number): string[] {
    const cutoff = Date.parse(today) - keepDays * DAY_MS;
    const deleted: string[] = [];
    for (const name of readdirSync(dir)) {
        const date = FILE.exec(name)?.[1];
        if (date === undefined || Date.parse(date) >= cutoff) continue;
        rmSync(join(dir, name));
        deleted.push(name);
    }
    return deleted.sort();
}
