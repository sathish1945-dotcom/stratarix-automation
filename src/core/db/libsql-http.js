/**
 * SQLite driver for the libSQL / Turso HTTP protocol.
 *
 * Why this exists: a Vercel (or any serverless) deployment has no persistent
 * disk, so a local SQLite file would silently reset on every cold start. With
 * `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` set, the same SQLite dialect is
 * served over HTTPS from a remote database and data survives deployments.
 *
 * Protocol: POST {origin}/v2/pipeline with an array of requests. Results come
 * back as positional rows with tagged values, which are converted back into
 * plain JavaScript objects here.
 */
import { serverFailure } from '../errors.js';

const STATEMENT_TIMEOUT_MS = 10_000;

/** Split a batch of DDL/DML into individual statements (quote aware). */
export function splitStatements(sql) {
  const statements = [];
  let current = '';
  let quote = null;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === '-' && sql[index + 1] === '-') {
      const end = sql.indexOf('\n', index);
      index = end === -1 ? sql.length : end;
      continue;
    }
    if (char === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

function toArg(value) {
  if (value === null || value === undefined) return { type: 'null' };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { type: 'integer', value: String(value) } : { type: 'float', value: value };
  }
  if (typeof value === 'boolean') return { type: 'integer', value: value ? '1' : '0' };
  if (value instanceof Uint8Array) {
    return { type: 'blob', value: Buffer.from(value).toString('base64') };
  }
  return { type: 'text', value: String(value) };
}

function fromValue(cell) {
  if (!cell || cell.type === 'null') return null;
  if (cell.type === 'integer') return Number(cell.value);
  if (cell.type === 'float') return Number(cell.value);
  if (cell.type === 'blob') return Buffer.from(String(cell.value), 'base64');
  return cell.value;
}

/** Resolve an https:// origin from the various connection-string shapes. */
export function resolveOrigin(url) {
  if (!url) return null;
  let normalized = String(url).trim();
  normalized = normalized.replace(/^libsql:\/\//, 'https://').replace(/^wss:\/\//, 'https://');
  if (!/^https?:\/\//.test(normalized)) normalized = `https://${normalized}`;
  const parsed = new URL(normalized);
  return parsed.origin;
}

export function createLibsqlHttpDatabase({ url, authToken, fetchImpl = fetch, timeoutMs = STATEMENT_TIMEOUT_MS } = {}) {
  const origin = resolveOrigin(url);
  if (!origin || !authToken) throw serverFailure('The database connection is not configured.', 'db_not_configured');

  async function pipeline(requests) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(`${origin}/v2/pipeline`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ requests }),
        signal: controller.signal,
      });
    } catch (error) {
      const wrapped = serverFailure('The database is temporarily unavailable. Please try again.', 'db_unavailable');
      wrapped.cause = error;
      throw wrapped;
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      // 401/403 means the token is wrong — a configuration problem, not a
      // transient one, but the user still gets a friendly message.
      throw serverFailure('The database is temporarily unavailable. Please try again.', 'db_unavailable');
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw serverFailure('The database is temporarily unavailable. Please try again.', 'db_unavailable');
    }

    const results = Array.isArray(payload?.results) ? payload.results : [];
    for (const entry of results) {
      if (entry?.type === 'error') {
        const message = String(entry.error?.message || '');
        // Surface constraint violations to the caller so it can translate them
        // into a helpful message (for example a duplicate email address).
        if (/UNIQUE constraint failed/i.test(message)) {
          const error = new Error(message);
          error.code = 'SQLITE_CONSTRAINT_UNIQUE';
          throw error;
        }
        throw serverFailure('The database request could not be completed.', 'db_error');
      }
    }
    return results;
  }

  const execute = (sql, params = []) => ({
    type: 'execute',
    stmt: { sql, args: params.map(toArg) },
  });

  const readResult = (entry) => entry?.response?.result ?? { rows: [], cols: [] };

  const toObjects = (result) => {
    const cols = result.cols || [];
    return (result.rows || []).map((row) => {
      const object = {};
      cols.forEach((name, index) => {
        object[name] = fromValue(row[index]);
      });
      return object;
    });
  };

  return {
    kind: 'libsql-http',
    persistent: true,
    supportsMultiStatement: false,

    async exec(sql) {
      const statements = splitStatements(sql);
      if (!statements.length) return;
      // Pipelines accept many statements in a single round trip.
      const chunkSize = 25;
      for (let index = 0; index < statements.length; index += chunkSize) {
        const chunk = statements.slice(index, index + chunkSize);
        await pipeline(chunk.map((statement) => execute(statement)));
      }
    },

    async get(sql, params = []) {
      const [entry] = await pipeline([execute(sql, params)]);
      const rows = toObjects(readResult(entry));
      return rows[0] ?? null;
    },

    async all(sql, params = []) {
      const [entry] = await pipeline([execute(sql, params)]);
      return toObjects(readResult(entry));
    },

    async run(sql, params = []) {
      const [entry] = await pipeline([execute(sql, params)]);
      const result = readResult(entry);
      return {
        changes: Number(result.affected_row_count ?? 0),
        lastInsertRowid: Number(result.last_insert_rowid ?? 0),
      };
    },

    async close() {
      // HTTP connections are stateless; nothing to release.
    },
  };
}
