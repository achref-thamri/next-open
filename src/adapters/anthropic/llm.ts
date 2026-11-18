import type Anthropic from "@anthropic-ai/sdk";
import * as zod from "zod";
import type { Logger } from "../../lib/logger.js";
import type { Llm, LlmCallRecord, LlmDecisionOutput, LlmPrompt, LlmResult } from "../../ports/llm.js";

/** USD per million tokens (cache writes cost 1.25× input). Update when Anthropic changes prices. */
const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
    "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
    "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
};

/** The shape sent as the JSON schema. Numeric bounds are checked by `validateDecisions` in the app. */
const decisionOutputSchema = zod.strictObject({
    decisions: zod.array(
        zod.strictObject({
            ticker: zod.string(),
            action: zod.enum(["buy", "sell", "hold"]),
            targetWeight: zod.number(),
            confidence: zod.union([zod.literal(1), zod.literal(2), zod.literal(3), zod.literal(4), zod.literal(5)]),
            stopLossPct: zod.number(),
            takeProfitPct: zod.number(),
            // A refine, not zod.int(): the API rejects the minimum/maximum that zod.int() adds to the JSON schema.
            horizonDays: zod.number().refine(Number.isInteger, "must be a whole number of days"),
            reasoning: zod.string(),
        }),
    ),
    marketView: zod.string(),
});

const { $schema: _, ...schema } = zod.toJSONSchema(decisionOutputSchema, { target: "draft-7" });
const OUTPUT_FORMAT = { type: "json_schema" as const, schema };

/** The slice of the SDK client this adapter uses, so tests can pass a fake. */
export type MessagesClient = Pick<Anthropic, "beta">;

export interface AnthropicLlmOptions {
    client: MessagesClient;
    model: string;
    logger: Logger;
    now?: () => number;
}

/**
 * Claude as the trading model. The response is constrained to the decision schema with structured outputs and
 * validated again with zod. A refusal, a truncated answer or a shape mismatch returns `ok: false` with the raw
 * call, so it is stored and alerted on; API errors (after the SDK's own retries) throw.
 */
export class AnthropicLlm implements Llm {
    private readonly now: () => number;

    constructor(private readonly options: AnthropicLlmOptions) {
        // Fail at startup rather than record every call as free.
        if (!PRICES[options.model]) {
            throw new Error(
                `no price for ANTHROPIC_MODEL=${options.model}; add it to PRICES in src/adapters/anthropic/llm.ts`,
            );
        }
        this.now = options.now ?? Date.now;
    }

    async decide(prompt: LlmPrompt): Promise<LlmResult> {
        const started = this.now();
        const response = await this.options.client.beta.messages.create({
            model: this.options.model,
            max_tokens: 16_000,
            // On a policy decline the API retries on a fallback model in the same call.
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default",
            system: [{ type: "text", text: prompt.system, cache_control: { type: "ephemeral" } }],
            messages: [{ role: "user", content: prompt.user }],
            output_config: { effort: "high", format: OUTPUT_FORMAT },
        });

        const text = response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
        const usage = response.usage;
        const call: LlmCallRecord = {
            model: response.model,
            prompt,
            response: text,
            inputTokens:
                usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
            outputTokens: usage.output_tokens,
            costUsd: this.cost(response.model, usage),
            durationMs: this.now() - started,
        };

        if (response.stop_reason === "refusal") {
            const category = response.stop_details?.category ?? "unspecified";
            return { ok: false, error: `the model declined (${category})`, call };
        }
        if (response.stop_reason === "max_tokens")
            return { ok: false, error: "the answer was cut off at max_tokens", call };
        return { ...parseOutput(text), call };
    }

    private cost(
        model: string,
        usage: {
            input_tokens: number;
            output_tokens: number;
            cache_read_input_tokens: number | null;
            cache_creation_input_tokens: number | null;
        },
    ): number {
        let price = PRICES[model];
        if (!price) {
            // A server-side fallback can answer on another model; the configured one is the closest estimate.
            this.options.logger.warn({ model, pricedAs: this.options.model }, "no price for the answering model");
            price = PRICES[this.options.model] ?? { input: 0, output: 0, cacheRead: 0 };
        }
        const perToken = (usd: number) => usd / 1_000_000;
        return (
            usage.input_tokens * perToken(price.input) +
            (usage.cache_creation_input_tokens ?? 0) * perToken(price.input * 1.25) +
            (usage.cache_read_input_tokens ?? 0) * perToken(price.cacheRead) +
            usage.output_tokens * perToken(price.output)
        );
    }
}

/** Parses and validates the model's JSON answer. */
function parseOutput(text: string): { ok: true; output: LlmDecisionOutput } | { ok: false; error: string } {
    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch {
        return { ok: false, error: "the answer is not valid JSON" };
    }
    const parsed = decisionOutputSchema.safeParse(json);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return {
            ok: false,
            error: `the answer does not match the schema (${issue?.path.join(".") ?? ""}: ${issue?.message ?? ""})`,
        };
    }
    return { ok: true, output: parsed.data };
}
