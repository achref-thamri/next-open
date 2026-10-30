import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isHealthy } from "../healthcheck.js";

describe("isHealthy", () => {
    const dirs: string[] = [];
    afterEach(() => {
        for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    it("is healthy only with a recent heartbeat", () => {
        const dir = mkdtempSync(join(tmpdir(), "health-"));
        dirs.push(dir);
        const path = join(dir, "heartbeat");
        writeFileSync(path, "x");
        const touched = new Date("2026-11-02T15:00:00Z");
        utimesSync(path, touched, touched);

        expect(isHealthy(path, touched.getTime() + 60_000)).toBe(true);
        expect(isHealthy(path, touched.getTime() + 4 * 60_000)).toBe(false);
        expect(isHealthy(join(dir, "missing"))).toBe(false);
    });
});
