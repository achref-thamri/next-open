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

/** A failure that will not go away by retrying: bad request, auth, validation. */
export class PermanentError extends Error {
    override name = "PermanentError";
}
