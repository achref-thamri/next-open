import { shortPercent } from "../format.js";
import { formatCents, multiplyCents } from "../money.js";
import { reject, trimToBudget, type RiskRule } from "./types.js";

/** At most a fixed number of orders and a fixed share of equity traded per day, buys and sells alike. */
export const dailyCapsRule: RiskRule = (order, { ordersToday, tradedToday }, { account, limits }) => {
    if (ordersToday >= limits.maxOrdersPerDay) return reject(`daily limit of ${limits.maxOrdersPerDay} orders reached`);
    const cap = multiplyCents(account.equity, limits.maxDailyTradedWeight, "down");
    return trimToBudget(
        order,
        cap - tradedToday,
        `daily traded value capped at ${shortPercent(limits.maxDailyTradedWeight)} of equity (${formatCents(cap)})`,
    );
};
