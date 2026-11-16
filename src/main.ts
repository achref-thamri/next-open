import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { setCommandMenu } from "./adapters/telegram/messenger.js";
import { COMMANDS } from "./app/commands.js";
import { markStarted, markStopped } from "./app/lifecycle.js";
import { composeApp } from "./compose.js";
import { loadConfig } from "./config/index.js";
import { HEARTBEAT_PATH } from "./healthcheck.js";
import { keepPolling } from "./lib/keepPolling.js";
import { createLogger } from "./lib/logger.js";
import { createPinger } from "./lib/ping.js";
import { shutDown } from "./lib/shutdown.js";

/** Under docker-compose.yml's 2-minute stop_grace_period, so a stuck shutdown is logged before Docker kills it. */
const SHUTDOWN_LIMIT_MS = 100_000;

/** Starts Next Open: checks the account, then runs the scheduler and Telegram until stopped. */
async function main(): Promise<void> {
    const config = loadConfig();
    const logger = createLogger(config.logLevel);
    mkdirSync(dirname(HEARTBEAT_PATH), { recursive: true });
    const ping = config.healthcheckPingUrl ? createPinger({ url: config.healthcheckPingUrl, logger }) : undefined;
    const app = composeApp(config, logger, {
        onTick: (now) => {
            writeFileSync(HEARTBEAT_PATH, now.toISOString());
            // Without Telegram nobody can approve orders, so let the dead man's switch fire.
            if (polling.isUp()) ping?.(now);
        },
    });
    logger.info({ mode: config.mode, model: config.anthropic.model }, "starting Next Open");
    await markStarted(app.deps);

    // Refuse to run at all if the account could use margin or short selling.
    await app.deps.broker.verifyAccountSafety();

    let stopping = false;
    const shutdown = async (signal: string) => {
        if (stopping) return;
        stopping = true;
        logger.info({ signal }, "shutting down");
        await shutDown(
            [
                [
                    "telegram",
                    () => {
                        polling.stop();
                        return app.telegram.stop();
                    },
                ],
                ["scheduler", () => app.scheduler.stop()],
                ["mark stopped", () => markStopped(app.deps)],
                ["database", () => void app.db.close()],
            ],
            {
                logger,
                limitMs: SHUTDOWN_LIMIT_MS,
                exit: (code) => {
                    logger.info({ code }, "stopped");
                    process.exit(code);
                },
            },
        );
    };
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));

    // Started before the scheduler, whose first tick reads `polling` for the ping.
    const polling = keepPolling({
        start: () =>
            app.telegram.start({
                drop_pending_updates: true,
                onStart: (info) => {
                    logger.info({ account: info.username }, "telegram started");
                },
            }),
        logger,
        notify: (text) => app.deps.notifier.send(text),
    });
    app.scheduler.start();
    // A menu that fails to load is not worth stopping for; the commands still work when typed.
    setCommandMenu(app.telegram, config.telegram.ownerChatId, COMMANDS).catch((error: unknown) => {
        logger.warn({ err: error }, "telegram command menu not set");
    });
}

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
