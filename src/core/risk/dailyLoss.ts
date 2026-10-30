import { multiplyCents, type Cents } from "../money.js";
import { accept, pct, reject, type RiskRule } from "./types.js";

/** True when equity is down by at least the daily loss stop versus the previous close. */
export function dailyLossBreached(equity: Cents, previousCloseEquity: Cents, stopPct: number): boolean {
    return previousCloseEquity > 0 && previousCloseEquity - equity >= multiplyCents(previousCloseEquity, stopPct);
}

/** 7. Equity down by the daily loss stop or more: reject, and the pipeline sets the halt flag. */
export const dailyLossRule: RiskRule = (_order, _portfolio, { account, limits }) =>
    dailyLossBreached(account.equity, account.previousCloseEquity, limits.dailyLossStopPct)
        ? reject(`daily loss stop: equity down ${pct(limits.dailyLossStopPct)} or more since the previous close`)
        : accept;
