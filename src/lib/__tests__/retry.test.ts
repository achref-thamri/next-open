import { describe, expect, it, vi } from "vitest";
import { PermanentError, TransientError } from "../errors.js";
import { retry } from "../retry.js";

function failingTimes(times: number, makeError: () => Error = () => new TransientError("boom")) {
    let calls = 0;
    return vi.fn(() => {
        calls++;
        return calls <= times ? Promise.reject(makeError()) : Promise.resolve("ok");
    });
}

describe("retry", () => {
    const sleep = vi.fn(() => Promise.resolve());
    const options = { sleep, random: () => 1 };

    it("returns the first success without sleeping", async () => {
        const sleepSpy = vi.fn(() => Promise.resolve());

        await expect(retry(failingTimes(0), { sleep: sleepSpy })).resolves.toBe("ok");
        expect(sleepSpy).not.toHaveBeenCalled();
    });

    it("retries transient errors with exponential backoff", async () => {
        const fn = failingTimes(3);
        const delays: number[] = [];

        await expect(
            retry(fn, { ...options, attempts: 4, baseDelayMs: 100, onRetry: (_, __, ms) => delays.push(ms) }),
        ).resolves.toBe("ok");
        expect(fn).toHaveBeenCalledTimes(4);
        expect(delays).toEqual([100, 200, 400]);
    });

    it("caps the delay at maxDelayMs", async () => {
        const delays: number[] = [];

        await retry(failingTimes(4), {
            ...options,
            attempts: 5,
            baseDelayMs: 100,
            maxDelayMs: 250,
            onRetry: (_, __, ms) => delays.push(ms),
        });
        expect(delays).toEqual([100, 200, 250, 250]);
    });

    it("applies jitter", async () => {
        const delays: number[] = [];

        await retry(failingTimes(1), {
            sleep,
            random: () => 0.5,
            baseDelayMs: 100,
            onRetry: (_, __, ms) => delays.push(ms),
        });
        expect(delays).toEqual([50]);
    });

    it("waits at least the server's retry-after", async () => {
        const delays: number[] = [];

        await retry(
            failingTimes(1, () => new TransientError("429", 5_000)),
            { ...options, baseDelayMs: 100, onRetry: (_, __, ms) => delays.push(ms) },
        );
        expect(delays).toEqual([5_000]);
    });

    it("gives up after the last attempt and throws the last error", async () => {
        const fn = failingTimes(10);

        await expect(retry(fn, { ...options, attempts: 3 })).rejects.toBeInstanceOf(TransientError);
        expect(fn).toHaveBeenCalledTimes(3);
    });

    it("does not retry permanent errors", async () => {
        const fn = failingTimes(1, () => new PermanentError("bad request"));

        await expect(retry(fn, options)).rejects.toBeInstanceOf(PermanentError);
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it("does not retry unknown errors (bugs)", async () => {
        const fn = failingTimes(1, () => new TypeError("undefined is not a function"));

        await expect(retry(fn, options)).rejects.toBeInstanceOf(TypeError);
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it("passes the attempt number", async () => {
        const seen: number[] = [];

        await retry((attempt) => {
            seen.push(attempt);
            return attempt < 2 ? Promise.reject(new TransientError("x")) : Promise.resolve();
        }, options);
        expect(seen).toEqual([1, 2]);
    });
});
