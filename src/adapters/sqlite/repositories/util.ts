/** Runs a synchronous database call and returns its result as a promise; throws become rejections. */
export function promised<T>(fn: () => T): Promise<T> {
    try {
        return Promise.resolve(fn());
    } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
}

export const toIso = (date: Date): string => date.toISOString();
export const fromIso = (value: string): Date => new Date(value);
export const optionalIso = (value: string | null): Date | undefined => (value === null ? undefined : new Date(value));
export const orUndefined = <T>(value: T | null): T | undefined => value ?? undefined;
export const bool = (value: number): boolean => value !== 0;

/** "?, ?, ?" for an IN clause. */
export function placeholders(count: number): string {
    return Array.from({ length: count }, () => "?").join(", ");
}
