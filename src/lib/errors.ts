/** A failure worth retrying: timeouts, network errors, HTTP 429 and 5xx. */
export class TransientError extends Error {
    override name = "TransientError";

    constructor(
        message: string,
        /** Server-requested wait (e.g. Retry-After), used as the minimum delay before the next attempt. */
        readonly retryAfterMs?: number,
        options?: ErrorOptions,
    ) {
        super(message, options);
    }
}

/** HTTP 429: retryable after a wait, but a daily quota may need special handling by the caller. */
export class RateLimitError extends TransientError {
    override name = "RateLimitError";
}

/** A failure that will not go away by retrying: bad request, auth, validation. */
export class PermanentError extends Error {
    override name = "PermanentError";
}

/** A non-retryable HTTP response (4xx other than 429). */
export class HttpError extends PermanentError {
    override name = "HttpError";

    constructor(
        message: string,
        readonly status: number,
        /** Response body text, for vendor error codes. */
        readonly body: string,
    ) {
        super(message);
    }
}
