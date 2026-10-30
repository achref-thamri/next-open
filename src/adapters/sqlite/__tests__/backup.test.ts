import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { backupDatabase, pruneBackups } from "../backup.js";
import { openDatabase } from "../db.js";
import { migrate } from "../migrate.js";

describe("backups", () => {
    const dirs: string[] = [];
    const tempDir = () => {
        const dir = mkdtempSync(join(tmpdir(), "backup-"));
        dirs.push(dir);
        return dir;
    };
    afterEach(() => {
        for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    it("produces a readable copy of the live database", async () => {
        const dir = tempDir();
        const db = openDatabase(join(dir, "live.db"));
        migrate(db);
        db.prepare("INSERT INTO settings (key, value) VALUES ('halted', 'true')").run();

        const path = await backupDatabase(db, join(dir, "backups"), "2026-11-02");

        expect(path).toBe(join(dir, "backups", "trading-bot-2026-11-02.db"));
        const copy = openDatabase(path);
        expect(copy.prepare("SELECT value FROM settings WHERE key = 'halted'").get()).toEqual({ value: "true" });
        expect(copy.pragma("integrity_check", { simple: true })).toBe("ok");
        copy.close();
        db.close();
    });

    it("deletes only backups older than the retention period", () => {
        const dir = tempDir();
        for (const name of [
            "trading-bot-2026-10-18.db",
            "trading-bot-2026-10-19.db",
            "trading-bot-2026-11-01.db",
            "trading-bot.db",
            "notes.txt",
            "trading-bot-2026-10-01.db-wal",
        ]) {
            writeFileSync(join(dir, name), "");
        }

        expect(pruneBackups(dir, "2026-11-02", 14)).toEqual(["trading-bot-2026-10-18.db"]);
        expect(readdirSync(dir).sort()).toEqual([
            "notes.txt",
            "trading-bot-2026-10-01.db-wal",
            "trading-bot-2026-10-19.db",
            "trading-bot-2026-11-01.db",
            "trading-bot.db",
        ]);
        expect(existsSync(join(dir, "trading-bot-2026-10-19.db"))).toBe(true);
    });
});
