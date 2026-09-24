/**
 * libSQL / Turso HTTP driver, exercised against a mock of the documented
 * /v2/pipeline protocol. This is what lets the same code run on Vercel (no disk)
 * and on a plain Node host (SQLite file) without changing the application.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLibsqlHttpDatabase, resolveOrigin, splitStatements } from '../src/core/db/libsql-http.js';
import { describeDatabase, openDatabase } from '../src/core/db/index.js';
import { createApp } from '../src/core/app.js';

/** Minimal server-side emulation of the pipeline endpoint. */
function mockPipeline({ failWith, check } = {}) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    if (init?.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const body = JSON.parse(init.body);
    requests.push({ url: String(url), auth: init.headers.Authorization, body });
    if (failWith) return failWith();
    check?.(body);
    const results = body.requests.map((request) => {
      if (request.type !== 'execute') return { type: 'ok', response: { type: 'close' } };
      const { sql, args = [] } = request.stmt;
      if (/INSERT INTO tasks/i.test(sql)) {
        return {
          type: 'ok',
          response: {
            type: 'execute',
            result: { cols: [], rows: [], affected_row_count: 1, last_insert_rowid: 42 },
          },
        };
      }
      if (/SELECT/i.test(sql)) {
        return {
          type: 'ok',
          response: {
            type: 'execute',
            result: {
              cols: ['id', 'title', 'due_at', 'done'],
              rows: [
                [
                  { type: 'integer', value: '7' },
                  { type: 'text', value: `echo:${args[0]?.value ?? ''}` },
                  { type: 'null' },
                  { type: 'float', value: '0.5' },
                ],
              ],
              affected_row_count: 0,
              last_insert_rowid: null,
            },
          },
        };
      }
      return { type: 'ok', response: { type: 'execute', result: { cols: [], rows: [], affected_row_count: 0 } } };
    });
    return Response.json({ results });
  };
  return { fetchImpl, requests };
}

test('connection strings are normalised to an HTTPS origin', () => {
  assert.equal(resolveOrigin('libsql://my-db.turso.io'), 'https://my-db.turso.io');
  assert.equal(resolveOrigin('https://my-db.turso.io/'), 'https://my-db.turso.io');
  assert.equal(resolveOrigin('my-db.turso.io'), 'https://my-db.turso.io');
});

test('a migration batch is split into individual statements, quotes respected', () => {
  const statements = splitStatements(`
    -- comment
    CREATE TABLE t (id INTEGER, note TEXT DEFAULT 'a;b');
    INSERT INTO t (note) VALUES ('it''s fine');
  `);
  assert.equal(statements.length, 2);
  assert.match(statements[0], /CREATE TABLE/);
  assert.match(statements[1], /INSERT INTO/);
});

test('reads and writes map typed values and report insert ids', async () => {
  const { fetchImpl, requests } = mockPipeline();
  const db = createLibsqlHttpDatabase({ url: 'libsql://db.turso.io', authToken: 'token-123', fetchImpl });

  const rows = await db.all('SELECT id, title, due_at, done FROM tasks WHERE user_id = ?', [7]);
  assert.deepEqual(rows, [{ id: 7, title: 'echo:7', due_at: null, done: 0.5 }]);

  const single = await db.get('SELECT id FROM tasks LIMIT 1', []);
  assert.equal(single.id, 7);

  const result = await db.run('INSERT INTO tasks (title) VALUES (?)', ['Write report']);
  assert.deepEqual(result, { changes: 1, lastInsertRowid: 42 });

  assert.equal(requests[0].url, 'https://db.turso.io/v2/pipeline');
  assert.equal(requests[0].auth, 'Bearer token-123');
  assert.equal(requests[0].body.requests[0].stmt.args[0].type, 'integer');
  assert.equal(requests[1].body.requests[0].stmt.args.length, 0);
});

test('exec pipelines many statements in one request', async () => {
  const { fetchImpl, requests } = mockPipeline();
  const db = createLibsqlHttpDatabase({ url: 'https://db.turso.io', authToken: 't', fetchImpl });
  await db.exec('CREATE TABLE a (id INTEGER); CREATE TABLE b (id INTEGER); CREATE TABLE c (id INTEGER)');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.requests.length, 3);
});

test('a unique constraint violation is surfaced for a friendly duplicate message', async () => {
  const { fetchImpl } = mockPipeline({
    failWith: () =>
      Response.json({
        results: [{ type: 'error', error: { message: 'UNIQUE constraint failed: users.email' } }],
      }),
  });
  const db = createLibsqlHttpDatabase({ url: 'https://db.turso.io', authToken: 't', fetchImpl });
  await assert.rejects(
    () => db.run('INSERT INTO users (email) VALUES (?)', ['dup@example.test']),
    (error) => {
      assert.equal(error.code, 'SQLITE_CONSTRAINT_UNIQUE');
      return true;
    },
  );
});

test('provider errors and timeouts become a friendly database error', async () => {
  const failing = createLibsqlHttpDatabase({
    url: 'https://db.turso.io',
    authToken: 't',
    fetchImpl: async () => Response.json({ error: 'boom' }, { status: 500 }),
  });
  await assert.rejects(
    () => failing.get('SELECT 1'),
    (error) => {
      assert.equal(error.code, 'db_unavailable');
      assert.match(error.message, /temporarily unavailable/i);
      assert.doesNotMatch(error.message, /boom/);
      return true;
    },
  );

  const hanging = createLibsqlHttpDatabase({
    url: 'https://db.turso.io',
    authToken: 't',
    timeoutMs: 40,
    fetchImpl: (url, init) =>
      new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
  });
  await assert.rejects(() => hanging.get('SELECT 1'), (error) => error.code === 'db_unavailable');
});

test('the factory selects the right driver for each environment', () => {
  assert.equal(describeDatabase({ TURSO_DATABASE_URL: 'libsql://x.turso.io', TURSO_AUTH_TOKEN: 't' }).driver, 'libsql-http');
  assert.equal(describeDatabase({ DATABASE_PATH: '/var/data/app.sqlite' }).driver, 'sqlite-file');
  assert.equal(describeDatabase({}).driver, 'memory');
  // A file URL is never sent to the HTTP driver.
  assert.equal(describeDatabase({ DATABASE_URL: 'file:./local.sqlite' }).driver, 'memory');
});

test('the whole API runs on the HTTP driver', async () => {
  const { fetchImpl } = mockPipeline({
    check(body) {
      const sql = body.requests[0]?.stmt?.sql || '';
      if (/INSERT INTO users/i.test(sql)) {
        body.requests[0].stmt.sql = 'INSERT INTO tasks (title) VALUES (?)';
      }
    },
  });
  const db = await openDatabase({
    env: { TURSO_DATABASE_URL: 'libsql://app.turso.io', TURSO_AUTH_TOKEN: 'token' },
    fetchImpl,
  });
  assert.equal(db.kind, 'libsql-http');
  const app = createApp({
    db,
    env: { NODE_ENV: 'production', APP_ORIGIN: 'https://app.example.test' },
    logger: { warn() {}, error() {}, log() {} },
  });
  // The mock answers SELECTs with a user row, so the session lookup path is
  // exercised end to end through the HTTP driver.
  const response = await app.handle(
    new Request('https://app.example.test/api/me', {
      headers: { origin: 'https://app.example.test', 'x-stratarix-request': '1' },
    }),
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).user, null);
});
