import Database from "better-sqlite3";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type BridgeDatabase = Database.Database;

export function openDatabase(databasePath: string): BridgeDatabase {
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });

  const database = new Database(databasePath);
  try {
    database.pragma("journal_mode = WAL");
    database.pragma("foreign_keys = ON");
    database.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (" +
        "version INTEGER PRIMARY KEY, " +
        "applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP" +
        ")",
    );

    if (process.platform !== "win32") {
      chmodSync(databasePath, 0o600);
    }

    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
