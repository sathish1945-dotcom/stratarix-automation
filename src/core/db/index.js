/**
 * Database factory + migrations.
 *
 * Driver selection:
 *   1. TURSO_DATABASE_URL / DATABASE_URL (+ token)  → libSQL over HTTPS
 *   2. DATABASE_PATH                                 → SQLite file on disk
 *   3. otherwise                                     → in-process SQLite
 *      (works locally; on a serverless host this is ephemeral and a warning is
 *      logged so the failure mode is never a silent surprise)
 */
import { resolve } from 'node:path';
import { createFileDatabase } from './sqlite-file.js';
import { createLibsqlHttpDatabase } from './libsql-http.js';
import { ADDED_COLUMNS, DDL, SCHEMA_VERSION } from './schema.js';
import { logInfo } from '../errors.js';

const migrationCache = new WeakMap();

function connectionSettings(env) {
  const url = env.TURSO_DATABASE_URL || env.LIBSQL_URL || env.DATABASE_URL || '';
  const authToken = env.TURSO_AUTH_TOKEN || env.DATABASE_AUTH_TOKEN || env.LIBSQL_AUTH_TOKEN || '';
  return { url, authToken };
}

export function describeDatabase(env = process.env) {
  const { url, authToken } = connectionSettings(env);
  if (url && authToken && !/^file:/i.test(url)) return { driver: 'libsql-http', persistent: true };
  if (env.DATABASE_PATH) return { driver: 'sqlite-file', persistent: true };
  return { driver: 'memory', persistent: false };
}

export async function createDatabase({ env = process.env, forceMemory = false, fetchImpl = fetch } = {}) {
  const { url, authToken } = connectionSettings(env);

  if (!forceMemory && url && authToken && !/^file:/i.test(url)) {
    return createLibsqlHttpDatabase({ url, authToken, fetchImpl });
  }

  const path = forceMemory ? ':memory:' : env.DATABASE_PATH || ':memory:';
  const database = createFileDatabase({ path: path === ':memory:' ? ':memory:' : resolve(path) });
  if (!database.persistent) {
    logInfo('database.ephemeral', {
      hint: 'No DATABASE_PATH or TURSO_DATABASE_URL set. Data will not survive a restart of a serverless instance.',
    });
  }
  return database;
}

/** Apply schema + additive column migrations. Safe to run on every boot. */
export async function migrate(db, { onInfo = logInfo } = {}) {
  if (migrationCache.has(db)) return migrationCache.get(db);
  const promise = (async () => {
    for (const statement of DDL) await db.exec(statement);

    // Additive migrations for databases created by the first release.
    for (const [table, column, definition] of ADDED_COLUMNS) {
      const columns = await db.all(`PRAGMA table_info(${table})`);
      const exists = columns.some((entry) => String(entry.name) === column);
      if (!exists) {
        try {
          await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
          onInfo('database.column_added', { table, column });
        } catch (error) {
          // Two instances booting at the same time can race here; a duplicate
          // column error is harmless.
          if (!/duplicate column/i.test(String(error?.message || ''))) throw error;
        }
      }
    }

    const versionRow = await db.get(`SELECT value FROM meta WHERE key = 'schema_version'`);
    const version = Number(versionRow?.value || 0);
    if (version !== SCHEMA_VERSION) {
      await db.run(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [String(SCHEMA_VERSION)]);
    }
    return { version: SCHEMA_VERSION, previousVersion: version };
  })();
  migrationCache.set(db, promise);
  return promise;
}

export async function openDatabase({ env = process.env, forceMemory = false, fetchImpl = fetch, onInfo } = {}) {
  const db = await createDatabase({ env, forceMemory, fetchImpl });
  await migrate(db, onInfo ? { onInfo } : undefined);
  return db;
}
