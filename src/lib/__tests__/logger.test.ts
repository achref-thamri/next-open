import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "../logger.js";

function capture() {
    const lines: string[] = [];
    const stream = new Writable({
        write(chunk: Buffer, _encoding, done) {
            lines.push(chunk.toString());
            done();
        },
    });
    return { stream, output: () => lines.join("") };
}

describe("createLogger", () => {
    it("redacts secrets at any depth up to the config object", () => {
        const { stream, output } = capture();
        const logger = createLogger("info", stream);

        logger.info({
            apiKey: "top-secret-1",
            config: {
                alpaca: { keyId: "top-secret-2", secretKey: "top-secret-3" },
                telegram: { botToken: "top-secret-4" },
            },
            request: { headers: { "apca-api-secret-key": "top-secret-5" } },
        });

        expect(output()).not.toMatch(/top-secret/);
        expect(output()).toContain("[redacted]");
    });

    it("keeps non-secret fields", () => {
        const { stream, output } = capture();

        createLogger("info", stream).info({ ticker: "AAPL", qty: 3 }, "order placed");

        const line = JSON.parse(output()) as Record<string, unknown>;
        expect(line).toMatchObject({ ticker: "AAPL", qty: 3, msg: "order placed", level: 30 });
        expect(typeof line.time).toBe("string");
    });

    it("respects the level", () => {
        const { stream, output } = capture();

        createLogger("warn", stream).info("hidden");

        expect(output()).toBe("");
    });
});
