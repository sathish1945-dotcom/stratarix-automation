/**
 * SQLite driver backed by `node:sqlite` (Node 22.5+ / Node 24 LTS).
 *
 * Used for local development, the Node host deployment and tests. The same async
 * interface is implemented by the libSQL HTTP driver so the application code
 * never needs to know which one is active.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { serverFailure } from '../errors.js';

export function createFileDatabase({ path = ':memory:', readOnly = false } = {}) {
  const target = path === ':memory:' ? path : resolve(path);
  if (target !== ':memory:') {
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  }
  const database = new DatabaseSync(target, readOnly ? { readOnly: true } : {});
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('PRAGMA busy_timeout = 5000');

  const wrap = (error) => {
    if (error?.code === 'SQLITE_CONSTRAINT_UNIQUE') return error;
    if (error?.code === 'ERR_SQLITE_ERROR' && /no such table|no such column/i.test(String(error.message))) {
      // Schema problems are a deployment bug, not a user error.
      const wrapped = serverFailure('The database is not ready yet. Please try again in a moment.', 'db_not_ready');
      wrapped.cause = error;
      return wrapped;
    }
    if (error?.code === 'ERR_INVALID_STATE') {
      const wrapped = serverFailure('The database is temporarily unavailable.', 'db_unavailable');
      wrapped.cause = error;
      return wrapped;
    }
    if (error instanceof Error && error.name === 'AppError') return error;
    const wrapped = serverFailure('The database is temporarily unavailable.', 'db_unavailable');
    wrapped.cause = error;
    return wrapped;
  };

  return {
    kind: target === ':memory:' ? 'memory' : 'sqlite-file',
    persistent: target !== ':memory:',
    supportsMultiStatement: true,

    async exec(sql) {
      try {
        database.exec(sql);
      } catch (error) {
        throw wrap(error);
      }
    },

    async get(sql, params = []) {
      try {
        return database.prepare(sql).get(...params) ?? null;
      } catch (error) {
        throw wrap(error);
      }
    },

    async all(sql, params = []) {
      try {
        return database.prepare(sql).all(...params);
      } catch (error) {
        throw wrap(error);
      }
    },

    async run(sql, params = []) {
      try {
        const result = database.prepare(sql).run(...params);
        return { changes: Number(result.changes ?? 0), lastInsertRowid: Number(result.lastInsertRowid ?? 0) };
      } catch (error) {
        throw wrap(error);
      }
    },

    async close() {
      database.close();
    },
  };
}
