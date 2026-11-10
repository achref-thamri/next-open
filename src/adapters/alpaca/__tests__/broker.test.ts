import { readFileSync } from "node:fs";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { cents } from "../../../core/money.js";
import { toTicker, toTradingDate, type OrderIntent } from "../../../core/types.js";
import { HttpError, PermanentError } from "../../../lib/errors.js";
import { RateLimiter } from "../../../lib/http.js";
import { AlpacaBroker } from "../broker.js";
import { AlpacaClient } from "../client.js";

const fixture = (name: string): unknown =>
    JSON.parse(readFileSync(new URL(`../__fixtures__/${name}`, import.meta.url), "utf8"));

interface Call {
    method: string;
    path: string;
    query: URLSearchParams;
    body: unknown;
}

type Route = (call: Call) => { status?: number; body?: unknown };

/** An AlpacaBroker over a fake fetch that routes "METHOD /path" to handlers and records calls. */
function broker(routes: Record<string, Route>) {
    const calls: Call[] = [];
    const fetch = (input: string, init?: RequestInit): Promise<Response> => {
        const url = new URL(input);
        const call = {
            method: init?.method ?? "GET",
            path: url.pathname,
            query: url.searchParams,
            body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
        };
        calls.push(call);
        const route = routes[`${call.method} ${call.path}`];
        if (!route) return Promise.resolve(new Response(JSON.stringify({ message: "not found" }), { status: 404 }));
        const { status = 200, body } = route(call);
        return Promise.resolve(new Response(body === undefined ? null : JSON.stringify(body), { status }));
    };
    const logger = pino({ level: "silent" });
    const client = new AlpacaClient({
        keyId: "k",
        secretKey: "s",
        mode: "paper",
        logger,
        fetch: fetch as typeof globalThis.fetch,
        retry: { sleep: () => Promise.resolve() },
        limiter: new RateLimiter(1e9),
    });
    return { broker: new AlpacaBroker(client, logger), calls };
}

const AAPL = toTicker("AAPL");

