import { cents, formatCents } from "../core/money.js";
import { haltOf, LOSS_STOP_REASON, runRiskChecks, simulatePortfolio, type OrderRequest } from "../core/risk/index.js";
import { bracketPrices } from "../core/sizing.js";
import { tradingDateOf, type OrderIntent, type Proposal, type Ticker, type TradingDate } from "../core/types.js";
import type { SecurityFacts } from "../core/universe/filters.js";
import { PermanentError } from "../lib/errors.js";
import { clientOrderId } from "../lib/ids.js";
import type { BrokerOrder } from "../ports/broker.js";
import type { OrderRecord } from "../ports/repositories.js";
import { tradingDays } from "./calendar.js";
import type { AppDeps } from "./deps.js";
import { expirePending } from "./handleApproval.js";
import { runJob, skip, type JobResult } from "./runJob.js";
import { syncBroker } from "./sync.js";

/**
 * The open job: expire unapproved proposals → sync → re-run the risk checks against the live
 * account → place orders, sells first, with a stable client order id → store → notify.
 *
 * Safe to rerun after a crash: a proposal whose order already exists at the broker is recorded, not resent.
 */
export async function executeAtOpen(deps: AppDeps): Promise<JobResult> {
    const today = tradingDateOf(deps.clock.now());
    return runJob(deps, "execute_at_open", today, async () => {
        const days = await tradingDays(deps.broker, today);
        if (!days.today) return skip(`${today} is not a trading day`);
        return execute(deps, today);
    });
}

async function execute(deps: AppDeps, today: TradingDate): Promise<JobResult | undefined> {
    const { broker, repos, notifier, config } = deps;
    const lines: string[] = [];

    const expired = await expirePending(deps);
    if (expired > 0) lines.push(`⌛ ${expired} unapproved order${expired === 1 ? "" : "s"} expired.`);

    if (config.mode === "live" && !(await repos.settings.get()).liveConfirmed) {
        throw new Error("live mode is not confirmed; send /golive once the go-live gate passes");
    }
    await broker.verifyAccountSafety();
    const { account, positions } = await syncBroker(deps);
    const approved = await repos.proposals.list({ tradeDate: today, statuses: ["approved"] });

    // Orders that reached the broker before a crash: record them instead of checking and placing again.
    const remaining: Proposal[] = [];
    for (const proposal of approved) {
        const existing = await broker.getOrderByClientId(clientOrderId(proposal.id));
        if (existing) await recordPlaced(deps, proposal, existing, today);
        else remaining.push(proposal);
    }
    if (remaining.length === 0) {
        if (lines.length > 0) await notifier.send(lines.join("\n"));
        return skip(approved.length === 0 ? "no approved proposals" : "every approved order was already placed");
    }

    const openOrders = await broker.listOpenOrders();
    const placedToday = await repos.orders.list({ tradeDate: today });
    const start = simulatePortfolio(account, positions, {
        orders: placedToday.filter((orderRecord) => orderRecord.role === "entry" || orderRecord.role === "exit").length,
        traded: placedToday.reduce((sum, orderRecord) => sum + orderRecord.qty * (orderRecord.limitPrice ?? 0), 0),
    });
    const openBuys = openOrders
        .filter((brokerOrder) => brokerOrder.role === "entry")
        .reduce(
            (sum, brokerOrder) => sum + (brokerOrder.qty - brokerOrder.filledQty) * (brokerOrder.limitPrice ?? 0),
            0,
        );

    const settings = await repos.settings.get();
    const candidates = await latestSecurities(
        deps,
        remaining.map((proposal) => proposal.ticker),
    );
    const result = runRiskChecks(
        remaining.map((proposal): OrderRequest => ({
            id: proposal.id,
            ticker: proposal.ticker,
            side: proposal.side,
            qty: proposal.qty,
            limitPrice: proposal.limitPrice,
            stopLossPct: proposal.stopLossPct,
        })),
        { ...start, cash: cents(start.cash - openBuys) },
        {
            limits: config.risk,
            universeLimits: config.universe,
            halted: haltOf(settings),
            account,
            securities: candidates,
        },
    );
    if (result.halt && !settings.halted) {
        await repos.settings.update({ halted: true, haltReason: LOSS_STOP_REASON });
        lines.push("🛑 Daily loss stop hit: no new buys until you send /resume. Sells still go through.");
    }

    const byId = new Map(remaining.map((proposal) => [proposal.id, proposal]));
    const heldQty = new Map(positions.map((position) => [position.ticker, position.qty]));
    let errors = 0;
    for (const checked of result.orders) {
        const proposal = byId.get(checked.order.id);
        if (!proposal) continue;
        if (checked.qty === 0) {
            await repos.proposals.updateRisk(proposal.id, 0, [...proposal.riskNotes, ...checked.notes]);
            await repos.proposals.transition(proposal.id, ["approved"], "rejected");
            lines.push(`⛔ ${proposal.side} ${proposal.ticker} not placed: ${checked.notes.join("; ")}`);
            continue;
        }
        const qty = checked.qty;
        if (qty < proposal.qty) {
            await repos.proposals.updateRisk(proposal.id, qty, [...proposal.riskNotes, ...checked.notes]);
            lines.push(
                `✂️ ${proposal.side} ${proposal.ticker} trimmed from ${proposal.qty} to ${qty}: ${checked.notes.join("; ")}`,
            );
        }
        // One order's error must not stop the others or hide the ones already placed from the summary.
        try {
            const placed = await place(
                deps,
                { ...proposal, qty },
                openOrders,
                heldQty.get(proposal.ticker) ?? 0,
                today,
            );
            lines.push(placed.line);
            if (placed.error) errors++;
        } catch (error) {
            errors++;
            deps.logger.error({ err: error, proposal: proposal.id }, "order handling failed");
            lines.push(
                `⚠️ ${proposal.side} ${proposal.ticker} hit an error: ${messageOf(error)}. Check the broker before acting.`,
            );
        }
    }

    await notifier.send([`Orders for ${today}:`, ...lines].join("\n"));
    // The summary above already told the owner, so the run is marked failed without a second alert.
    if (errors > 0) return { status: "failed", message: `${errors} of ${result.orders.length} orders hit an error` };
    return undefined;
}

