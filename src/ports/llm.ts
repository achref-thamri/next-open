import type { Decision } from "../core/types.js";

export interface LlmPrompt {
    system: string;
    user: string;
}

/** A decision as the model returned it: shape checked, tickers and holdings not yet checked. */
export type RawDecision = Omit<Decision, "ticker"> & { ticker: string };

export interface LlmDecisionOutput {
    decisions: RawDecision[];
    marketView: string;
}

/** Everything needed to replay and audit one call. */
export interface LlmCallRecord {
    model: string;
    prompt: LlmPrompt;
    /** Raw response text. */
    response: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    durationMs: number;
}

export type LlmResult =
    { ok: true; output: LlmDecisionOutput; call: LlmCallRecord } | { ok: false; error: string; call: LlmCallRecord };

/** The trading model. Transport failures throw; a response that fails validation returns `ok: false`. */
export interface Llm {
    decide(prompt: LlmPrompt): Promise<LlmResult>;
}
