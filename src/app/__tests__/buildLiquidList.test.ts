import { beforeEach, describe, expect, it } from "vitest";
import { FakeFundamentals } from "../../adapters/fake/index.js";
import { toTicker, toTradingDate } from "../../core/types.js";
import { buildLiquidList, weekOf } from "../buildLiquidList.js";
import { harness, seedStock, type Harness } from "./harness.js";

/** Sunday 2026-11-01, 08:00 New York. */
const SUNDAY = "2026-11-01T13:00:00Z";
const FRIDAY = toTradingDate("2026-10-30");

describe("buildLiquidList", () => {
    let h: Harness;

    beforeEach(() => {
        h = harness({}, SUNDAY);
        seedStock(h, "AAA", { until: FRIDAY });
        seedStock(h, "BBB", { until: FRIDAY });
        seedStock(h, "SMALL", { until: FRIDAY, marketCapUsd: 1e9 });
        seedStock(h, "PENNY", { until: FRIDAY, price: 3, volume: 50_000_000 });
        seedStock(h, "THIN", { until: FRIDAY, volume: 1_000 });
        seedStock(h, "FUND", { until: FRIDAY });
        h.fundamentals.profiles.set(toTicker("FUND"), {
            ticker: toTicker("FUND"),
            name: "Fund",
            kind: "etf",
            marketCapUsd: 5e10,
        });
    });

    it("builds a complete list from bars and profiles", async () => {
        const result = await buildLiquidList(h);

        expect(result).toEqual({ status: "succeeded", message: "2 stocks" });
        expect(await h.repos.liquidLists.latestComplete()).toEqual({
            date: "2026-11-01",
            tickers: ["AAA", "BBB"],
            complete: true,
        });
        expect(h.notifier.texts()).toEqual(["📋 Weekly list ready: 2 liquid US stocks for the week of 2026-11-01."]);
    });

    it("only asks FMP about stocks that pass price and volume", async () => {
        await buildLiquidList(h);

        // AAA, BBB, SMALL, FUND; PENNY and THIN are filtered on bars first
        expect(h.fundamentals.requests).toBe(4);
        expect(await h.repos.profiles.get(toTicker("PENNY"))).toBeUndefined();
    });

    it("fills the profile cache over several days within the budget", async () => {
        const limited = new FakeFundamentals(3);
        for (const [ticker, profile] of h.fundamentals.profiles) limited.profiles.set(ticker, profile);
        h.fundamentals = limited;

        const first = await buildLiquidList(h);

        expect(first.status).toBe("skipped");
        expect(first.message).toContain("profiles still to fetch");
        expect((await h.repos.liquidLists.latest())?.complete).toBe(false);
        expect(await h.repos.liquidLists.latestComplete()).toBeUndefined();

        h.clock.set("2026-11-02T13:00:00Z");
        h.fundamentals.requests = 0; // a new day's budget
        expect((await buildLiquidList(h)).status).toBe("succeeded");
        expect((await h.repos.liquidLists.latestComplete())?.tickers).toEqual(["AAA", "BBB"]);
    });

    it("fetches the most traded stocks first", async () => {
        seedStock(h, "BUSY", { until: FRIDAY, volume: 90_000_000 });
        const limited = new FakeFundamentals(1);
        for (const [ticker, profile] of h.fundamentals.profiles) limited.profiles.set(ticker, profile);
        h.fundamentals = limited;

        await buildLiquidList(h);

        expect((await h.repos.liquidLists.latest())?.tickers).toEqual(["BUSY"]);
    });

    it("builds once per week", async () => {
        await buildLiquidList(h);
        h.clock.set("2026-11-03T13:00:00Z");

        expect(await buildLiquidList(h)).toEqual({
            status: "skipped",
            message: "the list for the week of 2026-11-01 is complete",
        });
    });
});

describe("weekOf", () => {
    it("returns the Sunday starting the week", () => {
        expect(weekOf(toTradingDate("2026-11-01"))).toBe("2026-11-01");
        expect(weekOf(toTradingDate("2026-11-07"))).toBe("2026-11-01");
        expect(weekOf(toTradingDate("2026-11-08"))).toBe("2026-11-08");
    });
});
