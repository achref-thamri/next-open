import { newId } from "../lib/ids.js";
import type { TradingDate } from "../core/types.js";
import type { RunType } from "../ports/repositories.js";
import type { AppDeps } from "./deps.js";

export type JobResult = { status: "succeeded" | "skipped"; message?: string } | { status: "failed"; message: string };

/** Returned by a job body to finish its run as skipped instead of succeeded. */
export function skip(message: string): JobResult {
    return { status: "skipped", message };
}

/**
 * Runs a job body inside a run record. Any error marks the run failed and alerts the owner; it is never
 * rethrown, so a scheduler keeps running. Alerting failures are logged, not raised.
 */
export async function runJob(
    deps: Pick<AppDeps, "repos" | "clock" | "notifier" | "logger">,
    type: RunType,
    tradeDate: TradingDate,
    body: (runId: string) => Promise<JobResult | undefined>,
): Promise<JobResult> {
    const { repos, clock, notifier, logger } = deps;
    const runId = newId();
    const log = logger.child({ job: type, runId, tradeDate });
    await repos.runs.start({ id: runId, type, tradeDate, startedAt: clock.now() });
    log.info("job started");

    let result: JobResult;
    try {
        result = (await body(runId)) ?? { status: "succeeded" };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error({ err: error }, "job failed");
        result = { status: "failed", message };
        try {
            await notifier.send(`⚠️ ${type} failed for ${tradeDate}: ${message}\nNo trades were made from this run.`);
        } catch (alertError) {
            log.error({ err: alertError }, "failed to send the failure alert");
        }
    }

    await repos.runs.finish(runId, {
        status: result.status,
        finishedAt: clock.now(),
        ...(result.message === undefined ? {} : { error: result.message }),
    });
    log.info({ status: result.status, message: result.message }, "job finished");
    return result;
}
