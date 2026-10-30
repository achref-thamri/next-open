import { Cron } from "croner";
import { newYorkInstant, tradingDateOf, type TradingDate } from "../core/types.js";
import type { Logger } from "../lib/logger.js";
import type { Broker, MarketDay } from "../ports/broker.js";
import type { Clock } from "../ports/clock.js";
import type { Notifier } from "../ports/notifier.js";
import type { RunsRepository, RunType } from "../ports/repositories.js";

const MINUTE = 60_000;
const HEARTBEAT_EVERY_MS = 15 * MINUTE;

export interface JobSpec {
    type: RunType;
    /** When the job is due on a date, or undefined when it does not run that day. */
    dueAt(date: TradingDate, marketDay: MarketDay | undefined): Date | undefined;
    /** How long after the due time the job may still start; later it is reported as missed, never run. */
    windowMs: number;
    run(): Promise<unknown>;
}

export interface SchedulerDeps {
    broker: Broker;
    clock: Clock;
    runs: RunsRepository;
    notifier: Notifier;
    logger: Logger;
    /** Called on every tick; the container health check watches it. */
    onTick?: (now: Date) => void;
}

/** Spec §4 times, in New York time. Trading-day jobs follow the session, so half days move with the close. */
export function dailySchedule(jobs: {
    liquidList: () => Promise<unknown>;
    approvalReminder: () => Promise<unknown>;
    executeAtOpen: () => Promise<unknown>;
    endOfDay: () => Promise<unknown>;
    eveningAnalysis: () => Promise<unknown>;
    weeklyReport: () => Promise<unknown>;
}): JobSpec[] {
    const at = (date: TradingDate, time: string) => newYorkInstant(date, time);
    const after = (instant: Date, minutes: number) => new Date(instant.getTime() + minutes * MINUTE);
    const isSunday = (date: TradingDate) => new Date(`${date}T12:00:00Z`).getUTCDay() === 0;
    return [
        { type: "liquid_list", dueAt: (d) => at(d, "07:00"), windowMs: 12 * 60 * MINUTE, run: jobs.liquidList },
        {
            type: "weekly_report",
            dueAt: (d) => (isSunday(d) ? at(d, "10:00") : undefined),
            windowMs: 12 * 60 * MINUTE,
            run: jobs.weeklyReport,
        },
        {
            type: "approval_reminder",
            dueAt: (d, day) => day && at(d, "06:00"),
            windowMs: 60 * MINUTE,
            run: jobs.approvalReminder,
        },
        // Stale prices after a quarter of an hour: better to skip the day than to trade late.
        { type: "execute_at_open", dueAt: (_, day) => day?.open, windowMs: 15 * MINUTE, run: jobs.executeAtOpen },
        // SIP bars from the last 15 minutes are refused, so wait 20 minutes after the close.
        {
            type: "end_of_day",
            dueAt: (_, day) => day && after(day.close, 20),
            windowMs: 60 * MINUTE,
            run: jobs.endOfDay,
        },
        {
            type: "evening_analysis",
            dueAt: (_, day) => day && after(day.close, 30),
            windowMs: 90 * MINUTE,
            run: jobs.eveningAnalysis,
        },
    ];
}

/**
 * Checks once a minute which jobs are due, using the broker calendar for trading days and session times.
 * A job runs once per date (the run records survive restarts); a job whose window has passed without a run is
 * recorded as missed and alerted, never replayed. Jobs run one at a time, in due order.
 */
export class Scheduler {
    private cron: Cron | undefined;
    private queue: Promise<unknown> = Promise.resolve();
    private readonly calendar = new Map<TradingDate, MarketDay | undefined>();
    private readonly started = new Set<string>();
    private lastHeartbeat = 0;

    constructor(
        private readonly deps: SchedulerDeps,
        private readonly jobs: readonly JobSpec[],
    ) {}

    start(): void {
        this.cron = new Cron("* * * * *", { timezone: "America/New_York", protect: true }, () => this.tick());
        this.deps.logger.info({ jobs: this.jobs.map((j) => j.type) }, "scheduler started");
        void this.tick();
    }

    /** Stops scheduling and waits for the running job to finish. */
    async stop(): Promise<void> {
        this.cron?.stop();
        await this.queue;
    }

    /** One scheduling pass; public for tests. */
    async tick(): Promise<void> {
        const now = this.deps.clock.now();
        this.deps.onTick?.(now);
        if (now.getTime() - this.lastHeartbeat >= HEARTBEAT_EVERY_MS) {
            this.lastHeartbeat = now.getTime();
            this.deps.logger.info("scheduler heartbeat");
        }
        try {
            const date = tradingDateOf(now);
            const day = await this.marketDay(date);
            for (const job of this.jobs) await this.consider(job, date, day, now);
        } catch (error) {
            this.deps.logger.error({ err: error }, "scheduler tick failed");
        }
        await this.queue;
    }

    private async consider(job: JobSpec, date: TradingDate, day: MarketDay | undefined, now: Date): Promise<void> {
        const due = job.dueAt(date, day);
        if (!due || now < due) return;
        const key = `${job.type}:${date}`;
        if (this.started.has(key) || (await this.deps.runs.latest(job.type, date))) return;
        this.started.add(key);

        if (now.getTime() > due.getTime() + job.windowMs) {
            await this.recordMissed(job, date, due);
            return;
        }
        this.queue = this.queue.then(async () => {
            try {
                await job.run();
            } catch (error) {
                this.deps.logger.error({ err: error, job: job.type }, "job threw");
            }
        });
        await this.queue;
    }

    private async recordMissed(job: JobSpec, date: TradingDate, due: Date): Promise<void> {
        const { runs, notifier, clock, logger } = this.deps;
        const id = `missed-${job.type}-${date}`;
        const message = `missed: not started within ${job.windowMs / MINUTE} minutes of ${due.toISOString()}`;
        logger.warn({ job: job.type, date }, message);
        await runs.start({ id, type: job.type, tradeDate: date, startedAt: clock.now() });
        await runs.finish(id, { status: "skipped", finishedAt: clock.now(), error: message });
        try {
            await notifier.send(
                `⏰ Missed ${job.type} for ${date} (the bot was not running in time). It will not be run late.`,
            );
        } catch (error) {
            logger.error({ err: error }, "failed to send the missed-job alert");
        }
    }

    private async marketDay(date: TradingDate): Promise<MarketDay | undefined> {
        if (!this.calendar.has(date)) {
            const [day] = await this.deps.broker.getCalendar(date, date);
            this.calendar.set(date, day?.date === date ? day : undefined);
            for (const old of [...this.calendar.keys()]) if (old < date) this.calendar.delete(old);
        }
        return this.calendar.get(date);
    }
}
