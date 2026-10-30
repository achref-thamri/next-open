import { describe, expect, it } from "vitest";
import { cents } from "../money.js";
import {
    asBrokerState,
    portfolioValue,
    simulateDay,
    type VirtualOrder,
    type VirtualPortfolio,
    type VirtualPosition,
} from "../simulation.js";
import { toTicker, toTradingDate, type DailyBar } from "../types.js";

const AAA = toTicker("AAA");
const BBB = toTicker("BBB");
const day = toTradingDate("2026-11-03");

function bar(open: number, low: number, high: number, close: number): DailyBar {
    return { date: day, open: cents(open), low: cents(low), high: cents(high), close: cents(close), volume: 1 };
}

function buy(ticker = AAA, qty = 10, limit = 10_100, stop?: number, target?: number): VirtualOrder {
    return {
        ticker,
        side: "buy",
        qty,
        limitPrice: cents(limit),
        stopLossPrice: stop === undefined ? undefined : cents(stop),
        takeProfitPrice: target === undefined ? undefined : cents(target),
    };
}

function sell(ticker = AAA, qty = 10, limit = 9_900): VirtualOrder {
    return {
        ticker,
        side: "sell",
        qty,
        limitPrice: cents(limit),
        stopLossPrice: undefined,
        takeProfitPrice: undefined,
    };
}

function held(ticker = AAA, qty = 10, cost = 100_000, stop?: number, target?: number): VirtualPosition {
    return {
        ticker,
        qty,
        cost,
        stopLossPrice: stop === undefined ? undefined : cents(stop),
        takeProfitPrice: target === undefined ? undefined : cents(target),
        openedOn: toTradingDate("2026-11-02"),
        lastPrice: cents(10_000),
    };
}

const portfolio = (cash: number, positions: VirtualPosition[] = []): VirtualPortfolio => ({
    cash: cents(cash),
    positions,
});

