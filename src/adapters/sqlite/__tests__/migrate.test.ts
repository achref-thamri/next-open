import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../db.js";
import { migrate } from "../migrate.js";
import { MIGRATIONS } from "../migrations/index.js";

const version = (db: Db) => db.pragma("user_version", { simple: true });
const tables = (db: Db) =>
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map(
        (t) => t.name,
    );

describe("migrate", () => {
    const dirs: string[] = [];
    afterEach(() => {
        for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    it("migrates a fresh database to the latest version", () => {
        const db = openDatabase(":memory:");

        expect(migrate(db)).toEqual(MIGRATIONS.map((m) => m.version));
        expect(version(db)).toBe(MIGRATIONS.length);
        expect(tables(db)).toEqual([
            "api_usage",
            "candidates",
            "decisions",
            "equity_snapshots",
            "fills",
            "liquid_lists",
            "llm_calls",
            "orders",
            "profiles",
            "proposals",
            "runs",
            "settings",
            "shadow_fills",
            "shadow_orders",
            "shadow_portfolios",
            "shadow_snapshots",
        ]);
    });

    it("is a no-op when already up to date", () => {
        const db = openDatabase(":memory:");
        migrate(db);

        expect(migrate(db)).toEqual([]);
        expect(version(db)).toBe(MIGRATIONS.length);
    });

    it("applies only pending migrations", () => {
        const db = openDatabase(":memory:");
        const first = { version: 1, name: "one", sql: "CREATE TABLE a (x INTEGER) STRICT;" };
        migrate(db, [first]);

        expect(migrate(db, [first, { version: 2, name: "two", sql: "CREATE TABLE b (x INTEGER) STRICT;" }])).toEqual([
            2,
        ]);
        expect(tables(db)).toEqual(["a", "b"]);
    });

    it("rolls back a failing migration and keeps the previous version", () => {
        const db = openDatabase(":memory:");
        const good = { version: 1, name: "good", sql: "CREATE TABLE a (x INTEGER) STRICT;" };
        const bad = { version: 2, name: "bad", sql: "CREATE TABLE b (x INTEGER) STRICT; INSERT INTO nope VALUES (1);" };

        expect(() => migrate(db, [good, bad])).toThrow(/no such table: nope/);
        expect(version(db)).toBe(1);
        expect(tables(db)).toEqual(["a"]);
    });

    it("refuses a database newer than the code", () => {
        const db = openDatabase(":memory:");
        db.pragma("user_version = 99");

        expect(() => migrate(db)).toThrow(/newer than this build/);
    });

    it("refuses gaps in migration versions", () => {
        expect(() => migrate(openDatabase(":memory:"), [{ version: 2, name: "x", sql: "" }])).toThrow(/expected 1/);
    });

    it("opens file databases in WAL mode with foreign keys on", () => {
        const dir = mkdtempSync(join(tmpdir(), "trading-bot-"));
        dirs.push(dir);
        const db = openDatabase(join(dir, "nested", "bot.db"));

        expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
        expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
        db.close();
    });
});
