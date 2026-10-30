import { pino } from "pino";
import { FakeBroker } from "./adapters/fake/broker.js";
import { FakeClock } from "./adapters/fake/clock.js";
import { openDatabase, type Db } from "./adapters/sqlite/db.js";
import { migrate } from "./adapters/sqlite/migrate.js";
import { createSqliteRepositories } from "./adapters/sqlite/repositories/index.js";
import { buildLiquidList } from "./app/buildLiquidList.js";
import { addDays } from "./app/calendar.js";
import type { AppDeps } from "./app/deps.js";
import { proposalText } from "./app/messages.js";
import { runEveningAnalysis } from "./app/runEveningAnalysis.js";
import { composeApp } from "./compose.js";
import { loadConfig } from "./config/index.js";
import { cents } from "./core/money.js";
import { newYorkInstant, toTradingDate, tradingDateOf, type TradingDate } from "./core/types.js";
import type { Notifier } from "./ports/notifier.js";

const CACHE_PATH = process.env.DRY_RUN_CACHE_PATH ?? "data/dry-run-cache.db";
const STARTING_CASH = cents(10_000_000);

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
 * Usage: npm run dry-run [-- YYYY-MM-DD]   (default: the latest trading day that has closed)
 *
 * The first run builds the liquid list in a separate cache database (data/dry-run-cache.db). That takes a few
 * days within FMP's free budget; rerun daily until it reports the list complete.
 */
async function dryRun(): Promise<void> {
    const config = loadConfig();
    const logger = pino({ level: process.env.LOG_LEVEL ?? "warn" });

    // Real adapters on the cache database: used to build the list and to read the calendar.
    const real = composeApp({ ...config, databasePath: CACHE_PATH }, logger);
    const cacheDeps: AppDeps = { ...real.deps, notifier: consoleNotifier };
    const asOf = process.argv[2] ? toTradingDate(process.argv[2]) : await latestClosedDay(cacheDeps);

    if (!(await real.deps.repos.liquidLists.latestComplete())) {
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

    console.log(
        `Dry run for the close of ${asOf} with $${STARTING_CASH / 100} of fake cash, model ${config.anthropic.model}…`,
    );
    const result = await runEveningAnalysis(deps);
    console.log(`\nRun ${result.status}${result.message ? `: ${result.message}` : ""}`);

    const proposals = await deps.repos.proposals.list({});
    if (proposals.length > 0) console.log(`\n${proposals.map(proposalText).join("\n\n")}`);
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
