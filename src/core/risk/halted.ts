import { accept, reject, type RiskRule } from "./types.js";

/** 1. A manual /stop or the daily loss stop blocks every new order. */
export const haltedRule: RiskRule = (_order, _portfolio, { halted }) => (halted ? reject("trading is halted") : accept);
