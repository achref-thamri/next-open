import { setTimeout as sleep } from "node:timers/promises";
import type { Logger } from "./logger.js";

const RETRY_MS = 5 * 60_000;

export interface Polling {
    /** False from the moment polling fails until the next attempt starts. */
    isUp(): boolean;
    /** Ends the retries; call before stopping Telegram, so its clean return is not retried. */
    stop(): void;
    /** Settles once polling has stopped for good. Never rejects. */
    done: Promise<void>;
}

/**
 * Runs Telegram long polling and starts it again when it fails (revoked token, a second poller, a network outage
 * grammY gives up on). Without this the rejection would be unhandled and Node would exit, possibly mid-job. While it
 * is down `isUp` is false, which holds back the dead man's switch ping: nobody could approve orders. The owner gets
 * one message per outage, which arrives only when the failure is not the token itself.
 */
export function keepPolling(options: {
    start: () => Promise<void>;
    logger: Logger;
    notify: (text: string) => Promise<void>;
    retryMs?: number;
}): Polling {
    const retryMs = options.retryMs ?? RETRY_MS;
    const stopping = new AbortController();
    let up = true;

    async function run(): Promise<void> {
        let alerted = false;
        while (!stopping.signal.aborted) {
            up = true;
            try {
                // Resolves only when polling is stopped on purpose.
                await options.start();
                return;
            } catch (error) {
                up = false;
                const message = error instanceof Error ? error.message : String(error);
                options.logger.error({ err: error, retryInMs: retryMs }, "telegram polling stopped");
                if (!alerted) {
                    alerted = true;
                    await options
                        .notify(`⚠️ Telegram polling stopped: ${message}. Retrying every ${retryMs / 60_000} minutes.`)
                        .catch(() => undefined);
                }
            }
            await sleep(retryMs, undefined, { signal: stopping.signal }).catch(() => undefined);
        }
    }

    return {
        isUp: () => up,
        stop: () => {
            stopping.abort();
        },
        done: run(),
    };
}
