import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../index.js";

const baseEnv = {
    ALPACA_PAPER_KEY_ID: "paper-id",
    ALPACA_PAPER_SECRET_KEY: "paper-secret",
    FMP_API_KEY: "fmp-key",
    ANTHROPIC_API_KEY: "sk-ant-very-secret",
    TELEGRAM_BOT_TOKEN: "123:abc",
    TELEGRAM_OWNER_CHAT_ID: "42",
};

function errorOf(fn: () => unknown): string {
    try {
        fn();
    } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        return (error as ConfigError).message;
    }
    throw new Error("expected a ConfigError");
}

describe("parseConfig", () => {
    it("applies spec defaults", () => {
        const config = parseConfig(baseEnv);

        expect(config.mode).toBe("paper");
        expect(config.alpaca).toEqual({ keyId: "paper-id", secretKey: "paper-secret" });
        expect(config.anthropic.model).toBe("claude-sonnet-5-5");
        expect(config.telegram.ownerChatId).toBe(42);
        expect(config.benchmarkSymbol).toBe("VT");
        expect(config.risk).toEqual({
            maxPositionWeight: 0.1,
            maxPositions: 15,
            minCashWeight: 0.1,
            dailyLossStopPct: 0.03,
            maxOrdersPerDay: 10,
            maxDailyTradedWeight: 0.3,
            maxEntryGapPct: 0.01,
        });
        expect(config.universe.maxCandidates).toBe(40);
        expect(config.tax.shareHighRate).toBe(0.42);
    });

    it("reports a missing secret by name", () => {
        const { FMP_API_KEY: _, ...env } = baseEnv;

        expect(errorOf(() => parseConfig(env))).toMatch(/FMP_API_KEY[\s\S]*is required/);
    });

    it("treats empty strings as missing", () => {
        expect(errorOf(() => parseConfig({ ...baseEnv, TELEGRAM_BOT_TOKEN: "" }))).toContain("TELEGRAM_BOT_TOKEN");
    });

    it("lists every problem at once", () => {
        const message = errorOf(() => parseConfig({}, { risk: { maxPositions: 0 } }));

        expect(message).toContain("FMP_API_KEY");
        expect(message).toContain("ANTHROPIC_API_KEY");
        expect(message).toContain("maxPositions");
    });

    it("requires paper keys in paper mode", () => {
        const { ALPACA_PAPER_SECRET_KEY: _, ...env } = baseEnv;

        expect(errorOf(() => parseConfig(env))).toContain("ALPACA_PAPER_SECRET_KEY");
    });

    it("requires live keys in live mode", () => {
        expect(errorOf(() => parseConfig({ ...baseEnv, TRADING_MODE: "live" }))).toMatch(
            /ALPACA_LIVE_KEY_ID[\s\S]*TRADING_MODE=live/,
        );
    });

    it("uses live keys in live mode", () => {
        const config = parseConfig({
            ...baseEnv,
            TRADING_MODE: "live",
            ALPACA_LIVE_KEY_ID: "live-id",
            ALPACA_LIVE_SECRET_KEY: "live-secret",
        });

        expect(config.mode).toBe("live");
        expect(config.alpaca).toEqual({ keyId: "live-id", secretKey: "live-secret" });
    });

    it("rejects an unknown trading mode", () => {
        expect(errorOf(() => parseConfig({ ...baseEnv, TRADING_MODE: "yolo" }))).toContain("TRADING_MODE");
    });

    it("rejects a non-integer chat id", () => {
        expect(errorOf(() => parseConfig({ ...baseEnv, TELEGRAM_OWNER_CHAT_ID: "me" }))).toContain(
            "TELEGRAM_OWNER_CHAT_ID",
        );
    });

    it("keeps defaults for settings that are not overridden", () => {
        const config = parseConfig(baseEnv, { risk: { maxPositions: 10 } });

        expect(config.risk.maxPositions).toBe(10);
        expect(config.risk.maxPositionWeight).toBe(0.1);
    });

    it.each([
        ["position weight above 100%", { risk: { maxPositionWeight: 1.5 } }, "maxPositionWeight"],
        ["negative position count", { risk: { maxPositions: -1 } }, "maxPositions"],
        ["fractional order count", { risk: { maxOrdersPerDay: 2.5 } }, "maxOrdersPerDay"],
        ["position weight leaving no room for cash", { risk: { maxPositionWeight: 0.95 } }, "1 - minCashWeight"],
        ["gap cap above 10%", { risk: { maxEntryGapPct: 0.2 } }, "maxEntryGapPct"],
        ["unknown key (typo)", { risk: { maxPosition: 0.1 } }, "maxPosition"],
        ["too many candidates", { universe: { maxCandidates: 500 } }, "maxCandidates"],
    ])("rejects %s", (_, settings, expected) => {
        expect(errorOf(() => parseConfig(baseEnv, settings))).toContain(expected);
    });

    it("never echoes secret values in errors", () => {
        const message = errorOf(() => parseConfig({ ...baseEnv, TELEGRAM_OWNER_CHAT_ID: "x" }));

        expect(message).not.toContain(baseEnv.ANTHROPIC_API_KEY);
        expect(message).not.toContain(baseEnv.ALPACA_PAPER_SECRET_KEY);
    });
});
