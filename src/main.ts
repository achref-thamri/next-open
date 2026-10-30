import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { composeApp } from "./compose.js";
import { loadConfig } from "./config/index.js";
import { HEARTBEAT_PATH } from "./healthcheck.js";
import { createLogger } from "./lib/logger.js";

/** Starts the bot: checks the account, then runs the scheduler and the Telegram bot until stopped. */
async function main(): Promise<void> {
    const config = loadConfig();
    const logger = createLogger(config.logLevel);
    mkdirSync(dirname(HEARTBEAT_PATH), { recursive: true });
    const app = composeApp(config, logger, {
        onTick: (now) => {
            writeFileSync(HEARTBEAT_PATH, now.toISOString());
        },
    });
    logger.info({ mode: config.mode, model: config.anthropic.model }, "starting trading bot");

    // Refuse to run at all if the account could use margin or short selling.
    await app.deps.broker.verifyAccountSafety();

    let stopping = false;
    const shutdown = async (signal: string) => {
        if (stopping) return;
        stopping = true;
        logger.info({ signal }, "shutting down");
        await app.bot.stop();
        await app.scheduler.stop();
        app.db.close();
        logger.info("stopped");
        process.exit(0);
    };
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));

    app.scheduler.start();
    void app.bot.start({
        drop_pending_updates: true,
        onStart: (info) => {
            logger.info({ bot: info.username }, "telegram bot started");
        },
    });
    await app.deps.notifier.send(`🤖 Trading bot started (${config.mode} mode).`);
}

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
