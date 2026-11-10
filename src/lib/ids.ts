import { monotonicFactory } from "ulid";

const ulid = monotonicFactory();

/** Unique id (ULID), strictly increasing even within the same millisecond. */
export function newId(): string {
    return ulid();
}

/** Broker client order id for a proposal. Stable, so retries and restarts never double-submit. */
export function clientOrderId(proposalId: string): string {
    return `no-${proposalId}`;
}
