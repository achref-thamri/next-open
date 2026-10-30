import { describe, expect, it } from "vitest";
import { clientOrderId, newId } from "../ids.js";

describe("ids", () => {
    it("creates unique ULIDs in creation order, even within one millisecond", () => {
        const ids = Array.from({ length: 1000 }, newId);

        expect(new Set(ids).size).toBe(ids.length);
        expect(ids.every((id) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id))).toBe(true);
        expect(ids.toSorted()).toEqual(ids);
    });

    it("derives a stable client order id within the broker's 128-char limit", () => {
        const proposalId = newId();

        expect(clientOrderId(proposalId)).toBe(clientOrderId(proposalId));
        expect(clientOrderId(proposalId)).toBe(`tb-${proposalId}`);
        expect(clientOrderId(proposalId).length).toBeLessThanOrEqual(128);
    });
});
