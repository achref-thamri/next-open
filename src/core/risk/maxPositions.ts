import { accept, reject, type RiskRule } from "./types.js";

/** 4. A buy that opens a new position is rejected when the max number of positions is held. */
export const maxPositionsRule: RiskRule = (order, { holdings }, { limits }) => {
    if (order.side === "sell" || holdings.has(order.ticker)) return accept;
    return holdings.size >= limits.maxPositions ? reject(`already holding ${limits.maxPositions} positions`) : accept;
};
