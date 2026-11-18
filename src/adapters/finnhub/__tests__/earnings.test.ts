import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { toTicker, toTradingDate } from "../../../core/types.js";
import { FinnhubEarnings } from "../earnings.js";

const fixture = readFileSync(new URL("../__fixtures__/earnings-calendar.json", import.meta.url), "utf8");
const FROM = toTradingDate("2026-11-18");
const TO = toTradingDate("2026-12-09");

function finnhub(respond: () => Response) {
    const requests: { url: URL; headers: Record<string, string> }[] = [];
    const adapter = new FinnhubEarnings({
        apiKey: "secret-key",
        fetch: ((input: string, init: RequestInit) => {
            requests.push({ url: new URL(input), headers: init.headers as Record<string, string> });
            return Promise.resolve(respond());
        }) as typeof fetch,
    });
    return { adapter, requests };
}

describe("FinnhubEarnings", () => {
    it("keeps the earliest report per ticker and skips foreign symbols and blank dates", async () => {
        const { adapter, requests } = finnhub(() => new Response(fixture));

        const reports = await adapter.nextReports(FROM, TO);

        expect(reports).toEqual(
            new Map([
                [toTicker("AAPL"), "2026-11-24"],
                [toTicker("BRK.B"), "2026-11-20"],
            ]),
        );
        expect(requests[0]?.url.pathname).toBe("/api/v1/calendar/earnings");
        expect(requests[0]?.url.searchParams.get("from")).toBe("2026-11-18");
        expect(requests[0]?.url.searchParams.get("to")).toBe("2026-12-09");
        expect(requests[0]?.url.toString()).not.toContain("secret-key");
        expect(requests[0]?.headers["X-Finnhub-Token"]).toBe("secret-key");
    });

    it("treats an empty answer as no reports", async () => {
        const { adapter } = finnhub(() => new Response("{}"));

        expect((await adapter.nextReports(FROM, TO)).size).toBe(0);
    });

    it("never puts the API key in error messages", async () => {
        const { adapter } = finnhub(() => new Response('{"error":"Invalid API key"}', { status: 401 }));

        const error: unknown = await adapter.nextReports(FROM, TO).then(
            () => undefined,
            (caught: unknown) => caught,
        );

        expect((error as Error).message).toContain("Finnhub earnings calendar: 401");
        expect((error as Error).message).not.toContain("secret-key");
    });
});
