import type { Proposal, TradingDate } from "../core/types.js";
import { newYorkInstant, tradingDateOf } from "../core/types.js";
import type { AppDeps } from "./deps.js";
import { runJob, skip, type JobResult } from "./runJob.js";

/** Proposals must be approved before 09:25 New York time on their trade date. */
const APPROVAL_DEADLINE = "09:25";

export type ApprovalAction = "approve" | "reject";

/** Replies are shown to the owner in Telegram. */
export interface ApprovalReply {
    ok: boolean;
    text: string;
}

const NOT_OWNER: ApprovalReply = { ok: false, text: "Not allowed." };

/** Approves or rejects one proposal. Idempotent: repeating the same action reports the current state. */
export async function handleApproval(
    deps: Pick<AppDeps, "config" | "repos" | "clock" | "logger">,
    request: { chatId: number; proposalId: string; action: ApprovalAction },
): Promise<ApprovalReply> {
    if (request.chatId !== deps.config.ownerChatId) return NOT_OWNER;
    const proposal = await deps.repos.proposals.get(request.proposalId);
    if (!proposal) return { ok: false, text: "Unknown proposal." };
    return decide(deps, proposal, request.action);
}

/** Approves every pending proposal for a trade date. */
export async function approveAll(
    deps: Pick<AppDeps, "config" | "repos" | "clock" | "logger">,
    request: { chatId: number; tradeDate: TradingDate },
): Promise<ApprovalReply> {
    if (request.chatId !== deps.config.ownerChatId) return NOT_OWNER;
    const pending = await deps.repos.proposals.list({ tradeDate: request.tradeDate, statuses: ["pending"] });
    if (pending.length === 0) return { ok: true, text: "Nothing pending." };
    const replies = [];
    for (const proposal of pending) replies.push(await decide(deps, proposal, "approve"));
    const approved = replies.filter((r) => r.ok).length;
    return { ok: approved === pending.length, text: `Approved ${approved} of ${pending.length}.` };
}

async function decide(
    deps: Pick<AppDeps, "repos" | "clock" | "logger">,
    proposal: Proposal,
    action: ApprovalAction,
): Promise<ApprovalReply> {
    const { repos, clock, logger } = deps;
    const label = `${proposal.side} ${proposal.qty} ${proposal.ticker}`;
    if (clock.now() >= newYorkInstant(proposal.tradeDate, APPROVAL_DEADLINE)) {
        await repos.proposals.transition(proposal.id, ["pending"], "expired");
        if (proposal.status === "pending" || proposal.status === "expired") {
            return { ok: false, text: `Too late: ${label} expired at ${APPROVAL_DEADLINE} New York time.` };
        }
    }
    const target = action === "approve" ? "approved" : "rejected";
    if (await repos.proposals.transition(proposal.id, ["pending"], target)) {
        logger.info({ proposalId: proposal.id, status: target }, "proposal decided by owner");
        return { ok: true, text: `${action === "approve" ? "✅ Approved" : "❌ Rejected"}: ${label}.` };
    }
    const current = (await repos.proposals.get(proposal.id))?.status ?? proposal.status;
    return current === target
        ? { ok: true, text: `Already ${target}: ${label}.` }
        : { ok: false, text: `Cannot ${action} ${label}: it is ${current}.` };
}

/** 06:00 job: reminds the owner of proposals still waiting for approval today. */
export async function remindPending(deps: AppDeps): Promise<JobResult> {
    const today = tradingDateOf(deps.clock.now());
    return runJob(deps, "approval_reminder", today, async () => {
        const pending = await deps.repos.proposals.list({ tradeDate: today, statuses: ["pending"] });
        if (pending.length === 0) return skip("nothing pending");
        await deps.notifier.send(
            `⏰ ${pending.length} order${pending.length === 1 ? "" : "s"} still waiting for approval. ` +
                `They expire at ${APPROVAL_DEADLINE} New York time.`,
        );
        return undefined;
    });
}

/** Marks today's unapproved proposals as expired. Returns how many expired. */
export async function expirePending(deps: Pick<AppDeps, "repos" | "clock">): Promise<number> {
    const today = tradingDateOf(deps.clock.now());
    const pending = await deps.repos.proposals.list({ tradeDate: today, statuses: ["pending"] });
    let expired = 0;
    for (const proposal of pending) {
        if (await deps.repos.proposals.transition(proposal.id, ["pending"], "expired")) expired++;
    }
    return expired;
}
