import { beforeEach, describe, expect, it } from "vitest";
import { cents } from "../../core/money.js";
import { toTicker, type Proposal } from "../../core/types.js";
import { approveAll, expirePending, handleApproval, remindPending } from "../handleApproval.js";
import { harness, NEXT, OWNER, type Harness } from "./harness.js";

function proposal(id: string, overrides: Partial<Proposal> = {}): Proposal {
    return {
        id,
        runId: "run-1",
        tradeDate: NEXT,
        ticker: toTicker("AAA"),
        side: "buy",
        requestedQty: 10,
        qty: 10,
        limitPrice: cents(10_000),
        targetWeight: 0.05,
        stopLossPct: 0.08,
        takeProfitPct: 0.2,
        confidence: 3,
        reasoning: "",
        status: "pending",
        riskNotes: [],
        ...overrides,
    };
}

describe("approvals", () => {
    let h: Harness;
    const status = async (id: string) => (await h.repos.proposals.get(id))?.status;

    beforeEach(async () => {
        h = harness({ mode: "live" });
        await h.repos.runs.start({ id: "run-1", type: "evening_analysis", tradeDate: NEXT, startedAt: h.clock.now() });
        await h.repos.proposals.saveMany([
            proposal("p1"),
            proposal("p2"),
            proposal("p3", { status: "rejected", qty: 0 }),
        ]);
    });

    it("approves a pending proposal", async () => {
        expect(await handleApproval(h, { chatId: OWNER, proposalId: "p1", action: "approve" })).toEqual({
            ok: true,
            text: "✅ Approved: buy 10 AAA.",
        });
        expect(await status("p1")).toBe("approved");
    });

    it("rejects a pending proposal", async () => {
        await handleApproval(h, { chatId: OWNER, proposalId: "p1", action: "reject" });

        expect(await status("p1")).toBe("rejected");
    });

    it("ignores anyone but the owner", async () => {
        expect(await handleApproval(h, { chatId: 7, proposalId: "p1", action: "approve" })).toEqual({
            ok: false,
            text: "Not allowed.",
        });
        expect(await approveAll(h, { chatId: 7, tradeDate: NEXT })).toMatchObject({ ok: false });
        expect(await status("p1")).toBe("pending");
    });

    it("is idempotent on a double click", async () => {
        await handleApproval(h, { chatId: OWNER, proposalId: "p1", action: "approve" });

        expect(await handleApproval(h, { chatId: OWNER, proposalId: "p1", action: "approve" })).toEqual({
            ok: true,
            text: "Already approved: buy 10 AAA.",
        });
        expect(await handleApproval(h, { chatId: OWNER, proposalId: "p1", action: "reject" })).toEqual({
            ok: false,
            text: "Cannot reject buy 10 AAA: it is approved.",
        });
    });

    it("refuses risk-rejected and unknown proposals", async () => {
        expect((await handleApproval(h, { chatId: OWNER, proposalId: "p3", action: "approve" })).ok).toBe(false);
        expect(await handleApproval(h, { chatId: OWNER, proposalId: "nope", action: "approve" })).toEqual({
            ok: false,
            text: "Unknown proposal.",
        });
    });

    it("fails cleanly after the 09:25 deadline and marks the proposal expired", async () => {
        h.clock.set("2026-11-03T14:25:00Z"); // 09:25 EST

        expect(await handleApproval(h, { chatId: OWNER, proposalId: "p1", action: "approve" })).toEqual({
            ok: false,
            text: "Too late: buy 10 AAA expired at 09:25 New York time.",
        });
        expect(await status("p1")).toBe("expired");
        expect((await handleApproval(h, { chatId: OWNER, proposalId: "p1", action: "approve" })).text).toContain(
            "Too late",
        );
    });

    it("still accepts approvals one minute before the deadline", async () => {
        h.clock.set("2026-11-03T14:24:00Z");

        expect((await handleApproval(h, { chatId: OWNER, proposalId: "p1", action: "approve" })).ok).toBe(true);
    });

    it("approves all pending proposals of a trade date", async () => {
        await handleApproval(h, { chatId: OWNER, proposalId: "p2", action: "approve" });

        expect(await approveAll(h, { chatId: OWNER, tradeDate: NEXT })).toEqual({ ok: true, text: "Approved 1 of 1." });
        expect([await status("p1"), await status("p2"), await status("p3")]).toEqual([
            "approved",
            "approved",
            "rejected",
        ]);
        expect(await approveAll(h, { chatId: OWNER, tradeDate: NEXT })).toEqual({ ok: true, text: "Nothing pending." });
    });

    it("reminds the owner of pending proposals on the trade date", async () => {
        h.clock.set("2026-11-03T11:00:00Z"); // 06:00 EST

        await remindPending(h);

        expect(h.notifier.texts()).toEqual([
            "⏰ 2 orders still waiting for approval. They expire at 09:25 New York time.",
        ]);
    });

    it("expires what is still pending", async () => {
        h.clock.set("2026-11-03T14:25:00Z");

        expect(await expirePending(h)).toBe(2);
        expect([await status("p1"), await status("p2")]).toEqual(["expired", "expired"]);
        expect(await expirePending(h)).toBe(0);
    });
});
