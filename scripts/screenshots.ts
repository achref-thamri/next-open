/**
 * Regenerates the README images from demo data, never from the real account: npm run screenshots
 * - docs/images/telegram-evening.png: an evening summary as eveningSummaryText writes it in paper mode.
 * - docs/images/telegram-report.png: a /report reply, from reportText and comparisonText on made-up daily values.
 * Needs Google Chrome installed; playwright-core drives it and downloads no browser of its own.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { eveningSummaryText } from "../src/app/messages.js";
import { reportText, type Performance } from "../src/app/report.js";
import { comparisonText, type StrategyComparison } from "../src/app/strategyReport.js";
import { taxSchema } from "../src/config/schema.js";
import { evaluateGoLiveGate } from "../src/core/goLiveGate.js";
import { maxDrawdown, sharpeRatio, totalReturn } from "../src/core/metrics.js";
import { cents } from "../src/core/money.js";
import { toTicker, toTradingDate, type Proposal, type TradingDate } from "../src/core/types.js";

const images = join(fileURLToPath(new URL(".", import.meta.url)), "../docs/images");

interface Message {
    from: "owner" | "next-open";
    text: string;
}

/** Tonight's proposals for a $100,000 account holding $14,000 cash: one exit, one buy and one buy trimmed by the cash rule. */
function demoProposals(tradeDate: TradingDate): Proposal[] {
    const base = { runId: "demo", tradeDate, status: "approved" as const, riskNotes: [] };
    return [
        {
            ...base,
            id: "p1",
            ticker: toTicker("INTC"),
            side: "sell",
            requestedQty: 150,
            qty: 150,
            limitPrice: cents(2_480),
            previousClose: cents(2_505),
            targetWeight: 0,
            stopLossPct: undefined,
            takeProfitPct: undefined,
            confidence: 3,
            reasoning:
                "The turnaround story has stalled: two weak quarters in a row and the stock keeps failing at the same " +
                "level. Selling frees cash for better setups.",
        },
        {
            ...base,
            id: "p2",
            ticker: toTicker("LLY"),
            side: "buy",
            requestedQty: 5,
            qty: 5,
            limitPrice: cents(84_120),
            previousClose: cents(83_287),
            targetWeight: 0.05,
            stopLossPct: 0.06,
            takeProfitPct: 0.14,
            confidence: 4,
            reasoning:
                "Strong demand news and a close at a new high on twice the usual volume. A half-size position keeps " +
                "the risk small if the move fades.",
        },
        {
            ...base,
            id: "p3",
            ticker: toTicker("AMD"),
            side: "buy",
            requestedQty: 49,
            qty: 21,
            limitPrice: cents(16_240),
            previousClose: cents(16_079),
            targetWeight: 0.08,
            stopLossPct: 0.07,
            takeProfitPct: 0.15,
            confidence: 4,
            reasoning:
                "Pulled back 6% in three days with the rest of the chip sector while its own outlook was raised. " +
                "Buying the dip with a stop under last week's low.",
            riskNotes: ["cash kept at 10% of equity ($10,000.00)"],
        },
    ];
}

/** Weekdays from `from`, `count` of them. */
function weekdays(from: string, count: number): TradingDate[] {
    const days: TradingDate[] = [];
    for (const date = new Date(`${from}T12:00:00Z`); days.length < count; date.setUTCDate(date.getUTCDate() + 1)) {
        if (date.getUTCDay() % 6 !== 0) days.push(toTradingDate(date.toISOString().slice(0, 10)));
    }
    return days;
}

