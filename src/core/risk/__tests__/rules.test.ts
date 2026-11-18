import { describe, expect, it } from "vitest";
import { cents } from "../../money.js";
import { dailyCapsRule } from "../dailyCaps.js";
import { dailyLossBreached, dailyLossRule } from "../dailyLoss.js";
import { haltedRule, haltOf } from "../halted.js";
import { longOnlyRule } from "../longOnly.js";
import { maxPositionRule } from "../maxPosition.js";
import { maxPositionsRule } from "../maxPositions.js";
import { minCashRule } from "../minCash.js";
import { riskPerTradeRule } from "../riskPerTrade.js";
import { universeRule } from "../universe.js";
import { context, EQUITY, order, portfolio, security } from "./fixtures.js";

const accept = { kind: "accept" };

describe("haltedRule", () => {
    it("rejects every order after a manual /stop", () => {
        for (const side of ["buy", "sell"] as const) {
            expect(haltedRule(order("AAA", side, 1), portfolio(), context({ halted: "manual" }))).toEqual({
                kind: "reject",
                reason: "trading is halted",
            });
        }
        expect(haltedRule(order("AAA", "buy", 1), portfolio(), context())).toEqual(accept);
    });

    it("lets sells through after the daily loss stop, since they only lower the risk", () => {
        const halted = context({ halted: "loss_stop" });
        expect(haltedRule(order("AAA", "sell", 1), portfolio(), halted)).toEqual(accept);
        expect(haltedRule(order("AAA", "buy", 1), portfolio(), halted)).toEqual({
            kind: "reject",
            reason: "trading is halted by the daily loss stop; only sells go through",
        });
    });
});

describe("haltOf", () => {
    it("tells the daily loss stop from a manual halt, and treats anything unknown as manual", () => {
        expect(haltOf({ halted: false, haltReason: undefined })).toBe(false);
        expect(haltOf({ halted: true, haltReason: "daily loss stop" })).toBe("loss_stop");
        expect(haltOf({ halted: true, haltReason: "daily loss stop on 2026-11-16" })).toBe("loss_stop");
        expect(haltOf({ halted: true, haltReason: "manual /stop" })).toBe("manual");
        expect(haltOf({ halted: true, haltReason: undefined })).toBe("manual");
    });
});

describe("longOnlyRule", () => {
    it("allows selling up to the shares held", () => {
        expect(longOnlyRule(order("AAA", "sell", 10), portfolio({ holdings: { AAA: 10 } }), context())).toEqual(accept);
    });

    it("trims a sell above the shares held", () => {
        expect(longOnlyRule(order("AAA", "sell", 11), portfolio({ holdings: { AAA: 10 } }), context())).toEqual({
            kind: "trim",
            qty: 10,
            reason: "only 10 shares held",
        });
    });

    it("rejects a sell of a ticker not held", () => {
        expect(longOnlyRule(order("AAA", "sell", 1), portfolio(), context()).kind).toBe("reject");
    });

    it("ignores buys", () => {
        expect(longOnlyRule(order("AAA", "buy", 1), portfolio(), context())).toEqual(accept);
    });
});

describe("universeRule", () => {
    it("accepts a buy that passes the filters", () => {
        expect(universeRule(order("AAA", "buy", 1), portfolio(), context())).toEqual(accept);
    });

    it("rejects a buy that no longer passes", () => {
        const ctx = context({
            securities: new Map([[security("AAA").ticker, security("AAA", { close: cents(499) })]]),
        });

        expect(universeRule(order("AAA", "buy", 1), portfolio(), ctx)).toEqual({
            kind: "reject",
            reason: "outside the universe: price $4.99 below $5",
        });
    });

    it("rejects a buy without market data", () => {
        expect(universeRule(order("ZZZ", "buy", 1), portfolio(), context()).kind).toBe("reject");
    });

    it("always allows sells so positions can be exited", () => {
        expect(universeRule(order("ZZZ", "sell", 1), portfolio(), context())).toEqual(accept);
    });
});

describe("maxPositionRule", () => {
    // cap: 10% of $100,000 = $10,000 = 100 shares at $100
    it("accepts a buy exactly at the cap", () => {
        expect(maxPositionRule(order("AAA", "buy", 100), portfolio(), context())).toEqual(accept);
    });

    it("trims a buy one share above the cap", () => {
        expect(maxPositionRule(order("AAA", "buy", 101), portfolio(), context())).toEqual({
            kind: "trim",
            qty: 100,
            reason: "position capped at 10% of equity ($10,000.00)",
        });
    });

    it("counts shares already held", () => {
        expect(maxPositionRule(order("AAA", "buy", 50), portfolio({ holdings: { AAA: 60 } }), context())).toMatchObject(
            { kind: "trim", qty: 40 },
        );
    });

    it("rejects when the position is already at the cap", () => {
        expect(maxPositionRule(order("AAA", "buy", 1), portfolio({ holdings: { AAA: 100 } }), context()).kind).toBe(
            "reject",
        );
    });

    it("ignores sells", () => {
        expect(maxPositionRule(order("AAA", "sell", 500), portfolio({ holdings: { AAA: 500 } }), context())).toEqual(
            accept,
        );
    });
});

