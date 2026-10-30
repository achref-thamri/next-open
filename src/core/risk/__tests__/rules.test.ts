import { describe, expect, it } from "vitest";
import { cents } from "../../money.js";
import { dailyCapsRule } from "../dailyCaps.js";
import { dailyLossBreached, dailyLossRule } from "../dailyLoss.js";
import { haltedRule } from "../halted.js";
import { longOnlyRule } from "../longOnly.js";
import { maxPositionRule } from "../maxPosition.js";
import { maxPositionsRule } from "../maxPositions.js";
import { minCashRule } from "../minCash.js";
import { universeRule } from "../universe.js";
import { context, EQUITY, order, portfolio, security } from "./fixtures.js";

const accept = { kind: "accept" };

describe("haltedRule", () => {
    it("rejects every order when halted", () => {
        expect(haltedRule(order("AAA", "sell", 1), portfolio(), context({ halted: true }))).toEqual({
            kind: "reject",
            reason: "trading is halted",
        });
        expect(haltedRule(order("AAA", "buy", 1), portfolio(), context())).toEqual(accept);
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

    it("never triggers without a previous close", () => {
        expect(dailyLossBreached(cents(0), cents(0), 0.03)).toBe(false);
    });
});
