import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../adapters/sqlite/db.js";
import { migrate } from "../adapters/sqlite/migrate.js";
import { createSqliteRepositories } from "../adapters/sqlite/repositories/index.js";
import { toTicker, toTradingDate } from "../core/types.js";
import { copyUniverseCache } from "../dryRun.js";

describe("copyUniverseCache", () => {
    const dirs: string[] = [];
    afterEach(() => {
        for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    it("copies profiles, liquid lists and API usage into a fresh database", async () => {
        const dir = mkdtempSync(join(tmpdir(), "dry-run-"));
        dirs.push(dir);
        const path = join(dir, "cache.db");
        const cache = openDatabase(path);
        migrate(cache);
        const cacheRepos = createSqliteRepositories(cache);
        await cacheRepos.profiles.save({
            ticker: toTicker("AAA"),
            name: "AAA",
            kind: "common_stock",
            marketCapUsd: 5e9,
            fetchedAt: new Date("2026-11-01T00:00:00Z"),
        });
        await cacheRepos.liquidLists.save({
            date: toTradingDate("2026-11-01"),
            tickers: [toTicker("AAA")],
            complete: true,
        });
        await cacheRepos.apiUsage.increment("fmp", "2026-11-01", 7);
        cache.close();

        const fresh = openDatabase(":memory:");
        migrate(fresh);
        copyUniverseCache(path, fresh);

        const repos = createSqliteRepositories(fresh);
        expect((await repos.profiles.get(toTicker("AAA")))?.marketCapUsd).toBe(5e9);
        expect((await repos.liquidLists.latestComplete())?.tickers).toEqual(["AAA"]);
        expect(await repos.apiUsage.get("fmp", "2026-11-01")).toBe(7);
        expect(await repos.proposals.list({})).toEqual([]);
    });
});
