import type { AppDeps } from "./deps.js";

/** A crash loop restarts the container every minute or so; one alert per hour is enough. */
const CRASH_ALERT_EVERY_MS = 60 * 60_000;

type LifecycleDeps = Pick<AppDeps, "repos" | "notifier" | "clock" | "logger" | "config">;

/**
 * Called at startup. Planned restarts (deploys, reboots) stop the process with SIGTERM, which clears the running
 * flag, so they stay silent. A flag still set means the previous run died without a clean shutdown: the owner is
 * told, at most once an hour.
 */
export async function markStarted(deps: LifecycleDeps): Promise<void> {
    const { repos, notifier, clock, logger, config } = deps;
    const previous = await repos.settings.get();
    const now = clock.now();
    await repos.settings.update({ running: true });
    if (!previous.running) {
        logger.info("started after a clean shutdown");
        return;
    }
    logger.warn("previous run ended without a clean shutdown");
    const lastAlert = previous.crashAlertedAt ? new Date(previous.crashAlertedAt).getTime() : -Infinity;
    if (now.getTime() - lastAlert < CRASH_ALERT_EVERY_MS) return;
    await repos.settings.update({ crashAlertedAt: now.toISOString() });
    await notifier.send(
        `⚠️ Next Open restarted unexpectedly (${config.mode} mode). The previous run ended without a clean ` +
            "shutdown; check the server logs.",
    );
}

/** Called on SIGTERM/SIGINT, after jobs have finished, so the next start is recognised as planned. */
export async function markStopped(deps: Pick<AppDeps, "repos">): Promise<void> {
    await deps.repos.settings.update({ running: false });
}
