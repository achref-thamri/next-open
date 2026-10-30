import { initial } from "./001-initial.js";
import { shadowPortfolios } from "./002-shadow-portfolios.js";

export interface Migration {
    /** Becomes PRAGMA user_version once applied. Versions start at 1 and increase by one. */
    version: number;
    name: string;
    sql: string;
}

/** Append only: never edit a migration that has shipped. */
export const MIGRATIONS: readonly Migration[] = [
    { version: 1, name: "initial", sql: initial },
    { version: 2, name: "shadow portfolios", sql: shadowPortfolios },
];
