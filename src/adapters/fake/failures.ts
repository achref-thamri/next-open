/** Queues errors that the next calls to a named method throw, to test retries and partial failures. */
export class FailureInjector {
    private readonly queued = new Map<string, Error[]>();

    /** The next `times` calls to `method` throw `error`. */
    failNext(method: string, error: Error, times = 1): void {
        this.queued.set(method, [...(this.queued.get(method) ?? []), ...Array.from({ length: times }, () => error)]);
    }

    /** Throws the next queued error for `method`, if any. Async so failures surface as rejected promises. */
    check(method: string): Promise<void> {
        const error = this.queued.get(method)?.shift();
        return error ? Promise.reject(error) : Promise.resolve();
    }
}
