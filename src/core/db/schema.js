/**
 * Schema + additive migrations.
 *
 * The first release of this project already shipped a `users` and `sessions`
 * table without a migration table, so every statement here is written to be safe
 * against an existing production database: tables use IF NOT EXISTS and new
 * columns are added only when they are missing.
 */

export const SCHEMA_VERSION = 2;

export const DDL = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS users (
     id INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     email TEXT NOT NULL UNIQUE,
     salt TEXT NOT NULL,
     password_hash TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token_hash TEXT PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     expires_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS session_expiry ON sessions(expires_at)`,
  `CREATE TABLE IF NOT EXISTS tasks (
     id INTEGER PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     title TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     due_at INTEGER,
     all_day INTEGER NOT NULL DEFAULT 0,
     timezone TEXT NOT NULL DEFAULT 'UTC',
     recurrence TEXT,
     priority TEXT NOT NULL DEFAULT 'normal',
     status TEXT NOT NULL DEFAULT 'open',
     source TEXT NOT NULL DEFAULT 'manual',
     ai_confidence REAL,
     reminder_offset INTEGER NOT NULL DEFAULT 0,
     notified_at INTEGER,
     completed_at INTEGER,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS task_owner ON tasks(user_id, status, due_at)`,
  `CREATE INDEX IF NOT EXISTS task_due ON tasks(user_id, due_at)`,
  `CREATE TABLE IF NOT EXISTS chat_messages (
     id INTEGER PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     role TEXT NOT NULL,
     content TEXT NOT NULL,
     source TEXT,
     task_id INTEGER,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS chat_owner ON chat_messages(user_id, id)`,
  `CREATE TABLE IF NOT EXISTS push_subscriptions (
     id INTEGER PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     endpoint TEXT NOT NULL,
     keys TEXT NOT NULL DEFAULT '{}',
     created_at INTEGER NOT NULL
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS push_endpoint ON push_subscriptions(endpoint)`,
];

/** Columns added after the first release, applied only when missing. */
export const ADDED_COLUMNS = [
  ['users', 'password_algo', "TEXT NOT NULL DEFAULT 'legacy'"],
  ['users', 'timezone', "TEXT NOT NULL DEFAULT 'UTC'"],
  ['users', 'last_seen_at', 'INTEGER'],
  ['sessions', 'created_at', 'INTEGER'],
  ['sessions', 'user_agent', "TEXT NOT NULL DEFAULT ''"],
];
