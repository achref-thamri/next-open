/** The only source of the current time; core and use cases never call `new Date()` themselves. */
export interface Clock {
    now(): Date;
}
