import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Logger } from "../../lib/logger.js";
import type { Llm, LlmCallRecord, LlmDecisionOutput, LlmPrompt, LlmResult } from "../../ports/llm.js";

/** USD per million tokens (cache writes cost 1.25× input). Update when Anthropic changes prices. */
export const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
    "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
    "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
};

/** The shape sent as the JSON schema. Numeric bounds are checked by `validateDecisions` in the app. */
export const decisionOutputSchema = z.strictObject({
    decisions: z.array(
        z.strictObject({
            ticker: z.string(),
            action: z.enum(["buy", "sell", "hold"]),
            targetWeight: z.number(),
            confidence: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
            stopLossPct: z.number(),
            takeProfitPct: z.number(),
            // A refine, not z.int(): the API rejects the minimum/maximum that z.int() adds to the JSON schema.
            horizonDays: z.number().refine(Number.isInteger, "must be a whole number of days"),
            reasoning: z.string(),
        }),
    ),
    marketView: z.string(),
});

const { $schema: _, ...schema } = z.toJSONSchema(decisionOutputSchema, { target: "draft-7" });
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
        const price = PRICES[model];
        if (!price) {
            this.options.logger.warn({ model }, "no price for model; cost recorded as 0");
            return 0;
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
export function parseOutput(text: string): { ok: true; output: LlmDecisionOutput } | { ok: false; error: string } {
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
