import type { Config } from "../config/index.js";
import type { Logger } from "../lib/logger.js";
import type { Broker } from "../ports/broker.js";
import type { Clock } from "../ports/clock.js";
import type { Fundamentals } from "../ports/fundamentals.js";
import type { Llm } from "../ports/llm.js";
import type { MarketData } from "../ports/marketData.js";
import type { News } from "../ports/news.js";
import type { Notifier } from "../ports/notifier.js";
import type { Repositories } from "../ports/repositories.js";

export type AppConfig = Pick<Config, "mode" | "benchmarkSymbol" | "risk" | "universe" | "tax"> & {
    /** The only Telegram chat allowed to approve trades and run commands. */
    ownerChatId: number;
};

/** Everything a use case may depend on. Each use case is a plain function of these. */
export interface AppDeps {
    config: AppConfig;
    broker: Broker;
    marketData: MarketData;
    news: News;
    fundamentals: Fundamentals;
    llm: Llm;
    notifier: Notifier;
    clock: Clock;
    repos: Repositories;
    logger: Logger;
}
