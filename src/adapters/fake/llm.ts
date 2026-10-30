import type { Llm, LlmDecisionOutput, LlmPrompt, LlmResult } from "../../ports/llm.js";
import { FailureInjector } from "./failures.js";

type Responder = (prompt: LlmPrompt) => LlmDecisionOutput | string;

/**
 * Answers with a fixed output, or with a string to simulate a response that fails validation.
 * Records every prompt.
 */
export class FakeLlm implements Llm {
    readonly failures = new FailureInjector();
    readonly prompts: LlmPrompt[] = [];

    constructor(
        private responder: Responder = () => ({ decisions: [], marketView: "" }),
        readonly model = "fake-model",
    ) {}

    respondWith(responder: Responder | LlmDecisionOutput | string): void {
        this.responder = typeof responder === "function" ? responder : () => responder;
    }

    async decide(prompt: LlmPrompt): Promise<LlmResult> {
        await this.failures.check("decide");
        this.prompts.push(prompt);
        const answer = this.responder(prompt);
        const response = typeof answer === "string" ? answer : JSON.stringify(answer);
        const call = {
            model: this.model,
            prompt,
            response,
            inputTokens: 1000,
            outputTokens: 200,
            costUsd: 0.01,
            durationMs: 1,
        };
        return typeof answer === "string"
            ? { ok: false, error: "response failed validation", call }
            : { ok: true, output: answer, call };
    }
}
