import { openDatabase } from "./adapters/sqlite/db.js";
import { resetPaperHistory } from "./adapters/sqlite/resetPaper.js";
import { loadConfig } from "./config/index.js";

/**
 * Clears the paper trading history after the Alpaca paper account was reset to a new balance, so the go-live gate,
 * reports and virtual strategies start again from the new account. Refuses in live mode.
 */
function main(): void {
    const config = loadConfig();
    if (config.mode !== "paper") {
        console.error("Refused: reset-paper only runs in paper mode.");
        process.exit(1);
    }
    const db = openDatabase(config.databasePath);
    const deleted = resetPaperHistory(db);
    db.close();
    for (const [table, rows] of Object.entries(deleted)) console.log(`${table}: ${rows} deleted`);
    console.log("Paper history cleared. Restart Next Open so it starts from the new account.");
}

main();