describe("simulateDay", () => {
    it("buys at the open when it is at or below the limit", () => {
        const result = simulateDay(
            portfolio(1_000_000),
            [buy(AAA, 10, 10_100, 9_000, 12_000)],
            new Map([[AAA, bar(10_050, 10_000, 10_200, 10_150)]]),
            day,
        );

        expect(result.fills).toEqual([
            { ticker: AAA, side: "buy", qty: 10, price: 10_050, fee: 0, date: day, reason: "entry" },
        ]);
        expect(result.portfolio.cash).toBe(1_000_000 - 100_500);
        expect(result.portfolio.positions).toEqual([
            {
                ticker: AAA,
                qty: 10,
                cost: 100_500,
                stopLossPrice: 9_000,
                takeProfitPrice: 12_000,
                openedOn: day,
                lastPrice: 10_150,
            },
        ]);
    });

    it("does not chase a gap above the limit", () => {
        const result = simulateDay(
            portfolio(1_000_000),
            [buy()],
            new Map([[AAA, bar(10_200, 10_000, 10_300, 10_250)]]),
            day,
        );

        expect(result.fills).toEqual([]);
        expect(result.unfilled).toHaveLength(1);
    });

    it("never buys on margin", () => {
        const result = simulateDay(
            portfolio(50_000),
            [buy()],
            new Map([[AAA, bar(10_000, 10_000, 10_000, 10_000)]]),
            day,
        );

        expect(result.unfilled).toHaveLength(1);
        expect(result.portfolio.cash).toBe(50_000);
    });

    it("sells first so the proceeds fund buys", () => {
        const result = simulateDay(
            portfolio(0, [held(BBB, 10)]),
            [buy(AAA, 10, 10_100), sell(BBB, 10, 9_900)],
            new Map([
                [AAA, bar(10_000, 10_000, 10_000, 10_000)],
                [BBB, bar(10_000, 10_000, 10_000, 10_000)],
            ]),
            day,
        );

        expect(result.fills.map((f) => [f.ticker, f.side])).toEqual([
            [BBB, "sell"],
            [AAA, "buy"],
        ]);
        expect(result.portfolio.cash).toBe(0);
    });

    it("sells at the open when it is at or above the limit, and keeps the cost basis of the rest", () => {
        const result = simulateDay(
            portfolio(0, [held(AAA, 10, 100_000)]),
            [sell(AAA, 4, 9_900)],
            new Map([[AAA, bar(9_950, 9_900, 10_000, 9_980)]]),
            day,
        );

        expect(result.portfolio.cash).toBe(4 * 9_950);
        expect(result.portfolio.positions[0]).toMatchObject({ qty: 6, cost: 60_000, lastPrice: 9_980 });
    });

    it("does not sell below the limit or more than held", () => {
        const low = simulateDay(
            portfolio(0, [held()]),
            [sell(AAA, 10, 9_900)],
            new Map([[AAA, bar(9_800, 9_700, 9_900, 9_850)]]),
            day,
        );
        const more = simulateDay(
            portfolio(0, [held(AAA, 3)]),
            [sell(AAA, 10, 9_900)],
            new Map([[AAA, bar(10_000, 10_000, 10_000, 10_000)]]),
            day,
        );

        expect(low.fills).toEqual([]);
        expect(more.fills[0]?.qty).toBe(3);
    });

    it("triggers the stop-loss before the take-profit when the day hits both", () => {
        const result = simulateDay(
            portfolio(0, [held(AAA, 10, 100_000, 9_000, 11_000)]),
            [],
            new Map([[AAA, bar(10_000, 8_900, 11_500, 10_000)]]),
            day,
        );

        expect(result.fills).toMatchObject([{ side: "sell", qty: 10, price: 9_000, reason: "stop_loss" }]);
        expect(result.portfolio.positions).toEqual([]);
    });

    it("fills a stop at the open after a gap down, and a target at the open after a gap up", () => {
        const gapDown = simulateDay(
            portfolio(0, [held(AAA, 10, 100_000, 9_000)]),
            [],
            new Map([[AAA, bar(8_500, 8_400, 8_800, 8_600)]]),
            day,
        );
        const gapUp = simulateDay(
            portfolio(0, [held(AAA, 10, 100_000, undefined, 11_000)]),
            [],
            new Map([[AAA, bar(11_500, 11_400, 11_800, 11_600)]]),
            day,
        );

        expect(gapDown.fills[0]).toMatchObject({ price: 8_500, reason: "stop_loss" });
        expect(gapUp.fills[0]).toMatchObject({ price: 11_500, reason: "take_profit" });
    });

    it("applies protective legs to positions bought the same day", () => {
        const result = simulateDay(
            portfolio(1_000_000),
            [buy(AAA, 10, 10_100, 9_500)],
            new Map([[AAA, bar(10_000, 9_400, 10_000, 9_600)]]),
            day,
        );

        expect(result.fills.map((f) => f.reason)).toEqual(["entry", "stop_loss"]);
    });

    it("leaves orders without a bar unfilled and keeps positions at their last price", () => {
        const result = simulateDay(portfolio(1_000_000, [held(BBB)]), [buy(AAA)], new Map(), day);

        expect(result.unfilled).toHaveLength(1);
        expect(result.portfolio.positions[0]?.lastPrice).toBe(10_000);
    });
});

describe("portfolio helpers", () => {
    it("values cash plus positions", () => {
        expect(portfolioValue(portfolio(500, [held(AAA, 10)]))).toBe(100_500);
    });

    it("presents the portfolio as broker state", () => {
        const state = asBrokerState(portfolio(500, [held(AAA, 10, 95_000)]), cents(99_000));

        expect(state.account).toEqual({ equity: 100_500, cash: 500, previousCloseEquity: 99_000 });
        expect(state.positions).toEqual([
            {
                ticker: AAA,
                qty: 10,
                avgEntryPrice: 9_500,
                currentPrice: 10_000,
                marketValue: 100_000,
                unrealizedPl: 5_000,
            },
        ]);
    });
});