/** A seeded random walk in cents, so the images come out the same every run. */
function walk(seed: number, days: number, drift: number, volatility: number): number[] {
    let state = seed;
    const random = () => ((state = (state * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31) * 2 - 1;
    const values = [10_000_000];
    for (let i = 1; i < days; i++) values.push(Math.round((values.at(-1) ?? 0) * (1 + drift + random() * volatility)));
    return values;
}

function demoReport(): string {
    const days = weekdays("2026-11-11", 44);
    const today = days.at(-1) ?? toTradingDate("2027-01-11");
    const account = walk(7, days.length, 0.0009, 0.011);
    const benchmark = walk(3, days.length, 0.0004, 0.008);
    const snapshots = days.map((date, i) => ({
        date,
        equity: cents(account[i] ?? 0),
        cash: cents(1_500_000),
        benchmarkValue: cents(benchmark[i] ?? 0),
    }));
    const closedTrades = [312_00, -184_00, 455_00, 97_00, -230_00, 268_00].map((pl, i) => ({
        ticker: toTicker(["MSFT", "TSLA", "AVGO", "COST", "NFLX", "JPM"][i] ?? "AAA"),
        date: days[10 + i * 5] ?? today,
        qty: 10,
        realizedPl: cents(pl),
    }));
    const taxRates = taxSchema.parse({});
    const gate = evaluateGoLiveGate({
        snapshots,
        closedTrades,
        unrealizedPl: cents(1_850_00),
        lastUnexplainedFailure: toTradingDate("2026-11-19"),
        today,
        taxRates,
    });
    const performance: Performance = {
        days: days.length,
        accountReturn: totalReturn(account),
        benchmarkReturn: totalReturn(benchmark),
        accountMaxDrawdown: maxDrawdown(account),
        benchmarkMaxDrawdown: maxDrawdown(benchmark),
        sharpe: sharpeRatio(account),
        winRate: 4 / 6,
        turnover: 1.8,
        fees: cents(14_37),
        realizedTax: cents(195_00),
        gate,
    };

    const patient = walk(11, days.length, 0.0006, 0.007);
    const momentum = walk(5, days.length, 0.0005, 0.012);
    const comparison: StrategyComparison = {
        since: days[0] ?? today,
        days: days.length,
        results: [
            { name: "AI (real paper account)", isBenchmark: false, trades: 6, winRate: 4 / 6, ...stats(account) },
            { name: "Patient AI", isBenchmark: false, trades: 2, winRate: 1 / 2, ...stats(patient) },
            { name: "Momentum rule", isBenchmark: false, trades: 9, winRate: 5 / 9, ...stats(momentum) },
            { name: "VT buy-and-hold", isBenchmark: true, trades: 0, winRate: undefined, ...stats(benchmark) },
        ],
    };
    return `${reportText(performance)}\n\n${comparisonText(comparison)}`;
}

function stats(values: readonly number[]): { return: number; maxDrawdown: number } {
    return { return: totalReturn(values), maxDrawdown: maxDrawdown(values) };
}

function escape(text: string): string {
    return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Chat bubbles in a neutral style. */
function chat(title: string, messages: Message[]): string {
    const bubbles = messages
        .map((m) => `<div class="msg ${m.from}"><div class="bubble">${escape(m.text)}</div></div>`)
        .join("");
    return `<!doctype html><meta charset="utf-8"><style>
        body { margin: 0; background: #e8edf2; font: 15px/1.4 -apple-system, "Segoe UI", sans-serif; }
        header { background: #fff; padding: 12px 16px; font-weight: 600; border-bottom: 1px solid #d0d7de; }
        main { padding: 12px 16px 16px; display: flex; flex-direction: column; gap: 8px; width: 440px; }
        .msg { display: flex; flex-direction: column; max-width: 92%; }
        .msg.next-open { align-self: flex-start; }
        .msg.owner { align-self: flex-end; align-items: flex-end; }
        .bubble { white-space: pre-wrap; padding: 8px 12px; border-radius: 12px; background: #fff; }
        .owner .bubble { background: #d9f2c4; }
    </style><header>${escape(title)}</header><main>${bubbles}</main>`;
}

mkdirSync(images, { recursive: true });
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 472, height: 400 } });

const marketView =
    "Stocks slipped after a strong week. Chips led the fall on heavy volume while healthcare held up. Volatility " +
    "is still low, so this looks like a pause, not a turn.";
const tradeDate = toTradingDate("2026-11-12");
const evening = eveningSummaryText(tradeDate, marketView, demoProposals(tradeDate), true);
await page.setContent(chat("Next Open (example evening)", [{ from: "next-open", text: evening }]));
await page.locator("main").screenshot({ path: join(images, "telegram-evening.png") });

await page.setContent(
    chat("Next Open (example /report)", [
        { from: "owner", text: "/report" },
        { from: "next-open", text: demoReport() },
    ]),
);
await page.locator("main").screenshot({ path: join(images, "telegram-report.png") });

await browser.close();
console.log("wrote telegram-evening.png and telegram-report.png");
