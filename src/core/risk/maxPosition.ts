import { shortPercent } from "../format.js";
import { formatCents, multiplyCents } from "../money.js";
import { accept, trimToBudget, type RiskRule } from "./types.js";

/** A position may not exceed the max weight of equity after the buy. */
export const maxPositionRule: RiskRule = (order, { holdings }, { account, limits }) => {
    if (order.side === "sell") return accept;
    const cap = multiplyCents(account.equity, limits.maxPositionWeight, "down");
    const held = (holdings.get(order.ticker) ?? 0) * order.limitPrice;
    return trimToBudget(
        order,
        cap - held,
        `position capped at ${shortPercent(limits.maxPositionWeight)} of equity (${formatCents(cap)})`,
    );
};
