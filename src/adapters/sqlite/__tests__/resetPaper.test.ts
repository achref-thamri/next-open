import { describe, expect, it } from "vitest";
import { openDatabase } from "../db.js";
import { migrate } from "../migrate.js";
import { resetPaperHistory } from "../resetPaper.js";

describe("resetPaperHistory", () => {
    it("deletes the trading history and the benchmark and keeps other settings", () => {
        const db = openDatabase(":memory:");
        migrate(db);
        db.prepare("INSERT INTO settings (key, value) VALUES ('halted', 'false')").run();
        db.prepare("INSERT INTO settings (key, value) VALUES ('benchmark', '{\"startValue\":10000000}')").run();
        db.prepare(
            "INSERT INTO equity_snapshots (date, equity, cash, benchmark_value) VALUES ('2026-11-02', 10000000, 10000000, 10000000)",
        ).run();

        const deleted = resetPaperHistory(db);

        expect(deleted.equity_snapshots).toBe(1);
        expect(db.prepare("SELECT count(*) AS n FROM equity_snapshots").get()).toEqual({ n: 0 });
        expect(db.prepare("SELECT value FROM settings WHERE key = 'halted'").get()).toEqual({ value: "false" });
        expect(db.prepare("SELECT value FROM settings WHERE key = 'benchmark'").get()).toBeUndefined();
    });
});
