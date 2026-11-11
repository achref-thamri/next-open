import { readFileSync } from "node:fs";
import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import { riskSchema } from "../../../config/schema.js";
import { toTicker } from "../../../core/types.js";
import { validateDecisions } from "../../../app/validateDecisions.js";
import { AnthropicLlm, type MessagesClient } from "../llm.js";

const fixture = (name: string): unknown =>
    JSON.parse(readFileSync(new URL(`../__fixtures__/${name}`, import.meta.url), "utf8"));

function llm(response: unknown) {
    const create = vi.fn(() => Promise.resolve(response));
    let t = 1000;
    const adapter = new AnthropicLlm({
        client: { beta: { messages: { create } } } as unknown as MessagesClient,
        model: "claude-sonnet-5-5",
        logger: pino({ level: "silent" }),
        now: () => (t += 250),
    });
    return { adapter, create };
}

const prompt = { system: "You manage a portfolio.", user: "<market_data>{}</market_data>" };
const shortlist = new Set([toTicker("AAPL"), toTicker("MSFT")]);
const limits = riskSchema.parse({});

describe("AnthropicLlm", () => {
    it("sends the prompt with structured output, caching and fallbacks", async () => {
        const { adapter, create } = llm(fixture("valid.json"));

        await adapter.decide(prompt);

        const params = (create.mock.calls[0] as unknown[] | undefined)?.[0] as Record<string, unknown>;
        expect(params).toMatchObject({
            model: "claude-sonnet-5-5",
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default",
            system: [{ type: "text", text: prompt.system, cache_control: { type: "ephemeral" } }],
            messages: [{ role: "user", content: prompt.user }],
            output_config: { effort: "high", format: { type: "json_schema" } },
        });
        const schema = JSON.stringify((params.output_config as { format: unknown }).format);
        expect(schema).toContain('"additionalProperties":false');
        expect(schema).not.toMatch(/minimum|maximum|\$schema/);
    });

    it("returns a valid answer with the call record, tokens and cost", async () => {
        const { adapter } = llm(fixture("valid.json"));

        const result = await adapter.decide(prompt);

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.output.decisions.map((d) => d.ticker)).toEqual(["AAPL", "MSFT"]);
        expect(result.output.marketView).toBe("Risk-on after the Fed.");
        expect(result.call).toMatchObject({
            model: "claude-sonnet-5-5",
            prompt,
            inputTokens: 14_000,
            outputTokens: 1_500,
            durationMs: 250,
        });
        // 12,000 × $2 + 2,000 × $0.20 + 1,500 × $10 per million
        expect(result.call.costUsd).toBeCloseTo(0.0394, 6);
        expect(validateDecisions(result.output, shortlist, new Set(), limits).ok).toBe(true);
    });

    it("reports malformed JSON as invalid and keeps the raw text", async () => {
        const { adapter } = llm(fixture("malformed.json"));

        const result = await adapter.decide(prompt);

        expect(result).toMatchObject({ ok: false, error: "the answer is not valid JSON" });
        expect(result.call.response).toContain('"ticker": "AAPL"');
    });

    it("passes an unknown ticker through for the app to reject", async () => {
        const { adapter } = llm(fixture("unknown-ticker.json"));

        const result = await adapter.decide(prompt);

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(validateDecisions(result.output, shortlist, new Set(), limits)).toEqual({
            ok: false,
            errors: ["unknown ticker NOTREAL"],
        });
    });

    it("passes an oversized weight through for the app to reject", async () => {
        const { adapter } = llm(fixture("oversized-weight.json"));

        const result = await adapter.decide(prompt);

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(validateDecisions(result.output, shortlist, new Set(), limits)).toEqual({
            ok: false,
            errors: ["AAPL target weight 0.5 outside 0..0.2"],
        });
    });

    it("rejects answers that break the schema", async () => {
        const base = fixture("valid.json") as { content: unknown[] };
        const bad = {
            ...base,
            content: [{ type: "text", text: '{"decisions":[{"ticker":"AAPL","action":"short"}],"marketView":""}' }],
        };

        expect((await llm(bad).adapter.decide(prompt)).ok).toBe(false);
    });

    it("reports a refusal and a truncated answer as invalid", async () => {
        expect(await llm(fixture("refusal.json")).adapter.decide(prompt)).toMatchObject({
            ok: false,
            error: "the model declined (cyber)",
        });
        const truncated = { ...(fixture("valid.json") as object), stop_reason: "max_tokens" };
        expect(await llm(truncated).adapter.decide(prompt)).toMatchObject({
            ok: false,
            error: "the answer was cut off at max_tokens",
        });
    });

    it("records zero cost for a model without a price", async () => {
        const other = { ...(fixture("valid.json") as object), model: "claude-future-9" };

        expect((await llm(other).adapter.decide(prompt)).call.costUsd).toBe(0);
    });

    it("lets API errors propagate", async () => {
        const create = vi.fn(() => Promise.reject(new Error("overloaded")));
        const adapter = new AnthropicLlm({
            client: { beta: { messages: { create } } } as unknown as MessagesClient,
            model: "claude-sonnet-5-5",
            logger: pino({ level: "silent" }),
        });

        await expect(adapter.decide(prompt)).rejects.toThrow("overloaded");
    });
});
