import * as zod from "zod";

const emptyToUndefined = (value: unknown): unknown => (value === "" ? undefined : value);

const requiredSecret = zod.preprocess(
    emptyToUndefined,
    zod.string({ error: "is required" }).trim().min(1, "is required"),
);
const optionalSecret = zod.preprocess(emptyToUndefined, zod.string().trim().min(1).optional());
const fraction = zod.number().gt(0).lte(1);

/** Secrets and deployment settings, read from environment variables. */
export const envSchema = zod
    .object({
        TRADING_MODE: zod.preprocess(emptyToUndefined, zod.enum(["paper", "live"]).default("paper")),
        ALPACA_PAPER_KEY_ID: optionalSecret,
        ALPACA_PAPER_SECRET_KEY: optionalSecret,
        ALPACA_LIVE_KEY_ID: optionalSecret,
        ALPACA_LIVE_SECRET_KEY: optionalSecret,
        FMP_API_KEY: requiredSecret,
        FINNHUB_API_KEY: requiredSecret,
        ANTHROPIC_API_KEY: requiredSecret,
        ANTHROPIC_MODEL: zod.preprocess(emptyToUndefined, zod.string().trim().min(1).default("claude-sonnet-5-5")),
        TELEGRAM_TOKEN: requiredSecret,
        TELEGRAM_OWNER_CHAT_ID: zod.preprocess(
            emptyToUndefined,
            zod.coerce.number({ error: "is required and must be an integer chat id" }).int(),
        ),
        DATABASE_PATH: zod.preprocess(emptyToUndefined, zod.string().min(1).default("data/next-open.db")),
        BACKUP_DIR: zod.preprocess(emptyToUndefined, zod.string().min(1).default("data/backups")),
        HEALTHCHECK_PING_URL: zod.preprocess(emptyToUndefined, zod.url({ protocol: /^https$/ }).optional()),
        LOG_LEVEL: zod.preprocess(
            emptyToUndefined,
            zod.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
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

/**
 * Hard risk limits, see docs/architecture.md#risk-checks. Weights are fractions of equity. The defaults suit a small
 * account (about $3,000): five positions, so a whole share of most liquid stocks fits in one.
 */
export const riskSchema = zod
    .strictObject({
        maxPositionWeight: fraction.default(0.2),
        maxPositions: zod.int().positive().default(5),
        /** Most of equity one buy may lose at its stop-loss: position value times the stop distance. */
        maxRiskPerTradePct: fraction.default(0.02),
        minCashWeight: zod.number().min(0).lt(1).default(0.1),
        dailyLossStopPct: fraction.default(0.03),
        maxOrdersPerDay: zod.int().positive().default(10),
        /** 0.4 lets one full position be swapped for another (a 20% sell and a 20% buy) in a day. */
        maxDailyTradedWeight: fraction.default(0.4),
        /** Max limit price above (buys) or below (sells) the previous close. */
        maxEntryGapPct: zod.number().min(0).max(0.1).default(0.01),
        /**
         * Cash in the account that Next Open leaves alone, e.g. to start live with part of the money. It is taken off
         * equity, cash and the previous close everywhere, so sizing, limits, reports and the benchmark see only the
         * money being traded.
         */
        reservedCashUsd: zod.number().min(0).default(0),
    })
    .refine((risk) => risk.maxPositionWeight <= 1 - risk.minCashWeight, {
        message: "maxPositionWeight cannot exceed 1 - minCashWeight",
        path: ["maxPositionWeight"],
    });

/** Candidate filters for the weekly liquid list and the evening shortlist. */
export const universeSchema = zod.strictObject({
    minPriceUsd: zod.number().positive().default(5),
    minMarketCapUsd: zod.number().positive().default(2_000_000_000),
    minAvgDollarVolumeUsd: zod.number().positive().default(20_000_000),
    avgVolumeDays: zod.int().min(5).max(60).default(20),
    maxCandidates: zod.int().positive().max(100).default(40),
});

/** Estimated Danish tax (see core/tax.ts). Check rates and threshold on skat.dk every January. */
export const taxSchema = zod.strictObject({
    shareLowRate: fraction.default(0.27),
    shareHighRate: fraction.default(0.42),
    /** Yearly aktieindkomst amount taxed at the low rate, for one person. */
    shareThresholdDkk: zod.number().positive().default(79_400),
    /**
     * Benchmark ETF taxed yearly on unrealised gains. VT is not on SKAT's positive list (Vanguard has no listed
     * funds), so its gains are kapitalindkomst: the top marginal rate is assumed.
     */
    benchmarkRate: fraction.default(0.42),
    /** DKK per USD, used to convert the threshold. An estimate; update it when the rate drifts. */
    usdDkkRate: zod.number().positive().default(6.5),
});

/** Tunable settings, from an optional JSON file. Every field has a default. */
export const settingsSchema = zod.strictObject({
    benchmarkSymbol: zod.string().trim().min(1).default("VT"),
    risk: riskSchema.prefault({}),
    universe: universeSchema.prefault({}),
    tax: taxSchema.prefault({}),
});

export type RiskLimits = zod.output<typeof riskSchema>;
export type UniverseLimits = zod.output<typeof universeSchema>;
export type TaxRates = zod.output<typeof taxSchema>;
