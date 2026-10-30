import { describe, expect, it } from "vitest";
import { toTradingDate } from "../../core/types.js";
import { addDays, newYorkInstant } from "../calendar.js";

describe("addDays", () => {
    it("crosses month and year ends", () => {
        expect(addDays(toTradingDate("2026-12-30"), 3)).toBe("2027-01-02");
        expect(addDays(toTradingDate("2026-03-01"), -1)).toBe("2026-02-28");
    });
});

describe("newYorkInstant", () => {
    it("uses EDT in summer and EST in winter", () => {
        expect(newYorkInstant(toTradingDate("2026-10-30"), "09:25").toISOString()).toBe("2026-10-30T13:25:00.000Z");
        expect(newYorkInstant(toTradingDate("2026-11-03"), "09:25").toISOString()).toBe("2026-11-03T14:25:00.000Z");
    });

    it("handles the day the clocks change", () => {
        expect(newYorkInstant(toTradingDate("2026-03-09"), "16:30").toISOString()).toBe("2026-03-09T20:30:00.000Z");
        expect(newYorkInstant(toTradingDate("2026-03-06"), "16:30").toISOString()).toBe("2026-03-06T21:30:00.000Z");
    });
});
