import type { Logger } from "./logger.js";

export type ShutdownStep = readonly [name: string, run: () => Promise<void> | void];

/**
 * Runs the shutdown steps in order. A failing step is logged and the rest still run, so the run flag is cleared
 * even when stopping Telegram fails. Steps that take longer than `limitMs` end the process with code 1; keep the
 * limit under Docker's `stop_grace_period`, so the log says why instead of the process being killed silently.
 */
export async function shutDown(
    steps: readonly ShutdownStep[],
    options: { logger: Logger; limitMs: number; exit: (code: number) => void },
): Promise<void> {
    const { logger, limitMs, exit } = options;
    const timer = setTimeout(() => {
        logger.error({ limitMs }, "shutdown took too long; exiting");
        exit(1);
    }, limitMs);
    for (const [name, run] of steps) {
        try {
            await run();
        } catch (error) {
            logger.error({ err: error, step: name }, "shutdown step failed");
        }
    }
    clearTimeout(timer);
    exit(0);
}
