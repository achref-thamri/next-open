import { describe, expect, it } from "vitest";
import { riskSchema } from "../../config/schema.js";
import { cents } from "../../core/money.js";
import { syncBroker, withoutReserve } from "../sync.js";
import { harness } from "./harness.js";

describe("withoutReserve", () => {
    it("takes the reserve off equity, cash and the previous close", () => {
        const account = { equity: cents(10_000_000), cash: cents(4_000_000), previousCloseEquity: cents(9_900_000) };

        expect(withoutReserve(account, cents(5_000_000))).toEqual({
            equity: cents(5_000_000),
            cash: cents(-1_000_000),
            previousCloseEquity: cents(4_900_000),
        });
    });

    it("keeps the same dollar loss, so the daily loss check counts it against the traded money", () => {
        const account = withoutReserve(
            { equity: cents(9_850_000), cash: cents(9_850_000), previousCloseEquity: cents(10_000_000) },
            cents(5_000_000),
        );

        expect(account.previousCloseEquity - account.equity).toBe(150_000);
        expect(account.equity / account.previousCloseEquity - 1).toBeCloseTo(-0.03);
    });
});

describe("syncBroker", () => {
    it("leaves the account as it is without a reserve", async () => {
        const { account } = await syncBroker(harness());

        expect(account.equity).toBe(10_000_000);
    });

    it("applies the reserve from the risk settings", async () => {
        const h = harness({ risk: riskSchema.parse({ reservedCashUsd: 40_000 }) });

        const { account } = await syncBroker(h);

        expect(account).toMatchObject({ equity: 6_000_000, cash: 6_000_000 });
    });
});
