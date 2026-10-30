import { beforeEach, describe, expect, it } from "vitest";
import { cents } from "../../../core/money.js";
import { toTicker, toTradingDate } from "../../../core/types.js";
import type { ShadowOrder, ShadowRepository } from "../../../ports/repositories.js";
import { openDatabase } from "../db.js";
import { migrate } from "../migrate.js";
import { createSqliteRepositories } from "../repositories/index.js";

const AAA = toTicker("AAA");
const d1 = toTradingDate("2026-11-03");
const d2 = toTradingDate("2026-11-04");

const order = (id: string): ShadowOrder => ({
    id,
    ticker: AAA,
    side: "buy",
    qty: 10,
    limitPrice: cents(10_100),
    stopLossPrice: cents(9_300),
    takeProfitPrice: undefined,
    reasoning: "why",
    status: "pending",
});

describe("SqliteShadowRepository", () => {
    let shadow: ShadowRepository;

    beforeEach(async () => {
        const db = openDatabase(":memory:");
        migrate(db);
        shadow = createSqliteRepositories(db).shadow;
        await shadow.openAccount({
            strategy: "momentum",
            portfolio: { cash: cents(10_000_000), positions: [] },
            startDate: d1,
            startValue: cents(10_000_000),
        });
    });

    it("opens an account once", async () => {
        await shadow.openAccount({
            strategy: "momentum",
            portfolio: { cash: cents(1), positions: [] },
            startDate: d2,
            startValue: cents(1),
        });

        expect(await shadow.getAccount("momentum")).toEqual({
            strategy: "momentum",
            portfolio: { cash: 10_000_000, positions: [] },
            startDate: d1,
            startValue: 10_000_000,
            lastSimulated: undefined,
        });
        expect(await shadow.getAccount("claude")).toBeUndefined();
    });

    it("replaces pending orders for a trade date", async () => {
        await shadow.saveOrders("momentum", d1, [order("o1"), order("o2")]);
        await shadow.saveOrders("momentum", d1, [order("o3")]);

        expect((await shadow.pendingOrders("momentum", d1)).map((o) => o.id)).toEqual(["o3"]);
        expect(await shadow.pendingOrders("momentum", d1)).toEqual([order("o3")]);
    });

    it("records a day once, with fills, order outcomes and the snapshot", async () => {
        await shadow.saveOrders("momentum", d1, [order("o1"), order("o2")]);
        const position = {
            ticker: AAA,
            qty: 10,
            cost: 100_000,
            stopLossPrice: cents(9_300),
            takeProfitPrice: undefined,
            openedOn: d1,
            lastPrice: cents(10_200),
        };
        const day = {
            strategy: "momentum" as const,
            date: d1,
            portfolio: { cash: cents(9_900_000), positions: [position] },
            fills: [
                {
                    ticker: AAA,
                    side: "buy" as const,
                    qty: 10,
                    price: cents(10_000),
                    fee: cents(0),
                    date: d1,
                    reason: "entry" as const,
                },
            ],
            filledOrderIds: ["o1"],
            equity: cents(10_002_000),
        };

        expect(await shadow.recordDay(day)).toBe(true);
        expect(await shadow.recordDay(day)).toBe(false);

        const account = await shadow.getAccount("momentum");
        expect(account?.lastSimulated).toBe(d1);
        expect(account?.portfolio.positions).toEqual([position]);
        expect(await shadow.pendingOrders("momentum", d1)).toEqual([]);
        expect(await shadow.fills("momentum")).toEqual([{ ...day.fills[0], strategy: "momentum" }]);
        expect(await shadow.snapshots("momentum")).toEqual([{ date: d1, equity: 10_002_000 }]);
    });
});
