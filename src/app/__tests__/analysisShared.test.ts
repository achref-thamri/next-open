import { describe, expect, it } from "vitest";
import { riskSchema } from "../../config/schema.js";
import { cents } from "../../core/money.js";
import { toTicker, toTradingDate, type Decision, type Position, type TradingDate } from "../../core/types.js";
import { withTimeStops } from "../analysisShared.js";

const limits = riskSchema.parse({});
const asOf = toTradingDate("2026-11-27");
const MDT = toTicker("MDT");

function position(currentPriceCents: number): Position {
    return {
        ticker: MDT,
        qty: 3,
        avgEntryPrice: cents(10_000),
        currentPrice: cents(currentPriceCents),
        marketValue: cents(3 * currentPriceCents),
        unrealizedPl: cents(3 * (currentPriceCents - 10_000)),
    };
}

const hold: Decision = {
    ticker: MDT,
    action: "hold",
    targetWeight: 0.1,
    confidence: 3,
    stopLossPct: 0.08,
    takeProfitPct: 0.12,
    horizonDays: 10,
    reasoning: "Still in its uptrend.",
};

const openedOn = (date: string) => new Map<typeof MDT, TradingDate>([[MDT, toTradingDate(date)]]);

describe("withTimeStops", () => {
    it("sells a position held 10 days that is up less than 3%", () => {
        const [decision] = withTimeStops([hold], [position(10_200)], openedOn("2026-11-17"), asOf, limits);

        expect(decision).toMatchObject({ action: "sell", targetWeight: 0 });
        expect(decision?.reasoning).toBe(
            "Held 10 days at +2.0%. After 10 days a position needs at least 3% to stay, so this one is sold to free the money.",
        );
    });

    it("keeps a position held 10 days that is up 3% or more", () => {
        expect(withTimeStops([hold], [position(10_300)], openedOn("2026-11-17"), asOf, limits)).toEqual([hold]);
    });

    it("keeps a losing position that has been held less than 10 days", () => {
        expect(withTimeStops([hold], [position(9_500)], openedOn("2026-11-18"), asOf, limits)).toEqual([hold]);
    });

    it("leaves decisions for stocks it holds no open date for", () => {
        expect(withTimeStops([hold], [position(9_500)], new Map(), asOf, limits)).toEqual([hold]);
    });
});
