import { shortPercent } from "../format.js";
import { formatCents, multiplyCents } from "../money.js";
import { accept, trimToBudget, type RiskRule } from "./types.js";

/** Buys may not take cash below the min cash weight of equity. */
export const minCashRule: RiskRule = (order, { cash }, { account, limits }) => {
    if (order.side === "sell") return accept;
    const floor = multiplyCents(account.equity, limits.minCashWeight, "up");
    return trimToBudget(
        order,
        cash - floor,
        `cash kept at ${shortPercent(limits.minCashWeight)} of equity (${formatCents(floor)})`,
    );
};
