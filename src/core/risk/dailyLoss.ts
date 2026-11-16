import { shortPercent } from "../format.js";
import { multiplyCents, type Cents } from "../money.js";
import { accept, reject, type RiskRule } from "./types.js";

/** True when equity is down by at least the daily loss stop versus the previous close. */
export function dailyLossBreached(equity: Cents, previousCloseEquity: Cents, stopPct: number): boolean {
    return previousCloseEquity > 0 && previousCloseEquity - equity >= multiplyCents(previousCloseEquity, stopPct);
}

/** Equity down by the daily loss stop or more: reject buys (sells only lower the risk); the pipeline sets the halt. */
export const dailyLossRule: RiskRule = (order, _portfolio, { account, limits }) =>
    order.side === "buy" && dailyLossBreached(account.equity, account.previousCloseEquity, limits.dailyLossStopPct)
        ? reject(
              `daily loss stop: equity down ${shortPercent(limits.dailyLossStopPct)} or more since the previous close`,
          )
        : accept;
