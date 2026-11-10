import { beforeEach, describe, expect, it } from "vitest";
import { cents } from "../../../core/money.js";
import { toTicker, toTradingDate, type Candidate, type Proposal } from "../../../core/types.js";
import type { BrokerFill } from "../../../ports/broker.js";
import type { DecisionRecord, OrderRecord, Repositories } from "../../../ports/repositories.js";
import { openDatabase } from "../db.js";
import { migrate } from "../migrate.js";
import { createSqliteRepositories } from "../repositories/index.js";

const AAA = toTicker("AAA");
const day = toTradingDate("2026-11-02");
const at = (iso: string) => new Date(iso);

let repos: Repositories;

beforeEach(async () => {
    const db = openDatabase(":memory:");
    migrate(db);
    repos = createSqliteRepositories(db);
    await repos.runs.start({
        id: "run-1",
        type: "evening_analysis",
        tradeDate: day,
        startedAt: at("2026-11-02T21:30:00Z"),
    });
});

function proposal(overrides: Partial<Proposal> = {}): Proposal {
    return {
        id: "p-1",
        runId: "run-1",
        tradeDate: toTradingDate("2026-11-03"),
        ticker: AAA,
        side: "buy",
        requestedQty: 12,
        qty: 10,
        limitPrice: cents(10_100),
        targetWeight: 0.08,
        stopLossPct: 0.07,
        takeProfitPct: 0.15,
        confidence: 4,
        reasoning: "Beat estimates.",
        status: "pending",
        riskNotes: ["position capped at 10% of equity ($10,000.00)"],
        ...overrides,
    };
}

describe("runs", () => {
    it("starts, finishes and finds the latest run", async () => {
        await repos.runs.start({
            id: "run-2",
            type: "evening_analysis",
            tradeDate: day,
            startedAt: at("2026-11-02T21:40:00Z"),
        });
        await repos.runs.finish("run-2", { status: "succeeded", finishedAt: at("2026-11-02T21:41:00Z") });

        expect(await repos.runs.latest("evening_analysis", day)).toEqual({
            id: "run-2",
            type: "evening_analysis",
            tradeDate: day,
            startedAt: at("2026-11-02T21:40:00Z"),
            finishedAt: at("2026-11-02T21:41:00Z"),
            status: "succeeded",
            error: undefined,
            explained: false,
        });
        expect(await repos.runs.latest("end_of_day", day)).toBeUndefined();
    });

    it("tracks unexplained failures", async () => {
        await repos.runs.finish("run-1", { status: "failed", finishedAt: at("2026-11-02T21:31:00Z"), error: "boom" });

        expect((await repos.runs.lastUnexplainedFailure())?.error).toBe("boom");

        await repos.runs.markExplained("run-1");

        expect(await repos.runs.lastUnexplainedFailure()).toBeUndefined();
        expect((await repos.runs.get("run-1"))?.explained).toBe(true);
    });

    it("fails to finish an unknown run", async () => {
        await expect(repos.runs.finish("nope", { status: "succeeded", finishedAt: new Date() })).rejects.toThrow(
            "Run not found",
        );
    });
});

describe("candidates", () => {
    it("round-trips candidates with their filter result", async () => {
        const candidate: Candidate = {
            ticker: AAA,
            exchange: "NYSE",
            kind: "common_stock",
            close: cents(10_000),
            changePct: 0.05,
            relativeVolume: 2,
            avgDollarVolumeUsd: 1e8,
            marketCapUsd: undefined,
            isHolding: false,
            inNews: true,
        };

        await repos.candidates.saveMany("run-1", [{ candidate, passed: false, rejectReason: "market cap unknown" }]);

        const [record] = await repos.candidates.listByRun("run-1");
        expect(record).toEqual({
            candidate: { ...candidate, marketCapUsd: undefined },
            passed: false,
            rejectReason: "market cap unknown",
        });
    });
});