/**
 * Places one order, cancelling the position's bracket legs first for a sell (they reserve the shares). Broker
 * errors become a line for the summary; `error` marks one that was neither placed nor refused.
 */
async function place(
    deps: AppDeps,
    proposal: Proposal,
    openOrders: BrokerOrder[],
    held: number,
    today: TradingDate,
): Promise<{ line: string; error?: true }> {
    const { broker, repos, logger } = deps;
    const intent = orderIntent(proposal);
    const label = `${proposal.side} ${proposal.ticker}`;
    let legsCancelled = false;
    let order: BrokerOrder | undefined;
    try {
        if (proposal.side === "sell") {
            const legs = openOrders
                .filter((brokerOrder) => brokerOrder.ticker === proposal.ticker)
                .flatMap((brokerOrder) => [brokerOrder, ...brokerOrder.legs])
                .filter((brokerOrder) => brokerOrder.role === "stop_loss" || brokerOrder.role === "take_profit");
            for (const leg of legs) {
                await broker.cancelOrder(leg.id);
                legsCancelled = true;
            }
        }
        order = await broker.placeOrder(intent);
    } catch (error) {
        const unprotected = legsCancelled
            ? `\n   ⚠️ ${proposal.ticker} now has no stop-loss or take-profit: set one by hand at the broker.`
            : "";
        if (error instanceof PermanentError) {
            await repos.proposals.updateRisk(proposal.id, proposal.qty, [
                ...proposal.riskNotes,
                `broker refused: ${error.message}`,
            ]);
            await repos.proposals.transition(proposal.id, ["approved"], "rejected");
            return { line: `⛔ ${label} refused by the broker: ${error.message}${unprotected}` };
        }
        // A timeout or 5xx can still have reached the broker; the stable client order id tells.
        order = await broker.getOrderByClientId(intent.clientOrderId).catch(() => undefined);
        if (!order) {
            logger.error({ err: error, proposal: proposal.id }, "order not placed");
            return { line: `⚠️ ${label} not placed: ${messageOf(error)}${unprotected}`, error: true };
        }
    }
    await recordPlaced(deps, proposal, order, today);
    const note = legsCancelled && held > proposal.qty ? " (the remaining shares no longer have a stop-loss)" : "";
    return {
        line: `${proposal.side === "buy" ? "🟢" : "🔴"} ${proposal.side} ${proposal.qty} ${proposal.ticker} at ${proposal.side === "buy" ? "≤" : "≥"} ${formatCents(proposal.limitPrice)}${note}`,
    };
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function orderIntent(proposal: Proposal): OrderIntent {
    const legs =
        proposal.side === "buy" && proposal.stopLossPct !== undefined && proposal.takeProfitPct !== undefined
            ? bracketPrices(proposal.previousClose, proposal.limitPrice, proposal.stopLossPct, proposal.takeProfitPct)
            : undefined;
    return {
        clientOrderId: clientOrderId(proposal.id),
        ticker: proposal.ticker,
        side: proposal.side,
        qty: proposal.qty,
        limitPrice: proposal.limitPrice,
        stopLossPrice: legs?.stopLossPrice,
        takeProfitPrice: legs?.takeProfitPrice,
    };
}

async function recordPlaced(deps: AppDeps, proposal: Proposal, order: BrokerOrder, today: TradingDate): Promise<void> {
    await deps.repos.orders.upsert(toOrderRecord(order, proposal.id, today, deps.clock.now()));
    await deps.repos.proposals.transition(proposal.id, ["approved"], "executed");
}

export function toOrderRecord(
    order: BrokerOrder,
    proposalId: string | undefined,
    tradeDate: TradingDate,
    now: Date,
): OrderRecord {
    return {
        clientOrderId: order.clientOrderId,
        brokerOrderId: order.id,
        proposalId,
        tradeDate,
        ticker: order.ticker,
        side: order.side,
        role: order.role,
        qty: order.qty,
        filledQty: order.filledQty,
        filledAvgPrice: order.filledAvgPrice,
        limitPrice: order.limitPrice,
        status: order.status,
        submittedAt: order.submittedAt,
        updatedAt: now,
    };
}

/**
 * Universe facts for the tickers being bought, from the evening run's stored candidates, so the universe rule
 * sees the same data the proposal was made with.
 */
async function latestSecurities(deps: AppDeps, tickers: Ticker[]): Promise<Map<Ticker, SecurityFacts>> {
    const { repos, clock } = deps;
    const today = tradingDateOf(clock.now());
    const proposals = await repos.proposals.list({ tradeDate: today });
    const runIds = [...new Set(proposals.map((proposal) => proposal.runId))];
    const securities = new Map<Ticker, SecurityFacts>();
    for (const runId of runIds) {
        for (const record of await repos.candidates.listByRun(runId)) {
            if (tickers.includes(record.candidate.ticker)) securities.set(record.candidate.ticker, record.candidate);
        }
    }
    return securities;
}
