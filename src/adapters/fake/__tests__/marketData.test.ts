import { describe, expect, it } from "vitest";
import { toTicker, toTradingDate } from "../../../core/types.js";
import { HttpError } from "../../../lib/errors.js";
import { FakeMarketData } from "../marketData.js";

describe("FakeMarketData", () => {
    it("fails the whole bars request on a symbol it does not know, like Alpaca", async () => {
        const data = new FakeMarketData();
        data.assets.push({ ticker: toTicker("AAA"), exchange: "NYSE", name: "AAA Inc." });
        const from = toTradingDate("2026-11-02");
        const to = toTradingDate("2026-11-09");

        expect((await data.getDailyBars([toTicker("AAA")], from, to)).size).toBe(0);
        await expect(data.getDailyBars([toTicker("AAA"), toTicker("B3SA3")], from, to)).rejects.toThrow(HttpError);
    });
});
