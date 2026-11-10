import { pino, type DestinationStream, type Logger } from "pino";
import type { LogLevel } from "../config/index.js";

export type { Logger } from "pino";

const SECRET_KEYS = ["apiKey", "secretKey", "keyId", "token", "authorization", "apikey"];
const SECRET_HEADERS = ["apca-api-key-id", "apca-api-secret-key", "x-api-key"];

/** Redacts secret keys at the top level and up to three levels deep, plus known auth headers. */
const REDACT_PATHS = [
    ...SECRET_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`, `*.*.*.${key}`]),
    ...SECRET_HEADERS.flatMap((header) => [`headers["${header}"]`, `*.headers["${header}"]`]),
];

export function createLogger(level: LogLevel, destination?: DestinationStream): Logger {
    return pino(
        {
            level,
            redact: { paths: REDACT_PATHS, censor: "[redacted]" },
            timestamp: pino.stdTimeFunctions.isoTime,
        },
        destination,
    );
}
