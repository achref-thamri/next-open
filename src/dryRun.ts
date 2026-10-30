import { pino } from "pino";
import { FakeBroker } from "./adapters/fake/broker.js";
import { FakeClock } from "./adapters/fake/clock.js";
import { openDatabase, type Db } from "./adapters/sqlite/db.js";
import { migrate } from "./adapters/sqlite/migrate.js";
import { createSqliteRepositories } from "./adapters/sqlite/repositories/index.js";
import { buildLiquidList, weekOf } from "./app/buildLiquidList.js";
import { addDays } from "./app/calendar.js";
import type { AppDeps } from "./app/deps.js";
import { runEveningAnalysis } from "./app/runEveningAnalysis.js";
import { composeApp } from "./compose.js";
import { loadConfig } from "./config/index.js";
import { cents, formatCents } from "./core/money.js";
import { newYorkInstant, toTicker, toTradingDate, tradingDateOf, type TradingDate } from "./core/types.js";
import type { Notifier } from "./ports/notifier.js";

const CACHE_PATH = process.env.DRY_RUN_CACHE_PATH ?? "data/dry-run-cache.db";
const STARTING_CASH = cents(10_000_000);
/** Large, liquid US common stocks across sectors, for `--quick`. */
const QUICK_TICKERS = [
    "AAPL",
    "MSFT",
    "NVDA",
    "AMZN",
    "GOOGL",
    "META",
    "AVGO",
    "TSLA",
    "JPM",
    "V",
    "UNH",
    "XOM",
    "LLY",
    "JNJ",
    "PG",
    "MA",
    "HD",
    "COST",
    "ABBV",
    "BAC",
    "KO",
    "PEP",
    "CRM",
    "AMD",
    "NFLX",
    "CAT",
    "GE",
    "DIS",
    "INTC",
    "WMT",
].map(toTicker);

function print(text: string): Promise<void> {
    console.log(`\n${text}`);
    return Promise.resolve();
}

/** Prints messages instead of sending them to Telegram. */
const consoleNotifier: Notifier = { send: print, sendProposal: print, sendApproveAll: print };

/** Copies the FMP profile cache and liquid lists into a fresh database, so dry runs never touch real data. */
export function copyUniverseCache(from: string, into: Db): void {
    into.prepare("ATTACH DATABASE ? AS cache").run(from);
    into.exec(`
        INSERT INTO profiles SELECT * FROM cache.profiles;
        INSERT INTO liquid_lists SELECT * FROM cache.liquid_lists;
        INSERT INTO api_usage SELECT * FROM cache.api_usage;
    `);
    into.exec("DETACH DATABASE cache");
}

/**
 * One evening analysis with real market data, news and Claude, but a fake $100,000 broker and no Telegram.
 * Usage: npm run dry-run [-- [--quick] [YYYY-MM-DD]]   (default date: the latest trading day that has closed)
 *
 * The first run builds the liquid list in a separate cache database (data/dry-run-cache.db). That takes a few
 * days within FMP's free budget; rerun daily until it reports the list complete. `--quick` skips the list and
 * uses a fixed set of large, liquid stocks instead, for a same-day end-to-end check.
 */
async function dryRun(): Promise<void> {
    const config = loadConfig();
    const logger = pino({ level: process.env.LOG_LEVEL ?? "warn" });

    // Real adapters on the cache database: used to build the list and to read the calendar.
    const real = composeApp({ ...config, databasePath: CACHE_PATH }, logger);
    const cacheDeps: AppDeps = { ...real.deps, notifier: consoleNotifier };
    const args = process.argv.slice(2);
    const quick = args.includes("--quick");
    const dateArg = args.find((a) => !a.startsWith("--"));
    const asOf = dateArg ? toTradingDate(dateArg) : await latestClosedDay(cacheDeps);

    if (quick) {
        console.log(`Quick mode: ${QUICK_TICKERS.length} large stocks instead of the weekly list.`);
        for (const ticker of QUICK_TICKERS) await real.deps.fundamentals.getProfile(ticker);
    } else if (!(await real.deps.repos.liquidLists.latestComplete())) {
        console.log("Building the liquid list (uses FMP's daily budget)…");
        const result = await buildLiquidList(cacheDeps);
        console.log(`Liquid list: ${result.status}${result.message ? ` — ${result.message}` : ""}`);
        if (result.status !== "succeeded") return;
    }

    // The analysis runs on an in-memory copy with a fake broker, at 16:30 New York on `asOf`.
    const db = openDatabase(":memory:");
    migrate(db);
    copyUniverseCache(CACHE_PATH, db);
    const clock = new FakeClock(newYorkInstant(asOf, "16:30"));
    const broker = new FakeBroker({ clock, cash: STARTING_CASH });
    broker.calendar.push(...(await real.deps.broker.getCalendar(addDays(asOf, -7), addDays(asOf, 14))));
    const deps: AppDeps = {
        ...real.deps,
        broker,
        clock,
        notifier: consoleNotifier,
        repos: createSqliteRepositories(db),
        config: { ...real.deps.config, mode: "paper" },
    };
    if (quick) await deps.repos.liquidLists.save({ date: weekOf(asOf), tickers: QUICK_TICKERS, complete: true });

    console.log(
        `Dry run for the close of ${asOf} with ${formatCents(STARTING_CASH)} of fake cash, model ${config.anthropic.model}…`,
    );
    const result = await runEveningAnalysis(deps);
    console.log(`\nRun ${result.status}${result.message ? `: ${result.message}` : ""}`);

    const call = db.prepare("SELECT model, input_tokens, output_tokens, cost_usd FROM llm_calls").get() as
        { model: string; input_tokens: number; output_tokens: number; cost_usd: number } | undefined;
    if (call) {
        console.log(
            `\nClaude: ${call.model}, ${call.input_tokens} input + ${call.output_tokens} output tokens, $${call.cost_usd.toFixed(4)}`,
        );
    }
    db.close();
    await real.scheduler.stop();
    real.db.close();
}

/** The latest trading day whose session (and SIP delay) is over. */
async function latestClosedDay(deps: AppDeps): Promise<TradingDate> {
    const now = deps.clock.now();
    const today = tradingDateOf(now);
    const days = await deps.broker.getCalendar(addDays(today, -10), today);
    const closed = days.filter((d) => d.close.getTime() + 20 * 60_000 <= now.getTime());
    const last = closed.at(-1);
    if (!last) throw new Error("No closed trading day in the last 10 days");
    return last.date;
}

if (import.meta.url === `file://${process.argv[1] ?? ""}`) {
    dryRun().catch((error: unknown) => {
        console.error(error);
        process.exit(1);
    });
}
