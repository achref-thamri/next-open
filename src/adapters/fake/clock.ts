import type { Clock } from "../../ports/clock.js";

/** A clock that only moves when told to. */
export class FakeClock implements Clock {
    private current: Date;

    constructor(start: Date | string) {
        this.current = new Date(start);
    }

    now(): Date {
        return new Date(this.current);
    }

    set(instant: Date | string): void {
        this.current = new Date(instant);
    }

    advance(ms: number): void {
        this.current = new Date(this.current.getTime() + ms);
    }
}
