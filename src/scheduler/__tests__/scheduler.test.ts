import { pino } from "pino";
import { beforeEach, describe, expect, it } from "vitest";
import { FakeBroker, FakeClock, FakeNotifier } from "../../adapters/fake/index.js";
import { openDatabase } from "../../adapters/sqlite/db.js";
import { migrate } from "../../adapters/sqlite/migrate.js";
import { createSqliteRepositories } from "../../adapters/sqlite/repositories/index.js";
import { cents } from "../../core/money.js";
import { toTradingDate, type TradingDate } from "../../core/types.js";
import type { Repositories, RunType } from "../../ports/repositories.js";
import { dailySchedule, Scheduler } from "../index.js";

describe("Scheduler", () => {
    let clock: FakeClock;
    let broker: FakeBroker;
    let notifier: FakeNotifier;
    let repos: Repositories;
    let ran: string[];
    let scheduler: Scheduler;

    /** Records the run like the real use cases do, so the scheduler sees it on later ticks. */
    const job = (type: RunType) => async () => {
        const date = toTradingDate(clock.now().toISOString().slice(0, 10));
        ran.push(`${type}@${clock.now().toISOString().slice(11, 16)}`);
        await repos.runs.start({ id: `${type}-${date}`, type, tradeDate: date, startedAt: clock.now() });
        await repos.runs.finish(`${type}-${date}`, { status: "succeeded", finishedAt: clock.now() });
    };

    function tradingDay(date: string, close = "21:00") {
        broker.calendar.push({
            date: toTradingDate(date),
            open: new Date(`${date}T14:30:00Z`),
            close: new Date(`${date}T${close}:00Z`),
        });
    }

    beforeEach(() => {
        const db = openDatabase(":memory:");
        migrate(db);
        repos = createSqliteRepositories(db);
        clock = new FakeClock("2026-11-02T10:00:00Z");
        broker = new FakeBroker({ clock, cash: cents(0) });
        notifier = new FakeNotifier();
        ran = [];
        tradingDay("2026-11-02");
        tradingDay("2026-11-27", "18:00"); // half day after Thanksgiving: close 13:00 New York
        scheduler = new Scheduler(
            { broker, clock, runs: repos.runs, notifier, logger: pino({ level: "silent" }) },
            dailySchedule({
                liquidList: job("liquid_list"),
                approvalReminder: job("approval_reminder"),
                executeAtOpen: job("execute_at_open"),
                endOfDay: job("end_of_day"),
                eveningAnalysis: job("evening_analysis"),
                weeklyReport: job("weekly_report"),
            }),
        );
    });

    async function runDay(from: string, to: string): Promise<void> {
        for (let t = new Date(from).getTime(); t <= new Date(to).getTime(); t += 60_000) {
            clock.set(new Date(t));
            await scheduler.tick();
        }
    }

    it("runs each job once at its New York time on a trading day", async () => {
        await runDay("2026-11-02T10:00:00Z", "2026-11-03T03:00:00Z");

        expect(ran).toEqual([
            "approval_reminder@11:00",
            "liquid_list@12:00",
            "execute_at_open@14:30",
            "end_of_day@21:20",
            "evening_analysis@21:30",
        ]);
    });

    it("runs only date-based jobs on days the market is closed", async () => {
        await runDay("2026-11-07T10:00:00Z", "2026-11-08T03:00:00Z"); // Saturday

        expect(ran).toEqual(["liquid_list@12:00"]);
    });

    it("sends the weekly report on Sundays", async () => {
        await runDay("2026-11-08T14:00:00Z", "2026-11-08T15:30:00Z");

        expect(ran).toContain("weekly_report@15:00");
    });

    it("moves the end of day and evening jobs with an early close", async () => {
        await runDay("2026-11-27T17:00:00Z", "2026-11-27T20:00:00Z");

        expect(ran.filter((r) => !r.startsWith("liquid_list"))).toEqual(["end_of_day@18:20", "evening_analysis@18:30"]);
    });

    it("alerts on a missed job and never runs it late", async () => {
        // The bot comes up at 10:00 New York, half an hour after the open.
        await runDay("2026-11-02T15:00:00Z", "2026-11-02T15:05:00Z");

        expect(ran).not.toContain("execute_at_open@15:00");
        expect(notifier.texts()).toContain(
            "⏰ Missed execute_at_open for 2026-11-02 (the bot was not running in time). It will not be run late.",
        );
        const missed = await repos.runs.latest("execute_at_open", toTradingDate("2026-11-02"));
        expect(missed).toMatchObject({ status: "skipped", error: expect.stringContaining("missed") as unknown });

        await runDay("2026-11-02T15:06:00Z", "2026-11-02T15:08:00Z");
        expect(notifier.texts().filter((t) => t.includes("Missed execute_at_open"))).toHaveLength(1);
    });

    it("does not run a job again after a restart", async () => {
        await runDay("2026-11-02T14:30:00Z", "2026-11-02T14:31:00Z");
        const restarted = new Scheduler(
            { broker, clock, runs: repos.runs, notifier, logger: pino({ level: "silent" }) },
            dailySchedule({
                liquidList: job("liquid_list"),
                approvalReminder: job("approval_reminder"),
                executeAtOpen: job("execute_at_open"),
                endOfDay: job("end_of_day"),
                eveningAnalysis: job("evening_analysis"),
                weeklyReport: job("weekly_report"),
            }),
        );

        clock.set("2026-11-02T14:35:00Z");
        await restarted.tick();

        expect(ran.filter((r) => r.startsWith("execute_at_open"))).toHaveLength(1);
    });

    it("keeps ticking when the calendar cannot be read", async () => {
        broker.failures.failNext("getCalendar", new Error("down"));

        clock.set("2026-11-02T14:30:00Z");
        await scheduler.tick();
        expect(ran).toEqual([]);

        await scheduler.tick();
        expect(ran).toContain("execute_at_open@14:30");
    });

    it("waits for a running job when stopped", async () => {
        let finished = false;
        const slow = new Scheduler({ broker, clock, runs: repos.runs, notifier, logger: pino({ level: "silent" }) }, [
            {
                type: "liquid_list",
                dueAt: (d: TradingDate) => new Date(`${d}T00:00:00Z`),
                windowMs: 86_400_000,
                run: () =>
                    new Promise<void>((resolve) => {
                        setTimeout(() => {
                            finished = true;
                            resolve();
                        }, 20);
                    }),
            },
        ]);

        const tick = slow.tick();
        await slow.stop();
        await tick;

        expect(finished).toBe(true);
    });
});
