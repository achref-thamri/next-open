import { describe, expect, it } from "vitest";
import { cents } from "../../money.js";
import { toTicker, type Position } from "../../types.js";
import { runRiskChecks, simulatePortfolio, type RiskRule } from "../index.js";
import { context, EQUITY, order, portfolio } from "./fixtures.js";

describe("runRiskChecks", () => {
    it("accepts orders within every limit and updates the simulated portfolio", () => {
        const result = runRiskChecks([order("AAA", "buy", 50)], portfolio(), context());

        expect(result.orders).toEqual([{ order: order("AAA", "buy", 50), qty: 50, status: "accepted", notes: [] }]);
        expect(result.halt).toBe(false);
        expect(result.portfolio.cash).toBe(4_500_000);
        expect(result.portfolio.holdings.get(toTicker("AAA"))).toBe(50);
        expect(result.portfolio.ordersToday).toBe(1);
        expect(result.portfolio.tradedToday).toBe(500_000);
    });

    it("processes sells before buys", () => {
        const result = runRiskChecks(
            [order("AAA", "buy", 1), order("BBB", "sell", 1), order("CCC", "buy", 1)],
            portfolio({ holdings: { BBB: 1 } }),
            context(),
        );

        expect(result.orders.map((o) => o.order.id)).toEqual(["sell-BBB", "buy-AAA", "buy-CCC"]);
    });

    it("lets a sell free a slot for a buy", () => {
        const full = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`H${i}`, 1]));

        const blocked = runRiskChecks([order("AAA", "buy", 1)], portfolio({ holdings: full }), context());
        const freed = runRiskChecks(
            [order("AAA", "buy", 1), order("H0", "sell", 1)],
            portfolio({ holdings: full }),
            context(),
        );

        expect(blocked.orders[0]?.status).toBe("rejected");
        expect(freed.orders.map((o) => o.status)).toEqual(["accepted", "accepted"]);
    });

    it("lets sell proceeds fund a buy above the cash floor", () => {
        // $10,000 cash is exactly the floor; selling 50 × $100 frees $5,000
        const start = portfolio({ cash: cents(1_000_000), holdings: { BBB: 50 } });

        const result = runRiskChecks([order("AAA", "buy", 80), order("BBB", "sell", 50)], start, context());

        expect(result.orders.map((o) => [o.order.id, o.qty])).toEqual([
            ["sell-BBB", 50],
            ["buy-AAA", 50],
        ]);
        expect(result.portfolio.cash).toBe(1_000_000);
        expect(result.portfolio.holdings.has(toTicker("BBB"))).toBe(false);
    });

    it("carries the portfolio forward so later buys see earlier ones", () => {
        // $15,000 above the cash floor: the first buy takes $10,000, the second only gets $5,000
        const start = portfolio({ cash: cents(2_500_000) });

        const result = runRiskChecks([order("AAA", "buy", 100), order("BBB", "buy", 100)], start, context());

        expect(result.orders.map((o) => [o.status, o.qty])).toEqual([
            ["accepted", 100],
            ["trimmed", 50],
        ]);
    });

    it("applies trims in rule order and records every reason", () => {
        // 150 shares: max position trims to 100, then min cash trims to 60
        const result = runRiskChecks([order("AAA", "buy", 150)], portfolio({ cash: cents(1_600_000) }), context());

        expect(result.orders[0]).toMatchObject({
            qty: 60,
            status: "trimmed",
            notes: ["position capped at 10% of equity ($10,000.00)", "cash kept at 10% of equity ($10,000.00)"],
        });
    });

    it("stops at the first reject and keeps earlier trim notes", () => {
        const result = runRiskChecks([order("AAA", "buy", 150)], portfolio({ cash: cents(1_000_000) }), context());

        expect(result.orders[0]).toEqual({
            order: order("AAA", "buy", 150),
            qty: 0,
            status: "rejected",
            notes: ["position capped at 10% of equity ($10,000.00)", "cash kept at 10% of equity ($10,000.00)"],
        });
        expect(result.portfolio.ordersToday).toBe(0);
    });

    it("rejects everything when halted", () => {
        const result = runRiskChecks(
            [order("AAA", "sell", 1), order("BBB", "buy", 1)],
            portfolio({ holdings: { AAA: 1 } }),
            context({ halted: true }),
        );

        expect(result.orders.every((o) => o.status === "rejected" && o.notes[0] === "trading is halted")).toBe(true);
    });

    it("sets the halt flag and rejects all orders on the daily loss stop", () => {
        const account = { equity: cents(9_700_000), cash: cents(5_000_000), previousCloseEquity: EQUITY };

        const result = runRiskChecks([order("AAA", "buy", 1)], portfolio(), context({ account }));

        expect(result.halt).toBe(true);
        expect(result.orders[0]?.status).toBe("rejected");
    });

    it("sets the halt flag even with no orders", () => {
        const account = { equity: cents(9_000_000), cash: cents(0), previousCloseEquity: EQUITY };

        expect(runRiskChecks([], portfolio(), context({ account })).halt).toBe(true);
    });

    it("counts orders from earlier in the day toward the daily caps", () => {
        const result = runRiskChecks(
            [order("AAA", "buy", 1), order("BBB", "buy", 1)],
            portfolio({ ordersToday: 9 }),
            context(),
        );

        expect(result.orders.map((o) => o.status)).toEqual(["accepted", "rejected"]);
    });

    it("runs custom rules in the given order", () => {
        const calls: string[] = [];
        const spy =
            (name: string): RiskRule =>
            () => {
                calls.push(name);
                return { kind: "accept" };
            };

        runRiskChecks([order("AAA", "buy", 1)], portfolio(), context(), [spy("a"), spy("b")]);

        expect(calls).toEqual(["a", "b"]);
    });
});

describe("simulatePortfolio", () => {
    it("starts from the broker's cash and positions", () => {
        const position: Position = {
            ticker: toTicker("AAA"),
            qty: 5,
            avgEntryPrice: cents(100),
            currentPrice: cents(100),
            marketValue: cents(500),
            unrealizedPl: cents(0),
        };

        const sim = simulatePortfolio({ equity: EQUITY, cash: cents(123), previousCloseEquity: EQUITY }, [position], {
            orders: 2,
            traded: 1_000,
        });

        expect(sim).toEqual({
            cash: 123,
            holdings: new Map([[toTicker("AAA"), 5]]),
            ordersToday: 2,
            tradedToday: 1_000,
        });
    });
});
