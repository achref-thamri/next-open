import type { z } from "zod";
import type { TradingMode } from "../../config/index.js";
import type { Logger } from "../../lib/logger.js";
import { requestJson, RateLimiter, type Fetch } from "../../lib/http.js";
import { retry, type RetryOptions } from "../../lib/retry.js";

const ALPACA_URLS = {
    paper: "https://paper-api.alpaca.markets",
    live: "https://api.alpaca.markets",
    data: "https://data.alpaca.markets",
} as const;

/** Alpaca allows 200 requests per minute per account; stay a little under it. */
const REQUESTS_PER_MINUTE = 180;
const TRADING_TIMEOUT_MS = 15_000;
const DATA_TIMEOUT_MS = 60_000;

export type Query = Record<string, string | number | boolean | readonly string[] | undefined>;

export interface AlpacaClientOptions {
    keyId: string;
    secretKey: string;
    mode: TradingMode;
    logger: Logger;
    fetch?: Fetch;
    retry?: RetryOptions;
    limiter?: RateLimiter;
}

/**
 * Typed fetch wrapper for the Alpaca trading and market data APIs: auth headers, base URL per mode, zod
 * validation, error mapping (429/5xx/network transient, other 4xx permanent), retries and rate limiting.
 */
export class AlpacaClient {
    private readonly limiter: RateLimiter;
    private readonly tradingUrl: string;

    constructor(private readonly options: AlpacaClientOptions) {
        this.limiter = options.limiter ?? new RateLimiter(REQUESTS_PER_MINUTE);
        this.tradingUrl = ALPACA_URLS[options.mode];
    }

    /** Trading API (account, orders, positions, calendar, assets). */
    trading<S extends z.ZodType>(
        path: string,
        schema: S,
        request: { method?: "GET" | "POST" | "PATCH" | "DELETE"; query?: Query; body?: unknown } = {},
    ): Promise<z.output<S>> {
        return this.call(this.tradingUrl, path, schema, request);
    }

    /** Market data API (bars, news). */
    data<S extends z.ZodType>(path: string, schema: S, query: Query = {}): Promise<z.output<S>> {
        return this.call(ALPACA_URLS.data, path, schema, { query });
    }

    private call<S extends z.ZodType>(
        base: string,
        path: string,
        schema: S,
        request: { method?: "GET" | "POST" | "PATCH" | "DELETE"; query?: Query; body?: unknown },
    ): Promise<z.output<S>> {
        const method = request.method ?? "GET";
        const url = `${base}${path}${queryString(request.query ?? {})}`;
        const label = `Alpaca ${method} ${path}`;
        return retry(
            async () => {
                await this.limiter.acquire();
                return requestJson({
                    method,
                    url,
                    label,
                    // Multi-symbol SIP bar pages can take a while to assemble.
                    timeoutMs: base === ALPACA_URLS.data ? DATA_TIMEOUT_MS : TRADING_TIMEOUT_MS,
                    schema,
                    body: request.body,
                    headers: {
                        "APCA-API-KEY-ID": this.options.keyId,
                        "APCA-API-SECRET-KEY": this.options.secretKey,
                    },
                    ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
                });
            },
            {
                ...this.options.retry,
                onRetry: (error, attempt, delayMs) => {
                    this.options.logger.warn({ err: error.message, attempt, delayMs, path }, "retrying Alpaca call");
                },
            },
        );
    }
}

/** Encodes a query, joining arrays with commas and leaving out undefined values. */
export function queryString(query: Query): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
        if (value === undefined) continue;
        params.set(key, Array.isArray(value) ? value.join(",") : String(value));
    }
    const text = params.toString();
    return text ? `?${text}` : "";
}
