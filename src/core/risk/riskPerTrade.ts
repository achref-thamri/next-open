import { shortPercent } from "../format.js";
import { formatCents, multiplyCents } from "../money.js";
import { accept, trimToBudget, type RiskRule } from "./types.js";

/**
 * A buy may not put more than a fixed share of equity at risk: the whole position times its stop-loss distance.
 * A stock with a wide stop gets a smaller position, so every position loses about the same at its stop.
 */
export const riskPerTradeRule: RiskRule = (order, { holdings }, { account, limits }) => {
    if (order.side === "sell" || order.stopLossPct === undefined) return accept;
    const maxLoss = multiplyCents(account.equity, limits.maxRiskPerTradePct, "down");
    const held = (holdings.get(order.ticker) ?? 0) * order.limitPrice;
    return trimToBudget(
        order,
        maxLoss / order.stopLossPct - held,
        `at most ${shortPercent(limits.maxRiskPerTradePct)} of equity (${formatCents(maxLoss)}) lost at the ` +
            `${shortPercent(order.stopLossPct)} stop-loss`,
    );
};
