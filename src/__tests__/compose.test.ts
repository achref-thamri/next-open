import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { composeApp } from "../compose.js";
import { parseConfig } from "../config/index.js";

describe("composeApp", () => {
    it("wires every adapter and use case without touching the network", async () => {
        const config = parseConfig({
            ALPACA_PAPER_KEY_ID: "id",
            ALPACA_PAPER_SECRET_KEY: "secret",
            FMP_API_KEY: "fmp",
            ANTHROPIC_API_KEY: "sk-ant",
            TELEGRAM_TOKEN: "123:abc",
            TELEGRAM_OWNER_CHAT_ID: "42",
            DATABASE_PATH: ":memory:",
        });

        const app = composeApp(config, pino({ level: "silent" }));

        expect(app.deps.config).toMatchObject({ mode: "paper", ownerChatId: 42, benchmarkSymbol: "VT" });
        expect(await app.deps.repos.settings.get()).toMatchObject({ halted: false });
        await app.scheduler.stop();
        app.db.close();
    });
});
