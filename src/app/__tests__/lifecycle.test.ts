import { beforeEach, describe, expect, it } from "vitest";
import { markStarted, markStopped } from "../lifecycle.js";
import { harness, type Harness } from "./harness.js";

describe("markStarted", () => {
    let h: Harness;

    beforeEach(() => {
        h = harness();
    });

    it("stays silent on the first start and marks the bot running", async () => {
        await markStarted(h);

        expect(h.notifier.sent).toEqual([]);
        expect((await h.repos.settings.get()).running).toBe(true);
    });

    it("stays silent after a clean shutdown", async () => {
        await markStarted(h);
        await markStopped(h);

        await markStarted(h);

        expect(h.notifier.sent).toEqual([]);
    });

    it("warns after a run that ended without a clean shutdown", async () => {
        await markStarted(h);

        await markStarted(h);

        expect(h.notifier.sent).toHaveLength(1);
        expect(h.notifier.sent[0]?.text).toContain("restarted unexpectedly (paper mode)");
    });

    it("warns at most once an hour during a crash loop", async () => {
        await markStarted(h);
        for (let i = 0; i < 5; i++) {
            h.clock.advance(60_000);
            await markStarted(h);
        }
        expect(h.notifier.sent).toHaveLength(1);

        h.clock.advance(60 * 60_000);
        await markStarted(h);

        expect(h.notifier.sent).toHaveLength(2);
    });
});
