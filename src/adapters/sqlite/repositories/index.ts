import type { Repositories } from "../../../ports/repositories.js";
import type { Db } from "../db.js";
import { SqliteCandidatesRepository, SqliteDecisionsRepository, SqliteLlmCallsRepository } from "./analysis.js";
import { SqliteRunsRepository } from "./runs.js";
import {
    SqliteApiUsageRepository,
    SqliteEquitySnapshotsRepository,
    SqliteLiquidListsRepository,
    SqliteProfilesRepository,
    SqliteSettingsRepository,
} from "./state.js";
import { SqliteFillsRepository, SqliteOrdersRepository, SqliteProposalsRepository } from "./trading.js";

/** Every repository over one migrated database. */
export function createSqliteRepositories(db: Db): Repositories {
    return {
        runs: new SqliteRunsRepository(db),
        candidates: new SqliteCandidatesRepository(db),
        llmCalls: new SqliteLlmCallsRepository(db),
        decisions: new SqliteDecisionsRepository(db),
        proposals: new SqliteProposalsRepository(db),
        orders: new SqliteOrdersRepository(db),
        fills: new SqliteFillsRepository(db),
        equity: new SqliteEquitySnapshotsRepository(db),
        settings: new SqliteSettingsRepository(db),
        profiles: new SqliteProfilesRepository(db),
        liquidLists: new SqliteLiquidListsRepository(db),
        apiUsage: new SqliteApiUsageRepository(db),
    };
}
