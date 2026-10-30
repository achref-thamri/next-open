import { describe, expect, it } from "vitest";
import { moveScore, rankCandidates } from "../ranking.js";
import { candidate } from "./fixtures.js";

const tickers = (list: { ticker: string }[]) => list.map((c) => c.ticker);

describe("moveScore", () => {
    it("weights the absolute move by relative volume", () => {
        expect(moveScore({ changePct: -0.05, relativeVolume: 2 })).toBeCloseTo(0.1);
        expect(moveScore({ changePct: 0.05, relativeVolume: 2 })).toBeCloseTo(0.1);
    });
});

describe("rankCandidates", () => {
    it("orders by move score, down moves count as much as up moves", () => {
        const ranked = rankCandidates(
            [
                candidate({ ticker: "SMALL", changePct: 0.01, relativeVolume: 1 }),
                candidate({ ticker: "DOWN", changePct: -0.08, relativeVolume: 2 }),
                candidate({ ticker: "UP", changePct: 0.06, relativeVolume: 2 }),
            ],
            10,
        );

        expect(tickers(ranked)).toEqual(["DOWN", "UP", "SMALL"]);
    });

    it("breaks ties by ticker", () => {
        const ranked = rankCandidates([candidate({ ticker: "BBB" }), candidate({ ticker: "AAA" })], 10);

        expect(tickers(ranked)).toEqual(["AAA", "BBB"]);
    });

    it("caps the list", () => {
        const many = Array.from({ length: 50 }, (_, i) =>
            candidate({ ticker: `T${String(i).padStart(2, "0")}`, changePct: i / 100 }),
        );

        const ranked = rankCandidates(many, 40);

        expect(ranked).toHaveLength(40);
        expect(ranked[0]?.ticker).toBe("T49");
        expect(ranked.at(-1)?.ticker).toBe("T10");
    });

    it("always includes holdings first, filling the rest by score", () => {
        const ranked = rankCandidates(
            [
                candidate({ ticker: "HOT", changePct: 0.2, relativeVolume: 5 }),
                candidate({ ticker: "WARM", changePct: 0.1, relativeVolume: 2 }),
                candidate({ ticker: "HELD", changePct: 0, isHolding: true }),
            ],
            2,
        );

        expect(tickers(ranked)).toEqual(["HELD", "HOT"]);
    });

    it("never cuts holdings, even when they exceed the cap", () => {
        const ranked = rankCandidates(
            [
                candidate({ ticker: "HOT", changePct: 0.2 }),
                candidate({ ticker: "H1", isHolding: true }),
                candidate({ ticker: "H2", isHolding: true }),
                candidate({ ticker: "H3", isHolding: true }),
            ],
            2,
        );

        expect(tickers(ranked)).toEqual(["H1", "H2", "H3"]);
    });

    it("puts tickers in the news ahead of other movers", () => {
        const ranked = rankCandidates(
            [
                candidate({ ticker: "HOT", changePct: 0.2, relativeVolume: 5 }),
                candidate({ ticker: "NEWS", changePct: 0.001, inNews: true }),
            ],
            1,
        );

        expect(tickers(ranked)).toEqual(["NEWS"]);
    });
});
