import type { Db } from "./db.js";

/**
 * Trading history, children before parents. Runs, AI calls, candidates, settings, profiles, the liquid list and API
 * usage stay: they say nothing about the account's size, and the profiles take days of FMP budget to rebuild.
 */
const HISTORY_TABLES = [
    "fills",
    "orders",
    "proposals",
    "decisions",
    "equity_snapshots",
    "shadow_fills",
    "shadow_orders",
    "shadow_snapshots",
    "shadow_portfolios",
] as const;

/** Deletes the paper trading history in one transaction and returns the rows deleted per table. */
export function resetPaperHistory(db: Db): Record<string, number> {
    const deleted: Record<string, number> = {};
    db.transaction(() => {
        for (const table of HISTORY_TABLES) deleted[table] = db.prepare(`DELETE FROM ${table}`).run().changes;
    })();
    return deleted;
}
