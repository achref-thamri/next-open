import { readFileSync } from "node:fs";
import type { z } from "zod";
import { envSchema, settingsSchema, type RiskLimits, type TaxRates, type UniverseLimits } from "./schema.js";

export type { RiskLimits, TaxRates, UniverseLimits } from "./schema.js";

export type TradingMode = "paper" | "live";
export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace";

export interface Config {
    mode: TradingMode;
    alpaca: { keyId: string; secretKey: string };
    fmp: { apiKey: string };
    anthropic: { apiKey: string; model: string };
    telegram: { botToken: string; ownerChatId: number };
    databasePath: string;
    backupDir: string;
    /** External dead man's switch (e.g. healthchecks.io), pinged while the scheduler runs. */
    healthcheckPingUrl: string | undefined;
    logLevel: LogLevel;
    benchmarkSymbol: string;
    risk: RiskLimits;
    universe: UniverseLimits;
    tax: TaxRates;
}

export class ConfigError extends Error {
    override name = "ConfigError";
}

/** Validates raw env vars and settings into a typed config. Throws ConfigError listing every problem. */
export function parseConfig(env: Record<string, string | undefined>, settings: unknown = {}): Config {
    const envResult = envSchema.safeParse(env);
    const settingsResult = settingsSchema.safeParse(settings);
    if (!envResult.success || !settingsResult.success) {
        const problems = [...formatIssues(envResult.error, "env"), ...formatIssues(settingsResult.error, "settings")];
        throw new ConfigError(`Invalid configuration:\n${problems.join("\n")}`);
    }

    const e = envResult.data;
    const live = e.TRADING_MODE === "live";
    // Presence of the mode's Alpaca keys is guaranteed by envSchema's refinement.
    const keyId = live ? e.ALPACA_LIVE_KEY_ID : e.ALPACA_PAPER_KEY_ID;
    const secretKey = live ? e.ALPACA_LIVE_SECRET_KEY : e.ALPACA_PAPER_SECRET_KEY;
    if (keyId === undefined || secretKey === undefined) throw new ConfigError("Alpaca keys missing");

    return {
        mode: e.TRADING_MODE,
        alpaca: { keyId, secretKey },
        fmp: { apiKey: e.FMP_API_KEY },
        anthropic: { apiKey: e.ANTHROPIC_API_KEY, model: e.ANTHROPIC_MODEL },
        telegram: { botToken: e.TELEGRAM_BOT_TOKEN, ownerChatId: e.TELEGRAM_OWNER_CHAT_ID },
        databasePath: e.DATABASE_PATH,
        backupDir: e.BACKUP_DIR,
        healthcheckPingUrl: e.HEALTHCHECK_PING_URL,
        logLevel: e.LOG_LEVEL,
        ...settingsResult.data,
    };
}

function formatIssues(error: z.ZodError | undefined, source: string): string[] {
    return (error?.issues ?? []).map((issue) => `  - ${source} ${issue.path.join(".") || "(root)"}: ${issue.message}`);
}

let cached: Config | undefined;

/** Loads config once from process.env and the optional JSON file at CONFIG_PATH. */
export function loadConfig(): Config {
    if (cached) return cached;
    const path = process.env.CONFIG_PATH;
    let settings: unknown = {};
    if (path) {
        try {
            settings = JSON.parse(readFileSync(path, "utf8"));
        } catch (error) {
            throw new ConfigError(`Cannot read settings file ${path}: ${(error as Error).message}`);
        }
    }
    cached = parseConfig(process.env, settings);
    return cached;
}
