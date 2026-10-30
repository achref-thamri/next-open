import { TransientError } from "./errors.js";

export interface RetryOptions {
    /** Total attempts including the first. */
    attempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
    /** Returns [0, 1); injectable for deterministic tests. */
    random?: () => number;
    onRetry?: (error: TransientError, attempt: number, delayMs: number) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn`, retrying only on TransientError with exponential backoff and full jitter.
 * Any other error, or the last transient one, is thrown as is.
 */
export async function retry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
    const {
        attempts = 4,
        baseDelayMs = 500,
        maxDelayMs = 30_000,
        sleep = defaultSleep,
        random = Math.random,
        onRetry,
    } = options;

    for (let attempt = 1; ; attempt++) {
        try {
            return await fn(attempt);
        } catch (error) {
            if (!(error instanceof TransientError) || attempt >= attempts) throw error;
            const backoff = random() * Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
            const delayMs = Math.round(Math.max(backoff, error.retryAfterMs ?? 0));
            onRetry?.(error, attempt, delayMs);
            await sleep(delayMs);
        }
    }
}
