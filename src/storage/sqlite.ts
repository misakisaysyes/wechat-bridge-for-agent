import Database from "better-sqlite3";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type BridgeDatabase = Database.Database;

export function openDatabase(databasePath: string): BridgeDatabase {
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(dirname(databasePath), 0o700);

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
    database.exec(`
      CREATE TABLE IF NOT EXISTS wechat_accounts (
        id TEXT PRIMARY KEY,
        bot_token TEXT NOT NULL,
        base_url TEXT NOT NULL,
        user_id TEXT,
        cursor TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL DEFAULT 'active',
        resume_at INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS wechat_sessions (
        account_id TEXT NOT NULL REFERENCES wechat_accounts(id),
        contact_id TEXT NOT NULL,
        context_token TEXT,
        context_generation INTEGER NOT NULL DEFAULT 0,
        last_inbound_at INTEGER NOT NULL,
        PRIMARY KEY(account_id, contact_id)
      );
      CREATE TABLE IF NOT EXISTS inbound_messages (
        account_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        PRIMARY KEY(account_id,message_id),
        FOREIGN KEY(account_id,contact_id) REFERENCES wechat_sessions(account_id,contact_id)
      );
      CREATE TABLE IF NOT EXISTS agent_bindings (
        account_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        target_agent TEXT NOT NULL,
        selected_at INTEGER NOT NULL,
        PRIMARY KEY(account_id,contact_id),
        FOREIGN KEY(account_id,contact_id) REFERENCES wechat_sessions(account_id,contact_id)
      );
      CREATE TABLE IF NOT EXISTS user_requests (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        text TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'queued',
        agent_message_id TEXT,
        reply_cursor TEXT,
        last_reply_at INTEGER,
        next_poll_at INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(account_id, message_id),
        FOREIGN KEY(account_id, contact_id) REFERENCES wechat_sessions(account_id, contact_id)
      );
      CREATE TABLE IF NOT EXISTS agent_events (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        event_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(source, event_id),
        FOREIGN KEY(account_id, contact_id) REFERENCES wechat_sessions(account_id, contact_id)
      );
      CREATE TABLE IF NOT EXISTS outbox_messages (
        id TEXT PRIMARY KEY,
        event_id TEXT REFERENCES agent_events(id),
        request_id TEXT REFERENCES user_requests(id),
        reply_id TEXT,
        account_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        text TEXT NOT NULL,
        client_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        context_generation INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(account_id, contact_id) REFERENCES wechat_sessions(account_id, contact_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS outbox_reply_unique ON outbox_messages(request_id,reply_id);
      CREATE INDEX IF NOT EXISTS outbox_due ON outbox_messages(status, next_attempt_at, created_at);
      CREATE TABLE IF NOT EXISTS workbuddy_credentials (
        id TEXT PRIMARY KEY CHECK(id = 'default'),
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        open_id TEXT,
        scope TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_states (
        state TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      );
    `);
    const accountColumns = database.pragma("table_info(wechat_accounts)") as { name: string }[];
    if (!accountColumns.some((column) => column.name === "resume_at")) {
      database.exec("ALTER TABLE wechat_accounts ADD COLUMN resume_at INTEGER NOT NULL DEFAULT 0");
    }

    if (process.platform !== "win32") {
      chmodSync(databasePath, 0o600);
    }

    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
