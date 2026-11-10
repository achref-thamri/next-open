import { statSync } from "node:fs";

/** The scheduler ticks every minute; a heartbeat older than this means the process is stuck or dead. */
const MAX_HEARTBEAT_AGE_MS = 3 * 60_000;

export const HEARTBEAT_PATH = process.env.HEARTBEAT_PATH ?? "data/heartbeat";

/** True when the heartbeat file was touched recently. */
export function isHealthy(path: string, now = Date.now()): boolean {
    try {
        return now - statSync(path).mtimeMs <= MAX_HEARTBEAT_AGE_MS;
    } catch {
        return false;
    }
}

// Docker HEALTHCHECK entry point: exit 0 when healthy, 1 otherwise.
if (import.meta.url === `file://${process.argv[1] ?? ""}`) {
    process.exit(isHealthy(HEARTBEAT_PATH) ? 0 : 1);
}
