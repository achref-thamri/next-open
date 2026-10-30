import Anthropic from "@anthropic-ai/sdk";
import { Bot } from "grammy";
import { AlpacaBroker } from "./adapters/alpaca/broker.js";
import { AlpacaClient } from "./adapters/alpaca/client.js";
import { AlpacaMarketData, AlpacaNews } from "./adapters/alpaca/marketData.js";
import { AnthropicLlm } from "./adapters/anthropic/llm.js";
import { FmpFundamentals } from "./adapters/fmp/fundamentals.js";
import { openDatabase, type Db } from "./adapters/sqlite/db.js";
import { migrate } from "./adapters/sqlite/migrate.js";
import { createSqliteRepositories } from "./adapters/sqlite/repositories/index.js";
import { registerHandlers, TelegramNotifier } from "./adapters/telegram/bot.js";
import { buildLiquidList } from "./app/buildLiquidList.js";
import { handleCommand } from "./app/commands.js";
import type { AppDeps } from "./app/deps.js";
import { executeAtOpen } from "./app/executeAtOpen.js";
import { approveAll, handleApproval, remindPending } from "./app/handleApproval.js";
import { recordEndOfDay, sendWeeklyReport } from "./app/recordEndOfDay.js";
import { runEveningAnalysis } from "./app/runEveningAnalysis.js";
import type { Config } from "./config/index.js";
import { toTradingDate } from "./core/types.js";
import type { Logger } from "./lib/logger.js";
import type { Clock } from "./ports/clock.js";
import { dailySchedule, Scheduler } from "./scheduler/index.js";

export interface App {
    deps: AppDeps;
    bot: Bot;
    scheduler: Scheduler;
    db: Db;
}

const systemClock: Clock = { now: () => new Date() };

/** Builds every adapter and use case from config. Nothing talks to the network until the app is started. */
export function composeApp(config: Config, logger: Logger, clock: Clock = systemClock): App {
    const db = openDatabase(config.databasePath);
    migrate(db);
    const repos = createSqliteRepositories(db);

    const alpaca = new AlpacaClient({ ...config.alpaca, mode: config.mode, logger });
    const bot = new Bot(config.telegram.botToken);
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
        notifier: new TelegramNotifier(bot, config.telegram.ownerChatId),
        clock,
        repos,
        logger,
    };

    registerHandlers(
        bot,
        config.telegram.ownerChatId,
        {
            onCommand: (chatId, text) => handleCommand(deps, { chatId, text }),
            onDecision: (chatId, proposalId, action) => handleApproval(deps, { chatId, proposalId, action }),
            onApproveAll: (chatId, tradeDate) => approveAll(deps, { chatId, tradeDate: toTradingDate(tradeDate) }),
        },
        logger,
    );

    const scheduler = new Scheduler(
        { broker: deps.broker, clock, runs: repos.runs, notifier: deps.notifier, logger },
        dailySchedule({
            liquidList: () => buildLiquidList(deps),
            approvalReminder: () => remindPending(deps),
            executeAtOpen: () => executeAtOpen(deps),
            endOfDay: () => recordEndOfDay(deps),
            eveningAnalysis: () => runEveningAnalysis(deps),
            weeklyReport: () => sendWeeklyReport(deps),
        }),
    );

    return { deps, bot, scheduler, db };
}
