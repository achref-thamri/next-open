import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import { shutDown } from "../shutdown.js";

const logger = pino({ level: "silent" });

describe("shutDown", () => {
    it("runs every step in order even when one fails, then exits 0", async () => {
        const ran: string[] = [];
        const exit = vi.fn();

        await shutDown(
            [
                ["telegram", () => Promise.reject(new Error("network down"))],
                ["scheduler", () => void ran.push("scheduler")],
                ["mark stopped", () => void ran.push("mark stopped")],
            ],
            { logger, limitMs: 1_000, exit },
        );

        expect(ran).toEqual(["scheduler", "mark stopped"]);
        expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    });

    it("exits 1 when a step hangs past the limit", async () => {
        const exit = vi.fn();

        void shutDown([["scheduler", () => new Promise<void>(() => undefined)]], { logger, limitMs: 5, exit });

        await vi.waitFor(() => {
            expect(exit).toHaveBeenCalledExactlyOnceWith(1);
        });
    });
});