describe("AlpacaBroker", () => {
    it("maps the account", async () => {
        const { broker: b } = broker({ "GET /v2/account": () => ({ body: fixture("account.json") }) });

        expect(await b.getAccount()).toEqual({ equity: 10_000_000, cash: 10_000_000, previousCloseEquity: 10_000_000 });
    });

    it("maps positions to cents", async () => {
        const { broker: b } = broker({ "GET /v2/positions": () => ({ body: fixture("positions.json") }) });

        expect(await b.getPositions()).toEqual([
            {
                ticker: AAPL,
                qty: 53,
                avgEntryPrice: 18_742,
                currentPrice: 19_500,
                marketValue: 1_033_500,
                unrealizedPl: 40_174,
            },
        ]);
    });

    it("maps the calendar to New York session times", async () => {
        const { broker: b, calls } = broker({ "GET /v2/calendar": () => ({ body: fixture("calendar.json") }) });

        const days = await b.getCalendar(toTradingDate("2026-11-23"), toTradingDate("2026-11-30"));

        expect(calls[0]?.query.get("start")).toBe("2026-11-23");
        expect(days[0]).toEqual({
            date: "2026-11-23",
            open: new Date("2026-11-23T14:30:00Z"),
            close: new Date("2026-11-23T21:00:00Z"),
        });
    });

    describe("orders", () => {
        const buy: OrderIntent = {
            clientOrderId: "no-01JBQ6Z9X8Y7W6V5T4S3R2Q1P0",
            ticker: AAPL,
            side: "buy",
            qty: 53,
            limitPrice: cents(18_929),
            stopLossPrice: cents(17_403),
            takeProfitPrice: cents(22_715),
        };

        it("sends buys as gtc bracket limit orders", async () => {
            const { broker: b, calls } = broker({ "POST /v2/orders": () => ({ body: fixture("order-bracket.json") }) });

            await b.placeOrder(buy);

            expect(calls[0]?.body).toEqual({
                symbol: "AAPL",
                qty: "53",
                side: "buy",
                type: "limit",
                limit_price: "189.29",
                client_order_id: "no-01JBQ6Z9X8Y7W6V5T4S3R2Q1P0",
                time_in_force: "gtc",
                order_class: "bracket",
                take_profit: { limit_price: "227.15" },
                stop_loss: { stop_price: "174.03" },
            });
        });

        it("sends sells as day limit orders", async () => {
            const { broker: b, calls } = broker({ "POST /v2/orders": () => ({ body: fixture("order-bracket.json") }) });

            await b.placeOrder({
                ...buy,
                side: "sell",
                limitPrice: cents(18_555),
                stopLossPrice: undefined,
                takeProfitPrice: undefined,
            });

            expect(calls[0]?.body).toMatchObject({
                side: "sell",
                time_in_force: "day",
                order_class: "simple",
                limit_price: "185.55",
            });
        });

        it("maps a bracket order with its legs", async () => {
            const { broker: b } = broker({ "POST /v2/orders": () => ({ body: fixture("order-bracket.json") }) });

            const order = await b.placeOrder(buy);

            expect(order).toMatchObject({
                id: "61e69015-8549-4bfd-b9c3-01e75843f47d",
                clientOrderId: "no-01JBQ6Z9X8Y7W6V5T4S3R2Q1P0",
                ticker: AAPL,
                side: "buy",
                role: "entry",
                qty: 53,
                filledQty: 53,
                filledAvgPrice: 18_710,
                limitPrice: 18_929,
                status: "filled",
                submittedAt: new Date("2026-11-03T14:30:01.120Z"),
            });
            expect(order.legs.map((l) => [l.role, l.status, l.limitPrice ?? l.stopPrice])).toEqual([
                ["take_profit", "open", 22_715],
                ["stop_loss", "open", 17_403],
            ]);
        });

        it("treats a duplicate client order id as success and returns the existing order", async () => {
            const { broker: b, calls } = broker({
                "POST /v2/orders": () => ({
                    status: 422,
                    body: { code: 40010001, message: "client_order_id must be unique" },
                }),
                "GET /v2/orders:by_client_order_id": () => ({ body: fixture("order-bracket.json") }),
            });

            const order = await b.placeOrder(buy);

            expect(order.id).toBe("61e69015-8549-4bfd-b9c3-01e75843f47d");
            expect(calls[1]?.query.get("client_order_id")).toBe(buy.clientOrderId);
        });

        it("passes other refusals through as permanent errors", async () => {
            const { broker: b } = broker({
                "POST /v2/orders": () => ({ status: 403, body: { message: "insufficient buying power" } }),
            });

            await expect(b.placeOrder(buy)).rejects.toBeInstanceOf(HttpError);
        });

        it("refuses to send a buy without bracket prices", async () => {
            const { broker: b, calls } = broker({});

            await expect(b.placeOrder({ ...buy, stopLossPrice: undefined })).rejects.toBeInstanceOf(PermanentError);
            expect(calls).toEqual([]);
        });

        it("returns undefined for an unknown client order id", async () => {
            const { broker: b } = broker({});

            expect(await b.getOrderByClientId("no-missing")).toBeUndefined();
        });

        it("lists open orders nested", async () => {
            const { broker: b, calls } = broker({
                "GET /v2/orders": () => ({ body: [fixture("order-bracket.json")] }),
            });

            expect(await b.listOpenOrders()).toHaveLength(1);
            expect(calls[0]?.query.get("status")).toBe("open");
            expect(calls[0]?.query.get("nested")).toBe("true");
        });

        it("treats cancelling a finished order as a no-op", async () => {
            const { broker: b } = broker({
                "DELETE /v2/orders/abc": () => ({ status: 422, body: { message: "order is not cancelable" } }),
            });

            await expect(b.cancelOrder("abc")).resolves.toBeUndefined();
        });

        it("cancels an open order", async () => {
            const { broker: b, calls } = broker({ "DELETE /v2/orders/abc": () => ({ status: 204 }) });

            await b.cancelOrder("abc");

            expect(calls[0]?.method).toBe("DELETE");
        });
    });

    describe("fills", () => {
        it("maps fill activities with the New York trade date", async () => {
            const { broker: b, calls } = broker({
                "GET /v2/account/activities/FILL": () => ({ body: fixture("activities-fill.json") }),
            });

            const fills = await b.getFills(new Date("2026-11-03T00:00:00Z"));

            expect(calls[0]?.query.get("after")).toBe("2026-11-03T00:00:00.000Z");
            expect(fills).toEqual([
                {
                    id: "20261103093002600::8e2f4c1a-7d3b-4f2e-9a1c-0b5d6e7f8a9b",
                    orderId: "61e69015-8549-4bfd-b9c3-01e75843f47d",
                    ticker: AAPL,
                    side: "buy",
                    qty: 53,
                    price: 18_710,
                    fee: 0,
                    date: "2026-11-03",
                    time: new Date("2026-11-03T14:30:02.600Z"),
                },
            ]);
        });

        it("follows pages of 100", async () => {
            const page = (start: number, count: number) =>
                Array.from({ length: count }, (_, i) => ({
                    id: `f${start + i}`,
                    order_id: "o",
                    symbol: "AAPL",
                    side: "buy",
                    qty: "1",
                    price: "1",
                    transaction_time: "2026-11-03T14:30:00Z",
                }));
            const { broker: b, calls } = broker({
                "GET /v2/account/activities/FILL": (call) => ({
                    body: call.query.get("page_token") ? page(100, 3) : page(0, 100),
                }),
            });

            expect(await b.getFills(new Date(0))).toHaveLength(103);
            expect(calls[1]?.query.get("page_token")).toBe("f99");
        });
    });

    describe("account safety", () => {
        it("switches margin and shorting off and verifies", async () => {
            const { broker: b, calls } = broker({
                "GET /v2/account/configurations": () => ({ body: fixture("account-configurations.json") }),
                "PATCH /v2/account/configurations": (call) => ({
                    body: { ...(fixture("account-configurations.json") as object), ...(call.body as object) },
                }),
            });

            await b.verifyAccountSafety();

            expect(calls[1]?.body).toEqual({ no_shorting: true, max_margin_multiplier: "1" });
        });

        it("does nothing when already safe", async () => {
            const { broker: b, calls } = broker({
                "GET /v2/account/configurations": () => ({ body: { no_shorting: true, max_margin_multiplier: "1" } }),
            });

            await b.verifyAccountSafety();

            expect(calls).toHaveLength(1);
        });

        it("fails when the change does not stick", async () => {
            const { broker: b } = broker({
                "GET /v2/account/configurations": () => ({ body: fixture("account-configurations.json") }),
                "PATCH /v2/account/configurations": () => ({ body: fixture("account-configurations.json") }),
            });

            await expect(b.verifyAccountSafety()).rejects.toThrow("refusing to trade");
        });
    });
});
