import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { HttpError, PermanentError, TransientError } from "../../../lib/errors.js";
import { RateLimiter } from "../../../lib/http.js";
import { AlpacaClient, queryString } from "../client.js";

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function client(handler: Handler, mode: "paper" | "live" = "paper") {
    const fetch = vi.fn((url: string, init?: RequestInit) => Promise.resolve(handler(url, init ?? {})));
    const sleep = vi.fn(() => Promise.resolve());
    const alpaca = new AlpacaClient({
        keyId: "key-id",
        secretKey: "secret",
        mode,
        logger: pino({ level: "silent" }),
        fetch: fetch as unknown as typeof globalThis.fetch,
        retry: { sleep, random: () => 0 },
        limiter: new RateLimiter(60_000, () => 0, sleep),
    });
    return { alpaca, fetch, sleep };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers });
const account = z.object({ equity: z.string() });

describe("AlpacaClient", () => {
    it("sends auth headers to the paper trading URL", async () => {
        const { alpaca, fetch } = client(() => json({ equity: "100" }));

        await expect(alpaca.trading("/v2/account", account)).resolves.toEqual({ equity: "100" });

        const [url, init] = fetch.mock.calls[0] ?? [];
        expect(url).toBe("https://paper-api.alpaca.markets/v2/account");
        expect(init?.headers).toMatchObject({ "APCA-API-KEY-ID": "key-id", "APCA-API-SECRET-KEY": "secret" });
    });

    it("uses the live URL in live mode and the data URL for market data", async () => {
        const { alpaca, fetch } = client(() => json({ equity: "1" }), "live");

        await alpaca.trading("/v2/account", account);
        await alpaca.data("/v2/stocks/bars", account, { symbols: ["AAPL", "MSFT"], feed: "sip" });

        expect(fetch.mock.calls.map((c) => c[0])).toEqual([
            "https://api.alpaca.markets/v2/account",
            "https://data.alpaca.markets/v2/stocks/bars?symbols=AAPL%2CMSFT&feed=sip",
        ]);
    });

    it("sends JSON bodies", async () => {
        const { alpaca, fetch } = client(() => json({ equity: "1" }));

        await alpaca.trading("/v2/orders", account, { method: "POST", body: { qty: "1" } });

        const init = fetch.mock.calls[0]?.[1];
        expect(init?.method).toBe("POST");
        expect(init?.body).toBe('{"qty":"1"}');
    });

    it("accepts empty responses when the schema allows them", async () => {
        const { alpaca } = client(() => new Response(null, { status: 204 }));

        await expect(alpaca.trading("/v2/orders/1", z.undefined(), { method: "DELETE" })).resolves.toBeUndefined();
    });

    it("retries 429 using Retry-After, then succeeds", async () => {
        let calls = 0;
        const { alpaca, sleep } = client(() =>
            ++calls === 1 ? json({ message: "too many requests" }, 429, { "retry-after": "2" }) : json({ equity: "1" }),
        );

        await expect(alpaca.trading("/v2/account", account)).resolves.toEqual({ equity: "1" });
        expect(sleep).toHaveBeenCalledWith(2000);
    });

    it("retries 5xx and network errors, then gives up with a transient error", async () => {
        const { alpaca, fetch } = client(() => json({}, 503));

        await expect(alpaca.trading("/v2/account", account)).rejects.toBeInstanceOf(TransientError);
        expect(fetch).toHaveBeenCalledTimes(4);

        const offline = client(() => {
            throw new TypeError("fetch failed");
        });
        await expect(offline.alpaca.trading("/v2/account", account)).rejects.toThrow(
            "Alpaca GET /v2/account: fetch failed",
        );
    });

    it("maps other 4xx to a permanent error with the vendor message, without retrying", async () => {
        const { alpaca, fetch } = client(() => json({ code: 40310000, message: "insufficient qty available" }, 403));

        const error = await alpaca.trading("/v2/orders", account).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(HttpError);
        expect(error).toMatchObject({ status: 403, message: "Alpaca GET /v2/orders: 403 insufficient qty available" });
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("rejects responses that do not match the schema", async () => {
        const { alpaca } = client(() => json({ equity: 100 }));

        await expect(alpaca.trading("/v2/account", account)).rejects.toBeInstanceOf(PermanentError);
        await expect(alpaca.trading("/v2/account", account)).rejects.toThrow("unexpected response (equity:");
    });

    it("waits for the rate limiter before each call", async () => {
        const acquire = vi.fn(() => Promise.resolve());
        const alpaca = new AlpacaClient({
            keyId: "k",
            secretKey: "s",
            mode: "paper",
            logger: pino({ level: "silent" }),
            fetch: () => Promise.resolve(json({ equity: "1" })),
            limiter: { acquire } as unknown as RateLimiter,
        });

        await alpaca.trading("/v2/account", account);
        await alpaca.data("/v2/stocks/bars", account);

        expect(acquire).toHaveBeenCalledTimes(2);
    });
});

describe("RateLimiter", () => {
    it("spaces calls evenly", async () => {
        let now = 0;
        const waits: number[] = [];
        const limiter = new RateLimiter(
            120,
            () => now,
            (ms) => {
                waits.push(ms);
                return Promise.resolve();
            },
        );

        await limiter.acquire();
        await limiter.acquire();
        await limiter.acquire();
        now = 2_000;
        await limiter.acquire();

        expect(waits).toEqual([500, 1000]);
    });
});

describe("queryString", () => {
    it("joins arrays and skips undefined", () => {
        expect(queryString({ a: ["x", "y"], b: undefined, c: 3, d: true })).toBe("?a=x%2Cy&c=3&d=true");
        expect(queryString({})).toBe("");
    });
});