describe("llm calls and decisions", () => {
    it("stores calls and returns decisions by recency and ticker", async () => {
        const callId = await repos.llmCalls.save("run-1", {
            model: "claude-sonnet-5-5",
            prompt: { system: "sys", user: "data" },
            response: "{}",
            inputTokens: 10,
            outputTokens: 5,
            costUsd: 0.001,
            durationMs: 1200,
        });
        const decision = (id: string, ticker: string, createdAt: string): DecisionRecord => ({
            id,
            runId: "run-1",
            llmCallId: callId,
            tradeDate: day,
            ticker: toTicker(ticker),
            action: "buy",
            targetWeight: 0.05,
            confidence: 3,
            stopLossPct: 0.08,
            takeProfitPct: 0.2,
            horizonDays: 10,
            reasoning: `why ${id}`,
            createdAt: at(createdAt),
        });

        await repos.decisions.saveMany([
            decision("d1", "AAA", "2026-11-01T21:00:00Z"),
            decision("d2", "BBB", "2026-11-02T21:00:00Z"),
            decision("d3", "AAA", "2026-11-02T21:00:00Z"),
        ]);

        expect((await repos.decisions.latestForTicker(AAA))?.id).toBe("d3");
        expect((await repos.decisions.recent(2)).map((d) => d.id)).toEqual(["d3", "d2"]);
        expect(await repos.decisions.latestForTicker(toTicker("ZZZ"))).toBeUndefined();
    });
});

describe("proposals", () => {
    it("round-trips a proposal", async () => {
        await repos.proposals.saveMany([
            proposal(),
            proposal({ id: "p-2", side: "sell", stopLossPct: undefined, takeProfitPct: undefined }),
        ]);

        expect(await repos.proposals.get("p-1")).toEqual(proposal());
        expect((await repos.proposals.get("p-2"))?.stopLossPct).toBeUndefined();
    });

    it("moves between statuses only from the expected ones", async () => {
        await repos.proposals.saveMany([proposal()]);

        expect(await repos.proposals.transition("p-1", ["pending"], "approved")).toBe(true);
        expect(await repos.proposals.transition("p-1", ["pending"], "approved")).toBe(false);
        expect(await repos.proposals.transition("p-1", ["pending"], "rejected")).toBe(false);
        expect(await repos.proposals.transition("p-1", ["approved"], "executed")).toBe(true);
        expect((await repos.proposals.get("p-1"))?.status).toBe("executed");
        expect(await repos.proposals.transition("missing", ["pending"], "approved")).toBe(false);
        expect(await repos.proposals.transition("p-1", [], "approved")).toBe(false);
    });

    it("filters by trade date and status", async () => {
        await repos.proposals.saveMany([
            proposal({ id: "p-1" }),
            proposal({ id: "p-2", status: "approved" }),
            proposal({ id: "p-3", tradeDate: toTradingDate("2026-11-04") }),
        ]);

        const ids = async (filter: Parameters<Repositories["proposals"]["list"]>[0]) =>
            (await repos.proposals.list(filter)).map((p) => p.id);
        expect(await ids({ tradeDate: toTradingDate("2026-11-03") })).toEqual(["p-1", "p-2"]);
        expect(await ids({ statuses: ["pending"] })).toEqual(["p-1", "p-3"]);
        expect(await ids({ tradeDate: toTradingDate("2026-11-03"), statuses: ["approved", "executed"] })).toEqual([
            "p-2",
        ]);
        expect(await ids({ statuses: [] })).toEqual([]);
        expect(await ids({})).toEqual(["p-1", "p-2", "p-3"]);
    });

    it("records the execution-time risk check", async () => {
        await repos.proposals.saveMany([proposal()]);

        await repos.proposals.updateRisk("p-1", 7, ["trimmed at execution"]);

        expect(await repos.proposals.get("p-1")).toMatchObject({ qty: 7, riskNotes: ["trimmed at execution"] });
    });

    it("requires an existing run", async () => {
        await expect(repos.proposals.saveMany([proposal({ runId: "nope" })])).rejects.toThrow(/FOREIGN KEY/);
    });
});

describe("orders", () => {
    const order: OrderRecord = {
        clientOrderId: "no-p-1",
        brokerOrderId: "b-1",
        proposalId: "p-1",
        tradeDate: toTradingDate("2026-11-03"),
        ticker: AAA,
        side: "buy",
        role: "entry",
        qty: 10,
        filledQty: 0,
        filledAvgPrice: undefined,
        limitPrice: cents(10_100),
        status: "open",
        submittedAt: at("2026-11-03T14:30:00Z"),
        updatedAt: at("2026-11-03T14:30:00Z"),
    };

    beforeEach(async () => {
        await repos.proposals.saveMany([proposal()]);
    });

    it("inserts and then updates by client order id", async () => {
        await repos.orders.upsert(order);
        const filled = {
            ...order,
            filledQty: 10,
            filledAvgPrice: cents(10_050),
            status: "filled" as const,
            updatedAt: at("2026-11-03T14:31:00Z"),
        };
        await repos.orders.upsert(filled);

        expect(await repos.orders.getByClientOrderId("no-p-1")).toEqual(filled);
        expect(await repos.orders.list({ statuses: ["open"] })).toEqual([]);
        expect(await repos.orders.list({ tradeDate: order.tradeDate })).toHaveLength(1);
    });
});

