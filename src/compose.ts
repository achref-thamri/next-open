import Anthropic from "@anthropic-ai/sdk";
import { Bot as TelegramClient } from "grammy";
import { AlpacaBroker } from "./adapters/alpaca/broker.js";
import { AlpacaClient } from "./adapters/alpaca/client.js";
import { AlpacaMarketData, AlpacaNews } from "./adapters/alpaca/marketData.js";
import { AnthropicLlm } from "./adapters/anthropic/llm.js";
import { FmpFundamentals } from "./adapters/fmp/fundamentals.js";
import { backupDatabase, pruneBackups } from "./adapters/sqlite/backup.js";
import { openDatabase, type Db } from "./adapters/sqlite/db.js";
import { migrate } from "./adapters/sqlite/migrate.js";
import { createSqliteRepositories } from "./adapters/sqlite/repositories/index.js";
import { registerHandlers, TelegramNotifier } from "./adapters/telegram/messenger.js";
import { buildLiquidList } from "./app/buildLiquidList.js";
import { handleCommand } from "./app/commands.js";
import type { AppDeps } from "./app/deps.js";
import { executeAtOpen } from "./app/executeAtOpen.js";
import { approveAll, handleApproval, remindPending } from "./app/handleApproval.js";
import { recordEndOfDay, sendWeeklyReport } from "./app/recordEndOfDay.js";
import { runJob } from "./app/runJob.js";
import { runEveningAnalysis } from "./app/runEveningAnalysis.js";
import type { Config } from "./config/index.js";
import { toTradingDate, tradingDateOf } from "./core/types.js";
import type { Logger } from "./lib/logger.js";
import type { Clock } from "./ports/clock.js";
import { dailySchedule, Scheduler } from "./scheduler/index.js";

export interface App {
    deps: AppDeps;
    telegram: TelegramClient;
    scheduler: Scheduler;
    db: Db;
}

/** Nightly backups kept on the data volume (spec §14). */
const BACKUP_RETENTION_DAYS = 14;

const systemClock: Clock = { now: () => new Date() };

/** Builds every adapter and use case from config. Nothing talks to the network until the app is started. */
export function composeApp(
    config: Config,
    logger: Logger,
    options: { clock?: Clock; onTick?: (now: Date) => void } = {},
): App {
    const clock = options.clock ?? systemClock;
    const db = openDatabase(config.databasePath);
    migrate(db);
    const repos = createSqliteRepositories(db);

    const alpaca = new AlpacaClient({ ...config.alpaca, mode: config.mode, logger });
    const telegram = new TelegramClient(config.telegram.token);
    const deps: AppDeps = {
        config: {
            mode: config.mode,
            benchmarkSymbol: config.benchmarkSymbol,
            risk: config.risk,
            universe: config.universe,
            tax: config.tax,
            ownerChatId: config.telegram.ownerChatId,
        },
        broker: new AlpacaBroker(alpaca, logger),
        marketData: new AlpacaMarketData(alpaca, () => clock.now()),
        news: new AlpacaNews(alpaca),
        fundamentals: new FmpFundamentals({
            apiKey: config.fmp.apiKey,
            profiles: repos.profiles,
            usage: repos.apiUsage,
            clock,
            logger,
        }),
        llm: new AnthropicLlm({
            client: new Anthropic({ apiKey: config.anthropic.apiKey }),
            model: config.anthropic.model,
            logger,
        }),
        notifier: new TelegramNotifier(telegram, config.telegram.ownerChatId),
        clock,
        repos,
        logger,
    };

    registerHandlers(
        telegram,
        config.telegram.ownerChatId,
        {
            onCommand: (chatId, text) => handleCommand(deps, { chatId, text }),
            onDecision: (chatId, proposalId, action) => handleApproval(deps, { chatId, proposalId, action }),
            onApproveAll: (chatId, tradeDate) => approveAll(deps, { chatId, tradeDate: toTradingDate(tradeDate) }),
        },
        logger,
    );

    const scheduler = new Scheduler(
        {
            broker: deps.broker,
            clock,
            runs: repos.runs,
            notifier: deps.notifier,
            logger,
            ...(options.onTick ? { onTick: options.onTick } : {}),
        },
        dailySchedule({
            liquidList: () => buildLiquidList(deps),
            approvalReminder: () => remindPending(deps),
            executeAtOpen: () => executeAtOpen(deps),
            endOfDay: () => recordEndOfDay(deps),
            eveningAnalysis: () => runEveningAnalysis(deps),
            weeklyReport: () => sendWeeklyReport(deps),
            backup: () => {
                const today = tradingDateOf(clock.now());
                return runJob(deps, "backup", today, async () => {
                    const path = await backupDatabase(db, config.backupDir, today);
                    const deleted = pruneBackups(config.backupDir, today, BACKUP_RETENTION_DAYS);
                    return { status: "succeeded", message: `${path}; deleted ${deleted.length} old backups` };
                });
            },
        }),
    );

    return { deps, telegram, scheduler, db };
}
