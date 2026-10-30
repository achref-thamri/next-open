import { filterUniverse } from "../universe/filters.js";
import { accept, reject, type RiskRule } from "./types.js";

/** 2. Buys must still pass the universe filters. Sells are always allowed so a position can be exited. */
export const universeRule: RiskRule = (order, _portfolio, { securities, universeLimits }) => {
    if (order.side === "sell") return accept;
    const security = securities.get(order.ticker);
    if (security === undefined) return reject(`no market data for ${order.ticker}`);
    const result = filterUniverse(security, universeLimits);
    return result.pass ? accept : reject(`outside the universe: ${result.reason}`);
};
