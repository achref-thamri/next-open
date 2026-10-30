import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export type Db = Database.Database;

/** Opens the database with WAL journaling (file databases), foreign keys and a busy timeout. */
export function openDatabase(path: string): Db {
    const inMemory = path === ":memory:";
    if (!inMemory) mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path);
    if (!inMemory) db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    return db;
}
