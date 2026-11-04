import { formatCents } from "../core/money.js";
import { isTicker, tradingDateOf } from "../core/types.js";
import type { AppDeps } from "./deps.js";
import { performance, reportText } from "./report.js";
import { withComparison } from "./strategyReport.js";
import { syncBroker } from "./sync.js";

export const HELP = `Commands:
/status: account, positions and state
/stop: halt trading and cancel open entry and exit orders (stop-losses stay)
/resume: allow trading again
/report: performance vs benchmark and the go-live gate
/why TICKER: the latest reasoning for a ticker
/golive: confirm live trading (live mode only, gate must pass)`;

const pct = (fraction: number) => `${fraction >= 0 ? "+" : ""}${(fraction * 100).toFixed(1)}%`;

/** Handles one owner command and returns the reply. Messages from any other chat get no reply. */
export async function handleCommand(
    deps: AppDeps,
    message: { chatId: number; text: string },
): Promise<string | undefined> {
    if (message.chatId !== deps.config.ownerChatId) return undefined;
    const [command = "", ...args] = message.text.trim().split(/\s+/);
    switch (command.toLowerCase().replace(/@.*$/, "")) {
        case "/status":
            return status(deps);
        case "/stop":
            return stop(deps);
        case "/resume":
            return resume(deps);
        case "/report":
            return withComparison(deps, reportText(await performance(deps, (await syncBroker(deps)).positions)));
        case "/why":
            return why(deps, args[0]);
        case "/golive":
            return goLive(deps);
        default:
            return HELP;
    }
}

async function status(deps: AppDeps): Promise<string> {
    const { account, positions } = await syncBroker(deps);
    const settings = await deps.repos.settings.get();
    const openOrders = await deps.broker.listOpenOrders();
    const pending = await deps.repos.proposals.list({ statuses: ["pending"] });
    const lines = [
        `Mode: ${deps.config.mode}${deps.config.mode === "live" && !settings.liveConfirmed ? " (not confirmed, send /golive)" : ""}`,
        `Trading: ${settings.halted ? `⛔ halted (${settings.haltReason ?? "no reason"})` : "✅ active"}`,
        `Equity ${formatCents(account.equity)} · cash ${formatCents(account.cash)} · today ${pct(account.previousCloseEquity > 0 ? account.equity / account.previousCloseEquity - 1 : 0)}`,
        positions.length === 0 ? "No positions." : `Positions (${positions.length}):`,
        ...positions.map(
            (p) =>
                `• ${p.ticker} ${p.qty} @ ${formatCents(p.avgEntryPrice)} → ${formatCents(p.currentPrice)} (${pct(p.avgEntryPrice > 0 ? p.currentPrice / p.avgEntryPrice - 1 : 0)})`,
        ),
        `Open orders: ${openOrders.length} · pending approvals: ${pending.length}`,
    ];
    return lines.join("\n");
}

/** Halts trading and cancels open entries and exits. Protective bracket legs stay; nothing is sold. */
async function stop(deps: AppDeps): Promise<string> {
    await deps.repos.settings.update({ halted: true, haltReason: "manual /stop" });
    const open = await deps.broker.listOpenOrders();
    const toCancel = open.filter((o) => (o.role === "entry" || o.role === "exit") && o.filledQty < o.qty);
    for (const order of toCancel) await deps.broker.cancelOrder(order.id);
    deps.logger.warn({ cancelled: toCancel.length }, "trading halted by owner");
    return `⛔ Trading halted. Cancelled ${toCancel.length} open order${toCancel.length === 1 ? "" : "s"}; stop-losses stay in place. Send /resume to start again.`;
}

async function resume(deps: AppDeps): Promise<string> {
    const settings = await deps.repos.settings.get();
    if (!settings.halted) return "Trading is already active.";
    await deps.repos.settings.update({ halted: false, haltReason: undefined });
    deps.logger.warn("trading resumed by owner");
    return "✅ Trading resumed from the next run.";
}

async function why(deps: AppDeps, raw: string | undefined): Promise<string> {
    const ticker = raw?.toUpperCase();
    if (!ticker || !isTicker(ticker)) return "Usage: /why TICKER";
    const decision = await deps.repos.decisions.latestForTicker(ticker);
    if (!decision) return `No decisions for ${ticker} yet.`;
    return [
        `${ticker} on ${decision.tradeDate}: ${decision.action} to ${(decision.targetWeight * 100).toFixed(1)}% of equity, confidence ${decision.confidence}/5`,
        `Stop −${(decision.stopLossPct * 100).toFixed(1)}% · target +${(decision.takeProfitPct * 100).toFixed(1)}% · horizon ${decision.horizonDays} days`,
        decision.reasoning,
    ].join("\n");
}

/** Live trading needs TRADING_MODE=live and a passing go-live gate; this records the owner's confirmation. */
async function goLive(deps: AppDeps): Promise<string> {
    if (deps.config.mode !== "live") {
        return "Refused: the bot runs in paper mode. Set TRADING_MODE=live with live keys and restart first.";
    }
    const settings = await deps.repos.settings.get();
    if (settings.liveConfirmed) return "Live trading is already confirmed.";
    const perf = await performance(deps, (await syncBroker(deps)).positions);
    if (!perf.gate.pass) return `Refused: the go-live gate has not passed.\n\n${reportText(perf)}`;
    await deps.repos.settings.update({ liveConfirmed: true });
    deps.logger.warn({ date: tradingDateOf(deps.clock.now()) }, "live trading confirmed by owner");
    return "✅ Live trading confirmed. Orders still need your approval each evening.";
}
