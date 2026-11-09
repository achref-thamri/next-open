import { beforeEach, describe, expect, it } from "vitest";
import { FakeBroker } from "../../adapters/fake/index.js";
import { cents } from "../../core/money.js";
import { toTicker, toTradingDate } from "../../core/types.js";
import { TransientError } from "../../lib/errors.js";
import { runEveningAnalysis } from "../runEveningAnalysis.js";
import { ASOF, decision, harness, llmOutput, NEXT, seedLiquidList, seedStock, type Harness } from "./harness.js";

describe("runEveningAnalysis", () => {
    let h: Harness;

    async function seedMarket(target: Harness): Promise<void> {
        seedStock(target, "AAA", { lastMove: 0.05, lastVolumeMultiple: 3 });
        seedStock(target, "BBB", { lastMove: -0.02 });
        seedStock(target, "TINY", { marketCapUsd: 5e8 });
        seedStock(target, "SPY");
        seedStock(target, "VT");
        await seedLiquidList(target, ["AAA", "BBB", "TINY"]);
    }

    beforeEach(async () => {
        h = harness();
        await seedMarket(h);
    });

    const runs = async () => h.repos.runs.latest("evening_analysis", ASOF);

    it("proposes, risk-checks and auto-approves trades in paper mode", async () => {
        h.llm.respondWith(llmOutput(decision("AAA", { targetWeight: 0.08 })));

        const result = await runEveningAnalysis(h);

        expect(result).toEqual({ status: "succeeded", message: "1 proposals" });
        const [proposal] = await h.repos.proposals.list({ tradeDate: NEXT });
        // $8,000 at a limit of $105 × 1.01 = $106.05 → 75 shares
        expect(proposal).toMatchObject({
            ticker: "AAA",
            side: "buy",
            qty: 75,
            requestedQty: 75,
            limitPrice: 10_605,
            stopLossPct: 0.08,
            takeProfitPct: 0.2,
            status: "approved",
            riskNotes: [],
        });
        expect(h.notifier.texts()[0]).toContain("1 order for the open on 2026-11-03 (paper: auto-approved)");
        expect(h.notifier.texts()[0]).toContain("🟢 BUY 75 AAA at ≤ $106.05");
        expect((await runs())?.status).toBe("succeeded");
    });

    it("stores candidates with filter results and the decisions", async () => {
        h.llm.respondWith(llmOutput(decision("AAA")));

        await runEveningAnalysis(h);

        const run = await runs();
        const candidates = await h.repos.candidates.listByRun(run?.id ?? "");
        expect(candidates.map((c) => [c.candidate.ticker, c.passed, c.rejectReason])).toEqual([
            ["AAA", true, undefined],
            ["BBB", true, undefined],
            ["TINY", false, "market cap $500M below $2B"],
        ]);
        expect((await h.repos.decisions.latestForTicker(toTicker("AAA")))?.reasoning).toBe("Reason for AAA.");
    });

    it("sends the shortlist, holdings and news in the prompt", async () => {
        h.broker.seedPosition(toTicker("BBB"), 50, cents(9_000));
        h.news.items.push({
            id: "n1",
            headline: "AAA soars on earnings",
            summary: "",
            source: "test",
            createdAt: new Date("2026-11-02T20:00:00Z"),
            tickers: [toTicker("AAA")],
        });
        h.llm.respondWith(llmOutput(decision("BBB", { action: "hold", targetWeight: 0.05 })));

        await runEveningAnalysis(h);

        const user = h.llm.prompts[0]?.user ?? "";
        expect(user).toContain('"ticker":"AAA"');
        expect(user).toContain("AAA soars on earnings");
        expect(user).toContain('"ticker":"BBB","qty":50');
        expect(user).not.toContain('"ticker":"TINY"');
        expect(user).toContain('"symbol":"SPY"');
    });

    it("rejects invalid LLM output: no proposals, an alert and a failed run", async () => {
        h.llm.respondWith("not json at all");

        const result = await runEveningAnalysis(h);

        expect(result.status).toBe("failed");
        expect(await h.repos.proposals.list({})).toEqual([]);
        expect(h.notifier.texts().at(-1)).toContain("evening_analysis failed");
        expect((await runs())?.error).toContain("invalid LLM output");
    });

    it("treats a missing holding as invalid output", async () => {
        h.broker.seedPosition(toTicker("BBB"), 50, cents(9_000));
        h.llm.respondWith(llmOutput(decision("AAA")));

        const result = await runEveningAnalysis(h);

        expect(result).toEqual({ status: "failed", message: `invalid LLM output: holding BBB has no decision` });
        expect(await h.repos.proposals.list({})).toEqual([]);
    });

    it("treats an unknown ticker as invalid output", async () => {
        h.llm.respondWith(llmOutput(decision("ZZZZ")));

        expect(await runEveningAnalysis(h)).toEqual({
            status: "failed",
            message: `invalid LLM output: unknown ticker ZZZZ`,
        });
    });

    it("aborts the run when news keeps failing (no partial-data runs)", async () => {
        h.news.failures.failNext("getNews", new TransientError("news API down"), 10);

        const result = await runEveningAnalysis(h);

        expect(result).toEqual({ status: "failed", message: "news API down" });
        expect(h.llm.prompts).toEqual([]);
        expect(h.notifier.texts()[0]).toContain("No trades were made");
    });

    it("refuses to analyse when today's bars are not available yet", async () => {
        h.clock.set("2026-11-03T21:30:00Z"); // bars end on 11-02

        const result = await runEveningAnalysis(h);

        expect(result).toEqual({
            status: "failed",
            message: "No daily bars for 2026-11-03 yet; refusing to analyse stale data",
        });
        expect(h.llm.prompts).toEqual([]);
    });

    it("leaves out tickers without a bar for today", async () => {
        seedStock(h, "OLD", { until: toTradingDate("2026-10-30") });
        await seedLiquidList(h, ["AAA", "BBB", "OLD"]);
        h.llm.respondWith(llmOutput());

        await runEveningAnalysis(h);

        expect(h.llm.prompts[0]?.user).not.toContain('"ticker":"OLD"');
    });

    it("does nothing on a non-trading day", async () => {
        h.clock.set("2026-11-07T21:30:00Z"); // Saturday

        const result = await runEveningAnalysis(h);

        expect(result).toEqual({ status: "skipped", message: "2026-11-07 is not a trading day" });
        expect(h.llm.prompts).toEqual([]);
        expect(h.notifier.sent).toEqual([]);
    });

    it("skips when proposals for the next trading day already exist", async () => {
        h.llm.respondWith(llmOutput(decision("AAA")));
        await runEveningAnalysis(h);
        const calls = h.llm.prompts.length;

        const again = await runEveningAnalysis(h);

        expect(again).toEqual({ status: "skipped", message: "proposals for 2026-11-03 already exist" });
        expect(h.llm.prompts).toHaveLength(calls);
    });

    it("skips until the liquid list has stocks", async () => {
        const fresh = harness();
        seedStock(fresh, "AAA");

        expect(await runEveningAnalysis(fresh)).toMatchObject({ status: "skipped" });

        await fresh.repos.liquidLists.save({ date: toTradingDate("2026-11-01"), tickers: [], complete: false });
        expect(await runEveningAnalysis(fresh)).toMatchObject({ status: "skipped" });
    });

    it("trades from a list that is still filling", async () => {
        await h.repos.liquidLists.save({
            date: toTradingDate("2026-11-01"),
            tickers: [toTicker("AAA")],
            complete: false,
        });
        h.llm.respondWith(llmOutput(decision("AAA")));

        await runEveningAnalysis(h);

        const proposals = await h.repos.proposals.list({ tradeDate: NEXT });
        expect(proposals.map((p) => p.ticker)).toEqual(["AAA"]);
    });

    it("sends proposals with buttons in live mode and leaves them pending", async () => {
        h = harness({ mode: "live" });
        await seedMarket(h);
        h.llm.respondWith(llmOutput(decision("AAA"), decision("BBB", { targetWeight: 0.05 })));

        await runEveningAnalysis(h);

        const proposals = await h.repos.proposals.list({ tradeDate: NEXT });
        expect(proposals.map((p) => p.status)).toEqual(["pending", "pending"]);
        expect(h.notifier.sent.map((m) => m.kind)).toEqual(["text", "proposal", "proposal", "approve_all"]);
    });

    it("records risk trims with their reasons", async () => {
        // $100,000 equity but only $12,000 cash: min cash keeps $10,000, so the $8,000 buy gets $2,000.
        const broker = new FakeBroker({ clock: h.clock, cash: cents(1_200_000) });
        broker.calendar.push(...h.broker.calendar);
        broker.seedPosition(toTicker("BBB"), 880, cents(10_000));
        h.broker = broker;
        h.llm.respondWith(
            llmOutput(decision("AAA", { targetWeight: 0.08 }), decision("BBB", { action: "hold", targetWeight: 0.08 })),
        );

        await runEveningAnalysis(h);

        const [proposal] = await h.repos.proposals.list({ tradeDate: NEXT });
        expect(proposal).toMatchObject({
            status: "approved",
            requestedQty: 75,
            qty: 18,
            riskNotes: ["cash kept at 10% of equity ($10,000.00)"],
        });
        expect(h.notifier.texts()[0]).toContain("Risk: trimmed from 75");
    });

    it("rejects every order while halted", async () => {
        await h.repos.settings.update({ halted: true, haltReason: "manual stop" });
        h.llm.respondWith(llmOutput(decision("AAA")));

        await runEveningAnalysis(h);

        const [proposal] = await h.repos.proposals.list({ tradeDate: NEXT });
        expect(proposal).toMatchObject({ status: "rejected", qty: 0, riskNotes: ["trading is halted"] });
        expect(h.notifier.texts()[0]).toContain("Rejected by risk checks");
    });
});
