import { beforeEach, describe, expect, it } from "vitest";
import { cents } from "../../../core/money.js";
import { toTicker, type OrderIntent } from "../../../core/types.js";
import { PermanentError, TransientError } from "../../../lib/errors.js";
import { FakeBroker } from "../broker.js";
import { FakeClock } from "../clock.js";

const AAA = toTicker("AAA");
const prices = (price: number) => new Map([[AAA, cents(price)]]);

function buy(id: string, qty: number, limit = 10_000): OrderIntent {
    return {
        clientOrderId: id,
        ticker: AAA,
        side: "buy",
        qty,
        limitPrice: cents(limit),
        stopLossPrice: cents(Math.round(limit * 0.9)),
        takeProfitPrice: cents(Math.round(limit * 1.2)),
    };
}

function sell(id: string, qty: number, limit = 10_000): OrderIntent {
    return {
        clientOrderId: id,
        ticker: AAA,
        side: "sell",
        qty,
        limitPrice: cents(limit),
        stopLossPrice: undefined,
        takeProfitPrice: undefined,
    };
}

describe("FakeBroker", () => {
    let clock: FakeClock;
    let broker: FakeBroker;

    beforeEach(() => {
        clock = new FakeClock("2026-11-02T14:30:00Z");
        broker = new FakeBroker({ clock, cash: cents(10_000_000) });
    });

    describe("idempotency", () => {
        it("returns the existing order for a repeated client order id", async () => {
            const first = await broker.placeOrder(buy("tb-1", 10));
            const again = await broker.placeOrder(buy("tb-1", 10));

            expect(again.id).toBe(first.id);
            expect(broker.allOrders()).toHaveLength(1);
        });

        it("looks orders up by client order id", async () => {
            await broker.placeOrder(buy("tb-1", 10));

            expect((await broker.getOrderByClientId("tb-1"))?.qty).toBe(10);
            expect(await broker.getOrderByClientId("tb-2")).toBeUndefined();
        });
    });

    describe("buy fills", () => {
        it("fills a buy at the open when the open is at or below the limit", async () => {
            await broker.placeOrder(buy("tb-1", 10, 10_000));

            broker.openMarket(prices(9_950));

            const order = await broker.getOrderByClientId("tb-1");
            expect(order).toMatchObject({ status: "filled", filledQty: 10, filledAvgPrice: 9_950 });
            expect(await broker.getAccount()).toEqual({
                equity: 10_000_000,
                cash: 10_000_000 - 99_500,
                previousCloseEquity: 10_000_000,
            });
            expect(await broker.getPositions()).toEqual([
                {
                    ticker: AAA,
                    qty: 10,
                    avgEntryPrice: 9_950,
                    currentPrice: 9_950,
                    marketValue: 99_500,
                    unrealizedPl: 0,
                },
            ]);
        });

        it("does not fill a buy when the open gaps above the limit", async () => {
            await broker.placeOrder(buy("tb-1", 10, 10_000));

            broker.openMarket(prices(10_001));

            expect((await broker.getOrderByClientId("tb-1"))?.status).toBe("open");
            expect(await broker.getPositions()).toEqual([]);
        });

        it("records fills with the trade date", async () => {
            await broker.placeOrder(buy("tb-1", 10));
            broker.openMarket(prices(10_000));

            expect(await broker.getFills(new Date("2026-11-02T00:00:00Z"))).toMatchObject([
                { ticker: AAA, side: "buy", qty: 10, price: 10_000, fee: 0, date: "2026-11-02" },
            ]);
            expect(await broker.getFills(new Date("2026-11-03T00:00:00Z"))).toEqual([]);
        });

        it("refuses buys beyond cash, counting other open buys", async () => {
            await broker.placeOrder(buy("tb-1", 600, 10_000));

            await expect(broker.placeOrder(buy("tb-2", 500, 10_000))).rejects.toThrow("insufficient buying power");
        });

        it("refuses buys without bracket legs", async () => {
            await expect(broker.placeOrder({ ...buy("tb-1", 1), stopLossPrice: undefined })).rejects.toBeInstanceOf(
                PermanentError,
            );
        });
    });

    describe("bracket legs", () => {
        beforeEach(async () => {
            await broker.placeOrder(buy("tb-1", 10, 10_000)); // stop 9,000, target 12,000
            broker.openMarket(prices(10_000));
        });

        it("triggers the stop-loss when the day trades through it and cancels the target", async () => {
            broker.tradeRange(AAA, cents(8_900), cents(10_100));

            const legs = (await broker.getOrderByClientId("tb-1"))?.legs ?? [];
            expect(legs.map((l) => [l.role, l.status])).toEqual([
                ["take_profit", "canceled"],
                ["stop_loss", "filled"],
            ]);
            expect(await broker.getPositions()).toEqual([]);
            expect((await broker.getAccount()).cash).toBe(10_000_000 - 10_000);
        });

        it("triggers the take-profit and cancels the stop", async () => {
            broker.tradeRange(AAA, cents(9_900), cents(12_000));

            const legs = (await broker.getOrderByClientId("tb-1"))?.legs ?? [];
            expect(legs.map((l) => l.status)).toEqual(["filled", "canceled"]);
            expect((await broker.getAccount()).cash).toBe(10_000_000 + 20_000);
        });

        it("keeps legs open while the price stays inside the range", async () => {
            broker.tradeRange(AAA, cents(9_500), cents(11_000));

            const open = await broker.listOpenOrders();
            expect(open[0]?.legs.map((l) => l.role)).toEqual(["take_profit", "stop_loss"]);
        });

        it("reserves the shares, so a sell needs the legs cancelled first", async () => {
            await expect(broker.placeOrder(sell("tb-2", 10))).rejects.toThrow("insufficient qty available");

            const stopLeg = (await broker.getOrderByClientId("tb-1"))?.legs.find((l) => l.role === "stop_loss");
            await broker.cancelOrder(stopLeg?.id ?? "");

            expect((await broker.getOrderByClientId("tb-1"))?.legs.map((l) => l.status)).toEqual([
                "canceled",
                "canceled",
            ]);
            await expect(broker.placeOrder(sell("tb-2", 10))).resolves.toMatchObject({ role: "exit" });
        });

        it("protects only the filled part of a partially filled entry", async () => {
            await broker.placeOrder(buy("tb-3", 10, 5_000));
            broker.partialFill("tb-3", 4);
            await broker.cancelOrder((await broker.getOrderByClientId("tb-3"))?.id ?? "");

            const entry = await broker.getOrderByClientId("tb-3");
            expect(entry?.status).toBe("canceled");
            expect(entry?.legs.map((l) => [l.qty, l.status])).toEqual([
                [4, "open"],
                [4, "open"],
            ]);
        });
    });

    describe("sells and day orders", () => {
        beforeEach(() => {
            broker.seedPosition(AAA, 20, cents(8_000));
        });

        it("fills a sell when the open is at or above the limit, net of fees", async () => {
            broker = new FakeBroker({ clock, cash: cents(0), sellFeeRate: 0.001 });
            broker.seedPosition(AAA, 20, cents(8_000));
            await broker.placeOrder(sell("tb-1", 20, 10_000));

            broker.openMarket(prices(10_050));

            expect((await broker.getAccount()).cash).toBe(201_000 - 201);
            const [fill] = await broker.getFills(new Date(0));
            expect(fill).toMatchObject({ side: "sell", qty: 20, price: 10_050, fee: 201 });
        });

        it("refuses to sell more than held (no shorting)", async () => {
            await expect(broker.placeOrder(sell("tb-1", 21))).rejects.toBeInstanceOf(PermanentError);
        });

        it("counts open sells against the shares available", async () => {
            await broker.placeOrder(sell("tb-1", 15));

            await expect(broker.placeOrder(sell("tb-2", 6))).rejects.toThrow("available: 5");
        });

        it("expires unfilled sells at the close and keeps unfilled buys (gtc brackets)", async () => {
            await broker.placeOrder(sell("tb-1", 20, 10_000));
            await broker.placeOrder(buy("tb-2", 1, 5_000));
            broker.openMarket(prices(9_000));

            broker.closeMarket();

            expect((await broker.getOrderByClientId("tb-1"))?.status).toBe("expired");
            expect((await broker.getOrderByClientId("tb-2"))?.status).toBe("open");
        });

        it("rolls equity into the previous close", async () => {
            broker.closeMarket(prices(9_000));

            expect(await broker.getAccount()).toMatchObject({ equity: 10_180_000, previousCloseEquity: 10_180_000 });
        });
    });

    describe("cancel", () => {
        it("cancels an unfilled entry together with its legs", async () => {
            const order = await broker.placeOrder(buy("tb-1", 10));

            await broker.cancelOrder(order.id);

            expect(await broker.listOpenOrders()).toEqual([]);
        });

        it("is a no-op for a finished order", async () => {
            const order = await broker.placeOrder(buy("tb-1", 10));
            broker.openMarket(prices(10_000));
            broker.tradeRange(AAA, cents(1), cents(10_000));

            await expect(broker.cancelOrder(order.id)).resolves.toBeUndefined();
        });

        it("fails for an unknown order", async () => {
            await expect(broker.cancelOrder("nope")).rejects.toBeInstanceOf(PermanentError);
        });
    });

    describe("account safety and failures", () => {
        it("verifies margin and shorting are off", async () => {
            await expect(broker.verifyAccountSafety()).resolves.toBeUndefined();

            broker.shortingEnabled = true;

            await expect(broker.verifyAccountSafety()).rejects.toThrow("short selling");
        });

        it("throws injected failures once", async () => {
            broker.failures.failNext("getAccount", new TransientError("timeout"));

            await expect(broker.getAccount()).rejects.toBeInstanceOf(TransientError);
            await expect(broker.getAccount()).resolves.toBeDefined();
        });
    });
});