describe("fills", () => {
    const fill = (id: string, time: string): BrokerFill => ({
        id,
        orderId: "b-1",
        ticker: AAA,
        side: "buy",
        qty: 1,
        price: cents(100),
        fee: cents(0),
        date: day,
        time: at(time),
    });

    it("stores each fill once, in execution order", async () => {
        await repos.fills.saveMany([fill("f2", "2026-11-02T15:00:00Z"), fill("f1", "2026-11-02T14:30:00Z")]);
        await repos.fills.saveMany([fill("f1", "2026-11-02T14:30:00Z")]);

        expect((await repos.fills.list()).map((f) => f.id)).toEqual(["f1", "f2"]);
        expect((await repos.fills.latest())?.id).toBe("f2");
    });
});

describe("equity snapshots", () => {
    it("keeps one snapshot per date", async () => {
        const snap = { date: day, equity: cents(100), cash: cents(50), benchmarkValue: cents(100) };
        await repos.equity.save(snap);
        await repos.equity.save({ ...snap, equity: cents(101) });
        await repos.equity.save({ ...snap, date: toTradingDate("2026-10-30") });

        expect((await repos.equity.list()).map((s) => [s.date, s.equity])).toEqual([
            ["2026-10-30", 100],
            ["2026-11-02", 101],
        ]);
        expect((await repos.equity.latest())?.date).toBe("2026-11-02");
    });
});

describe("settings", () => {
    it("returns defaults when nothing is stored", async () => {
        expect(await repos.settings.get()).toEqual({
            halted: false,
            haltReason: undefined,
            liveConfirmed: false,
            benchmark: undefined,
            running: false,
            crashAlertedAt: undefined,
        });
    });

    it("round-trips updates and clears values set to undefined", async () => {
        const benchmark = { symbol: "VT", shares: 81.234, startDate: day, startValue: cents(10_000_000) };

        expect(await repos.settings.update({ halted: true, haltReason: "daily loss stop", benchmark })).toEqual({
            halted: true,
            haltReason: "daily loss stop",
            liveConfirmed: false,
            benchmark,
            running: false,
            crashAlertedAt: undefined,
        });

        await repos.settings.update({ halted: false, haltReason: undefined });

        expect(await repos.settings.get()).toEqual({
            halted: false,
            haltReason: undefined,
            liveConfirmed: false,
            benchmark,
            running: false,
            crashAlertedAt: undefined,
        });
    });
});

describe("profiles", () => {
    it("caches profiles and reads many at once", async () => {
        const profile = {
            ticker: AAA,
            name: "AAA Corp",
            kind: "common_stock" as const,
            marketCapUsd: 5e9,
            fetchedAt: at("2026-11-01T00:00:00Z"),
        };
        await repos.profiles.save(profile);
        await repos.profiles.save({ ...profile, ticker: toTicker("BBB"), marketCapUsd: undefined });

        expect(await repos.profiles.get(AAA)).toEqual(profile);
        const many = await repos.profiles.getMany([AAA, toTicker("BBB"), toTicker("ZZZ")]);
        expect([...many.keys()]).toEqual(["AAA", "BBB"]);
        expect(many.get(toTicker("BBB"))?.marketCapUsd).toBeUndefined();
    });
});

describe("liquid lists", () => {
    it("returns the latest and the latest complete list", async () => {
        await repos.liquidLists.save({ date: toTradingDate("2026-11-01"), tickers: [AAA], complete: true });
        await repos.liquidLists.save({ date: toTradingDate("2026-11-08"), tickers: [], complete: false });

        expect((await repos.liquidLists.latest())?.date).toBe("2026-11-08");
        expect(await repos.liquidLists.latestComplete()).toEqual({
            date: "2026-11-01",
            tickers: ["AAA"],
            complete: true,
        });
    });
});

describe("api usage", () => {
    it("counts per api and day", async () => {
        expect(await repos.apiUsage.increment("fmp", "2026-11-02")).toBe(1);
        expect(await repos.apiUsage.increment("fmp", "2026-11-02", 3)).toBe(4);
        expect(await repos.apiUsage.get("fmp", "2026-11-02")).toBe(4);
        expect(await repos.apiUsage.get("fmp", "2026-11-03")).toBe(0);
    });
});