describe("maxPositionsRule", () => {
    const fourteen = Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`H${i}`, 1]));
    const fifteen = { ...fourteen, H14: 1 };

    it("accepts a new position below the max", () => {
        expect(maxPositionsRule(order("AAA", "buy", 1), portfolio({ holdings: fourteen }), context())).toEqual(accept);
    });

    it("rejects a new position at the max", () => {
        expect(maxPositionsRule(order("AAA", "buy", 1), portfolio({ holdings: fifteen }), context())).toEqual({
            kind: "reject",
            reason: "already holding 15 positions",
        });
    });

    it("allows adding to a held position at the max", () => {
        expect(maxPositionsRule(order("H3", "buy", 1), portfolio({ holdings: fifteen }), context())).toEqual(accept);
    });
});

describe("minCashRule", () => {
    // floor: 10% of $100,000 = $10,000
    it("accepts a buy that leaves exactly the min cash", () => {
        expect(minCashRule(order("AAA", "buy", 100), portfolio({ cash: cents(2_000_000) }), context())).toEqual(accept);
    });

    it("trims a buy that would dip below the min cash", () => {
        expect(minCashRule(order("AAA", "buy", 101), portfolio({ cash: cents(2_000_000) }), context())).toEqual({
            kind: "trim",
            qty: 100,
            reason: "cash kept at 10% of equity ($10,000.00)",
        });
    });

    it("rejects a buy when cash is already at the floor", () => {
        expect(minCashRule(order("AAA", "buy", 1), portfolio({ cash: cents(1_000_000) }), context()).kind).toBe(
            "reject",
        );
    });

    it("ignores sells", () => {
        expect(minCashRule(order("AAA", "sell", 1), portfolio({ cash: cents(0) }), context())).toEqual(accept);
    });
});

describe("dailyCapsRule", () => {
    it("accepts the 10th order and rejects the 11th", () => {
        expect(dailyCapsRule(order("AAA", "buy", 1), portfolio({ ordersToday: 9 }), context())).toEqual(accept);
        expect(dailyCapsRule(order("AAA", "buy", 1), portfolio({ ordersToday: 10 }), context())).toEqual({
            kind: "reject",
            reason: "daily limit of 10 orders reached",
        });
    });

    // cap: 30% of $100,000 = $30,000
    it("accepts value up to the traded cap and trims beyond it", () => {
        const traded = portfolio({ tradedToday: cents(2_000_000) });

        expect(dailyCapsRule(order("AAA", "sell", 100), traded, context())).toEqual(accept);
        expect(dailyCapsRule(order("AAA", "sell", 101), traded, context())).toEqual({
            kind: "trim",
            qty: 100,
            reason: "daily traded value capped at 30% of equity ($30,000.00)",
        });
    });

    it("rejects when the traded cap is used up", () => {
        expect(
            dailyCapsRule(order("AAA", "buy", 1), portfolio({ tradedToday: cents(3_000_000) }), context()).kind,
        ).toBe("reject");
    });
});

describe("dailyLossRule", () => {
    const withEquity = (equity: number) =>
        context({ account: { equity: cents(equity), cash: cents(0), previousCloseEquity: EQUITY } });

    it("accepts just above the -3% stop and rejects at it", () => {
        expect(dailyLossRule(order("AAA", "buy", 1), portfolio(), withEquity(9_700_001))).toEqual(accept);
        expect(dailyLossRule(order("AAA", "buy", 1), portfolio(), withEquity(9_700_000)).kind).toBe("reject");
    });

    it("lets sells through at the stop", () => {
        expect(dailyLossRule(order("AAA", "sell", 1), portfolio(), withEquity(9_000_000))).toEqual(accept);
    });

    it("never triggers without a previous close", () => {
        expect(dailyLossBreached(cents(0), cents(0), 0.03)).toBe(false);
    });
});

describe("riskPerTradeRule", () => {
    // 2% of $100,000 = $2,000 at risk; with a 10% stop that's a $20,000 position = 200 shares at $100.
    const withStop = (qty: number, stopLossPct: number | undefined) => ({ ...order("AAA", "buy", qty), stopLossPct });

    it("accepts a buy whose loss at the stop stays within the limit", () => {
        expect(riskPerTradeRule(withStop(200, 0.1), portfolio(), context())).toEqual(accept);
    });

    it("trims a buy with a wide stop to a smaller position", () => {
        expect(riskPerTradeRule(withStop(200, 0.2), portfolio(), context())).toEqual({
            kind: "trim",
            qty: 100,
            reason: "at most 2% of equity ($2,000.00) lost at the 20% stop-loss",
        });
    });

    it("counts the shares already held", () => {
        expect(riskPerTradeRule(withStop(100, 0.2), portfolio({ holdings: { AAA: 50 } }), context())).toMatchObject({
            kind: "trim",
            qty: 50,
        });
    });

    it("leaves sells and buys without a stop alone", () => {
        expect(riskPerTradeRule(order("AAA", "sell", 1000), portfolio({ holdings: { AAA: 1000 } }), context())).toEqual(
            accept,
        );
        expect(riskPerTradeRule(withStop(1000, undefined), portfolio(), context())).toEqual(accept);
    });
});
