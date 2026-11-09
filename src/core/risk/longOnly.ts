import { accept, reject, type RiskRule } from "./types.js";

/** Sells never exceed the shares held, so the account can never go short. */
export const longOnlyRule: RiskRule = (order, { holdings }) => {
    if (order.side === "buy") return accept;
    const held = holdings.get(order.ticker) ?? 0;
    if (held === 0) return reject(`no ${order.ticker} shares held to sell`);
    return order.qty > held ? { kind: "trim", qty: held, reason: `only ${held} shares held` } : accept;
};
