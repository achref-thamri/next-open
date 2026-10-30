import type { Notifier } from "../../ports/notifier.js";
import { FailureInjector } from "./failures.js";

export type SentMessage =
    | { kind: "text"; text: string }
    | { kind: "proposal"; text: string; proposalId: string }
    | { kind: "approve_all"; text: string; tradeDate: string };

/** Collects messages instead of sending them. */
export class FakeNotifier implements Notifier {
    readonly failures = new FailureInjector();
    readonly sent: SentMessage[] = [];

    async send(text: string): Promise<void> {
        await this.failures.check("send");
        this.sent.push({ kind: "text", text });
    }

    async sendProposal(text: string, proposalId: string): Promise<void> {
        await this.failures.check("sendProposal");
        this.sent.push({ kind: "proposal", text, proposalId });
    }

    async sendApproveAll(text: string, tradeDate: string): Promise<void> {
        await this.failures.check("sendApproveAll");
        this.sent.push({ kind: "approve_all", text, tradeDate });
    }

    /** All message texts, for simple assertions. */
    texts(): string[] {
        return this.sent.map((m) => m.text);
    }
}
