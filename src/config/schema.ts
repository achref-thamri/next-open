import { z } from "zod";

const emptyToUndefined = (value: unknown): unknown => (value === "" ? undefined : value);

const requiredSecret = z.preprocess(emptyToUndefined, z.string({ error: "is required" }).trim().min(1, "is required"));
const optionalSecret = z.preprocess(emptyToUndefined, z.string().trim().min(1).optional());
const fraction = z.number().gt(0).lte(1);

/** Secrets and deployment settings, read from environment variables. */
export const envSchema = z
    .object({
        TRADING_MODE: z.preprocess(emptyToUndefined, z.enum(["paper", "live"]).default("paper")),
        ALPACA_PAPER_KEY_ID: optionalSecret,
        ALPACA_PAPER_SECRET_KEY: optionalSecret,
        ALPACA_LIVE_KEY_ID: optionalSecret,
        ALPACA_LIVE_SECRET_KEY: optionalSecret,
        FMP_API_KEY: requiredSecret,
        ANTHROPIC_API_KEY: requiredSecret,
        ANTHROPIC_MODEL: z.preprocess(emptyToUndefined, z.string().trim().min(1).default("claude-sonnet-5-5")),
        TELEGRAM_TOKEN: requiredSecret,
        TELEGRAM_OWNER_CHAT_ID: z.preprocess(
            emptyToUndefined,
            z.coerce.number({ error: "is required and must be an integer chat id" }).int(),
        ),
        DATABASE_PATH: z.preprocess(emptyToUndefined, z.string().min(1).default("data/next-open.db")),
        BACKUP_DIR: z.preprocess(emptyToUndefined, z.string().min(1).default("data/backups")),
        HEALTHCHECK_PING_URL: z.preprocess(emptyToUndefined, z.url({ protocol: /^https$/ }).optional()),
        LOG_LEVEL: z.preprocess(
            emptyToUndefined,
            z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
        ),
    })
    .superRefine((env, ctx) => {
        const prefix = env.TRADING_MODE === "live" ? "ALPACA_LIVE" : "ALPACA_PAPER";
        for (const key of [`${prefix}_KEY_ID`, `${prefix}_SECRET_KEY`] as const) {
            if (env[key] === undefined) {
                ctx.addIssue({
                    code: "custom",
                    path: [key],
                    message: `is required when TRADING_MODE=${env.TRADING_MODE}`,
                });
            }
        }
    });

/** Hard risk limits (spec §7). Weights are fractions of equity. */
export const riskSchema = z
    .strictObject({
        maxPositionWeight: fraction.default(0.1),
        maxPositions: z.int().positive().default(15),
        minCashWeight: z.number().min(0).lt(1).default(0.1),
        dailyLossStopPct: fraction.default(0.03),
        maxOrdersPerDay: z.int().positive().default(10),
        maxDailyTradedWeight: fraction.default(0.3),
        /** Max limit price above (buys) or below (sells) the previous close. */
        maxEntryGapPct: z.number().min(0).max(0.1).default(0.01),
    })
    .refine((risk) => risk.maxPositionWeight <= 1 - risk.minCashWeight, {
        message: "maxPositionWeight cannot exceed 1 - minCashWeight",
        path: ["maxPositionWeight"],
    });

/** Candidate filters (spec §5). */
export const universeSchema = z.strictObject({
    minPriceUsd: z.number().positive().default(5),
    minMarketCapUsd: z.number().positive().default(2_000_000_000),
    minAvgDollarVolumeUsd: z.number().positive().default(20_000_000),
    avgVolumeDays: z.int().min(5).max(60).default(20),
    maxCandidates: z.int().positive().max(100).default(40),
});

/** Estimated Danish tax (spec §12). Check rates and threshold on skat.dk every January. */
export const taxSchema = z.strictObject({
    shareLowRate: fraction.default(0.27),
    shareHighRate: fraction.default(0.42),
    /** Yearly aktieindkomst amount taxed at the low rate, for one person. */
    shareThresholdDkk: z.number().positive().default(79_400),
    /**
     * Benchmark ETF taxed yearly on unrealised gains. VT is not on SKAT's positive list (Vanguard has no listed
     * funds), so its gains are kapitalindkomst: the top marginal rate is assumed.
     */
    benchmarkRate: fraction.default(0.42),
    /** DKK per USD, used to convert the threshold. An estimate; update it when the rate drifts. */
    usdDkkRate: z.number().positive().default(6.5),
});

/** Tunable settings, from an optional JSON file. Every field has a default. */
export const settingsSchema = z.strictObject({
    benchmarkSymbol: z.string().trim().min(1).default("VT"),
    risk: riskSchema.prefault({}),
    universe: universeSchema.prefault({}),
    tax: taxSchema.prefault({}),
});

export type Env = z.output<typeof envSchema>;
export type Settings = z.output<typeof settingsSchema>;
export type RiskLimits = z.output<typeof riskSchema>;
export type UniverseLimits = z.output<typeof universeSchema>;
export type TaxRates = z.output<typeof taxSchema>;
