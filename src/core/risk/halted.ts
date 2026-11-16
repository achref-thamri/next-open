import { accept, reject, type Halt, type RiskRule } from "./types.js";

/** The halt reason stored by the daily loss stop; `recordEndOfDay` adds " on <date>". */
export const LOSS_STOP_REASON = "daily loss stop";

/** Which halt is on. Anything but the daily loss stop counts as manual, the stricter of the two. */
export function haltOf(settings: { halted: boolean; haltReason: string | undefined }): Halt {
    if (!settings.halted) return false;
    return settings.haltReason?.startsWith(LOSS_STOP_REASON) ? "loss_stop" : "manual";
}

/**
 * A manual /stop blocks every new order. The daily loss stop blocks buys only: a sell can only lower the money at
 * risk, and blocking it would keep the account in a falling position until /resume.
 */
export const haltedRule: RiskRule = (order, _portfolio, { halted }) => {
    if (halted === "manual") return reject("trading is halted");
    if (halted === "loss_stop" && order.side === "buy") {
        return reject("trading is halted by the daily loss stop; only sells go through");
    }
    return accept;
};
