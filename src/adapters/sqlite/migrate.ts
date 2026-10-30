import type { Db } from "./db.js";
import { MIGRATIONS, type Migration } from "./migrations/index.js";

/**
 * Applies pending migrations in order, each in its own transaction together with the user_version bump, so a
 * failing migration leaves the database at the previous version. Returns the versions applied.
 */
export function migrate(db: Db, migrations: readonly Migration[] = MIGRATIONS): number[] {
    migrations.forEach((m, i) => {
        if (m.version !== i + 1) throw new Error(`Migration ${m.name} has version ${m.version}, expected ${i + 1}`);
    });
    const current = db.pragma("user_version", { simple: true }) as number;
    if (current > migrations.length) {
        throw new Error(`Database is at version ${current}, newer than this build (${migrations.length})`);
    }

    const applied: number[] = [];
    for (const migration of migrations.slice(current)) {
        db.transaction(() => {
            db.exec(migration.sql);
            db.pragma(`user_version = ${migration.version}`);
        })();
        applied.push(migration.version);
    }
    return applied;
}
