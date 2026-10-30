import type { z } from "zod";
import { HttpError, PermanentError, TransientError } from "./errors.js";

export type Fetch = typeof fetch;

export interface HttpRequest<S extends z.ZodType> {
    method?: "GET" | "POST" | "PATCH" | "DELETE";
    url: string;
    headers?: Record<string, string>;
    /** Sent as JSON. */
    body?: unknown;
    /** Validates the JSON response; an empty (204) response is validated as `undefined`. */
    schema: S;
    timeoutMs?: number;
    fetch?: Fetch;
    /** Used in error messages instead of the URL, which may carry an API key. */
    label: string;
}

/**
 * One HTTP call with a JSON response validated by `schema`.
 * - Network errors, timeouts, 429 and 5xx throw TransientError (429 carries Retry-After as the minimum wait).
 * - Other non-2xx throw HttpError (permanent); an unexpected response shape throws PermanentError.
 */
export async function requestJson<S extends z.ZodType>(request: HttpRequest<S>): Promise<z.output<S>> {
    const { method = "GET", url, headers = {}, body, schema, timeoutMs = 15_000, label } = request;
    const doFetch = request.fetch ?? fetch;
    let response: Response;
    try {
        response = await doFetch(url, {
            method,
            headers: {
                accept: "application/json",
                ...(body === undefined ? {} : { "content-type": "application/json" }),
                ...headers,
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (error) {
        throw new TransientError(`${label}: ${(error as Error).message}`, undefined, { cause: error });
    }

    const text = await response.text();
    if (response.status === 429) {
        throw new TransientError(`${label}: rate limited (429)`, retryAfterMs(response.headers.get("retry-after")));
    }
    if (response.status >= 500) throw new TransientError(`${label}: server error ${response.status}`);
    if (!response.ok) throw new HttpError(`${label}: ${response.status} ${errorMessage(text)}`, response.status, text);

    let json: unknown;
    try {
        json = response.status === 204 || text === "" ? undefined : JSON.parse(text);
    } catch {
        throw new PermanentError(`${label}: response is not JSON`);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new PermanentError(
            `${label}: unexpected response (${issue?.path.join(".") ?? ""}: ${issue?.message ?? ""})`,
        );
    }
    return parsed.data;
}

function retryAfterMs(header: string | null): number | undefined {
    const seconds = Number(header);
    return header !== null && Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

/** Vendors return `{"message": "..."}` or `{"Error Message": "..."}`; fall back to the start of the text. */
function errorMessage(text: string): string {
    try {
        const json = JSON.parse(text) as Record<string, unknown>;
        const message = json.message ?? json["Error Message"] ?? json.error;
        if (typeof message === "string") return message;
    } catch {
        // not JSON
    }
    return text.slice(0, 200);
}

/** Spaces calls so no more than `perMinute` start in any minute. */
export class RateLimiter {
    private next = 0;

    constructor(
        perMinute: number,
        private readonly now: () => number = Date.now,
        private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
        private readonly intervalMs = 60_000 / perMinute,
    ) {}

    async acquire(): Promise<void> {
        const now = this.now();
        const start = Math.max(now, this.next);
        this.next = start + this.intervalMs;
        if (start > now) await this.sleep(start - now);
    }
}
