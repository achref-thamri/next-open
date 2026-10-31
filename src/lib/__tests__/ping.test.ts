import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import { createPinger } from "../ping.js";

const URL = "https://hc-ping.com/secret-uuid";
const at = (minutes: number) => new Date(Date.UTC(2026, 10, 2, 12, minutes));
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createPinger", () => {
    it("pings at most once per interval", async () => {
        const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(new Response("OK")));
        const ping = createPinger({ url: URL, logger: pino({ level: "silent" }), fetch, everyMs: 5 * 60_000 });

        for (const minute of [0, 1, 2, 3, 4]) {
            ping(at(minute));
            await flush();
        }
        ping(at(5));
        await flush();

        expect(fetch).toHaveBeenCalledTimes(2);
        expect(fetch.mock.calls[0]?.[0]).toBe(URL);
    });

    it("does not stack pings while one is still in flight", () => {
        const fetch = vi.fn(() => new Promise<Response>(() => undefined));
        const ping = createPinger({ url: URL, logger: pino({ level: "silent" }), fetch, everyMs: 60_000 });

        ping(at(0));
        ping(at(10));

        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("logs failures without the secret URL and never throws", async () => {
        const lines: string[] = [];
        const logger = pino({ level: "warn" }, { write: (line: string) => lines.push(line) });
        const ping = createPinger({
            url: URL,
            logger,
            fetch: vi.fn(() => Promise.reject(new TypeError("fetch failed"))),
        });

        expect(() => {
            ping(at(0));
        }).not.toThrow();
        await flush();

        expect(lines.join("")).toContain("healthcheck ping failed");
        expect(lines.join("")).not.toContain("secret-uuid");
    });

    it("logs a refused ping", async () => {
        const lines: string[] = [];
        const logger = pino({ level: "warn" }, { write: (line: string) => lines.push(line) });
        const ping = createPinger({
            url: URL,
            logger,
            fetch: vi.fn(() => Promise.resolve(new Response("not found", { status: 404 }))),
        });

        ping(at(0));
        await flush();

        expect(lines.join("")).toContain('"status":404');
    });
});
