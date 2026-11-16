import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import { keepPolling } from "../keepPolling.js";

const logger = pino({ level: "silent" });

describe("keepPolling", () => {
    it("retries failed polling, reports down meanwhile, and alerts once per outage", async () => {
        let calls = 0;
        let release: () => void = () => undefined;
        const start = vi.fn(() => {
            calls++;
            if (calls <= 2) return Promise.reject(new Error("409: Conflict"));
            return new Promise<void>((resolve) => (release = resolve));
        });
        const notify = vi.fn(() => Promise.resolve());
        const polling = keepPolling({ start, logger, notify, retryMs: 5 });

        await vi.waitFor(() => {
            expect(start).toHaveBeenCalledTimes(3);
        });
        expect(polling.isUp()).toBe(true);
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify).toHaveBeenCalledWith(expect.stringContaining("409: Conflict"));

        polling.stop();
        release();
        await polling.done;
        expect(start).toHaveBeenCalledTimes(3);
    });

    it("is down while waiting to retry, and stop ends the wait", async () => {
        const start = vi.fn(() => Promise.reject(new Error("401: Unauthorized")));
        // A failing alert (the token itself is bad) must not break the loop.
        const notify = vi.fn(() => Promise.reject(new Error("401")));
        const polling = keepPolling({ start, logger, notify, retryMs: 60_000 });

        await vi.waitFor(() => {
            expect(polling.isUp()).toBe(false);
        });
        polling.stop();
        await polling.done;
        expect(start).toHaveBeenCalledTimes(1);
    });
});
