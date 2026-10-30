import { pino } from "pino";
import {
    FakeBroker,
    FakeClock,
    FakeFundamentals,
    FakeLlm,
    FakeMarketData,
    FakeNews,
    FakeNotifier,
} from "../../adapters/fake/index.js";
import { openDatabase } from "../../adapters/sqlite/db.js";
import { migrate } from "../../adapters/sqlite/migrate.js";
import { createSqliteRepositories } from "../../adapters/sqlite/repositories/index.js";
import { riskSchema, taxSchema, universeSchema } from "../../config/schema.js";
import { cents } from "../../core/money.js";
import { toTicker, toTradingDate, type DailyBar, type Ticker, type TradingDate } from "../../core/types.js";
import type { LlmDecisionOutput, RawDecision } from "../../ports/llm.js";
import type { AppConfig, AppDeps } from "../deps.js";

export interface Harness extends AppDeps {
    broker: FakeBroker;
    marketData: FakeMarketData;
    news: FakeNews;
    fundamentals: FakeFundamentals;
    llm: FakeLlm;
    notifier: FakeNotifier;
    clock: FakeClock;
}

/** Monday 2026-11-02, 16:30 New York (EST). */
export const EVENING = "2026-11-02T21:30:00Z";
export const ASOF = toTradingDate("2026-11-02");
export const NEXT = toTradingDate("2026-11-03");

/** Fakes for every port, in-memory SQLite, $100,000 paper account, a weekday calendar around ASOF. */
export function harness(overrides: Partial<AppConfig> = {}, now = EVENING): Harness {
    const db = openDatabase(":memory:");
    migrate(db);
    const clock = new FakeClock(now);
    const broker = new FakeBroker({ clock, cash: cents(10_000_000) });
    broker.calendar.push(
        ...weekdays(toTradingDate("2026-10-01"), toTradingDate("2026-12-31")).map((date) => ({
            date,
            open: new Date(`${date}T14:30:00Z`),
            close: new Date(`${date}T21:00:00Z`),
        })),
    );
    return {
        config: {
            mode: "paper",
            benchmarkSymbol: "VT",
            risk: riskSchema.parse({}),
            universe: universeSchema.parse({}),
            tax: taxSchema.parse({}),
            ...overrides,
        },
        broker,
        marketData: new FakeMarketData(),
        news: new FakeNews(),
        fundamentals: new FakeFundamentals(),
        llm: new FakeLlm(),
        notifier: new FakeNotifier(),
        clock,
        repos: createSqliteRepositories(db),
        logger: pino({ level: "silent" }),
    };
}

/** Weekdays in the inclusive range (no holidays). */
export function weekdays(from: TradingDate, to: TradingDate): TradingDate[] {
    const days: TradingDate[] = [];
    for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
        if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) days.push(toTradingDate(d.toISOString().slice(0, 10)));
    }
    return days;
}

/**
 * Seeds 90 weekdays of bars ending on `until`: a flat price with steady volume, and a last day that moves by
 * `lastMove` on `lastVolumeMultiple` times the usual volume.
 */
export function seedStock(
    h: Harness,
    symbol: string,
    options: {
        price?: number;
        volume?: number;
        lastMove?: number;
        lastVolumeMultiple?: number;
        marketCapUsd?: number;
        until?: TradingDate;
    } = {},
): Ticker {
    const {
        price = 100,
        volume = 1_000_000,
        lastMove = 0,
        lastVolumeMultiple = 1,
        marketCapUsd = 10e9,
        until = ASOF,
    } = options;
    const ticker = toTicker(symbol);
    const days = weekdays(toTradingDate("2026-06-01"), until).slice(-90);
    const bars: DailyBar[] = days.map((date, i) => {
        const last = i === days.length - 1;
        const close = cents(Math.round(price * 100 * (last ? 1 + lastMove : 1)));
        return {
            date,
            open: close,
            high: close,
            low: close,
            close,
            volume: last ? volume * lastVolumeMultiple : volume,
        };
    });
    h.marketData.bars.set(ticker, bars);
    h.marketData.assets.push({ ticker, exchange: "NYSE", name: `${symbol} Inc.` });
    h.fundamentals.profiles.set(ticker, { ticker, name: `${symbol} Inc.`, kind: "common_stock", marketCapUsd });
    const lastClose = bars.at(-1)?.close ?? cents(price * 100);
    h.broker.setPrice(ticker, lastClose);
    return ticker;
}

/** Copies the fake fundamentals into the profile cache and stores a complete liquid list. */
export async function seedLiquidList(h: Harness, symbols: string[]): Promise<void> {
    for (const symbol of symbols) {
        const profile = h.fundamentals.profiles.get(toTicker(symbol));
        if (profile) await h.repos.profiles.save({ ...profile, fetchedAt: new Date(EVENING) });
    }
    await h.repos.liquidLists.save({
        date: toTradingDate("2026-11-01"),
        tickers: symbols.map(toTicker),
        complete: true,
    });
}

export function decision(ticker: string, overrides: Partial<RawDecision> = {}): RawDecision {
    return {
        ticker,
        action: "buy",
        targetWeight: 0.08,
        confidence: 4,
        stopLossPct: 0.08,
        takeProfitPct: 0.2,
        horizonDays: 10,
        reasoning: `Reason for ${ticker}.`,
        ...overrides,
    };
}

export function llmOutput(...decisions: RawDecision[]): LlmDecisionOutput {
    return { decisions, marketView: "Calm market." };
}
