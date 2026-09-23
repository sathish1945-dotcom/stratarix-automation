/**
 * Socket-level tests for the real HTTP server (`server.mjs`).
 *
 * Everything else runs the router in-process; this suite proves the production
 * wiring: the static allowlist, security headers, cookie flags, rate limiting,
 * persistence across a restart and password storage. Supersedes the original
 * `auth.test.mjs`, which predates the current API contract.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeServer } from '../server.mjs';

const PASSWORD = 'Test-only-long-password-123';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

function client(origin) {
  let cookie = '';
  const request = (path, { method = 'GET', body, headers = {}, send = true } = {}) =>
    fetch(`${origin}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(method === 'GET' ? {} : { 'X-Stratarix-Request': '1' }),
        Origin: origin,
        ...(send && cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      redirect: 'manual',
    });
  return {
    request,
    async json(path, options) {
      const response = await request(path, options);
      const text = await response.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
      return { status: response.status, headers: response.headers, data };
    },
    async post(path, body, headers) {
      const response = await request(path, { method: 'POST', body, headers });
      const setCookie = response.headers.getSetCookie?.()[0];
      if (setCookie && !/max-age=0/i.test(setCookie)) cookie = setCookie.split(';')[0];
      if (setCookie && /max-age=0/i.test(setCookie)) cookie = '';
      const text = await response.text();
      return { status: response.status, headers: response.headers, setCookie, data: text ? JSON.parse(text) : null };
    },
    get cookie() {
      return cookie;
    },
    set cookie(value) {
      cookie = value;
    },
  };
}

test('the server only serves the public allowlist, with the right headers', async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  const server = await makeServer({ databasePath: ':memory:' });
  const origin = await listen(server);
  try {
    const home = await fetch(`${origin}/`);
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-type'), /text\/html/);
    assert.match(home.headers.get('content-security-policy') || '', /default-src 'self'/);
    assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(home.headers.get('x-frame-options'), 'DENY');
    assert.ok(home.headers.get('strict-transport-security'), 'HSTS in production');
    assert.ok(home.headers.get('permissions-policy'));
    assert.match(await home.text(), /AI Life Manager/);

    // Every file the frontend asks for is reachable…
    for (const [path, type, needle] of [
      ['/styles.css', /text\/css/, /--brand-500/],
      ['/js/main.js', /javascript/, /createApi|PROTECTED/],
      ['/js/views/chat.js', /javascript/, /createAssistantView/],
      ['/sw.js', /javascript/, /addEventListener\('push'/],
      ['/manifest.webmanifest', /manifest\+json/, /AI Life Manager/],
      ['/offline.html', /text\/html/, /You are offline/],
      ['/robots.txt', /text\/plain/, /Disallow: \/api\//],
      ['/favicon.svg', /svg/, /svg/],
      ['/icons/icon-192.png', /image\/png/, null],
      ['/icons/maskable-512.png', /image\/png/, null],
      ['/icons/apple-touch-icon.png', /image\/png/, null],
      ['/icons/badge-72.png', /image\/png/, null],
    ]) {
      const response = await fetch(origin + path);
      assert.equal(response.status, 200, `${path} should be served`);
      assert.match(response.headers.get('content-type'), type, `${path} content type`);
      if (needle) assert.match(await response.text(), needle, `${path} content`);
    }

    // …and nothing else is, whatever it is called.
    for (const path of ['/server.mjs', '/package.json', '/data/accounts.sqlite', '/.env', '/src/core/app.js', '/tests/ui.test.mjs', '/nope', '/js/../server.mjs']) {
      const response = await fetch(origin + path);
      assert.equal(response.status, 404, `${path} must not be served`);
      assert.doesNotMatch(await response.text(), /createApp|password_hash|scrypt/, `${path} leaks internals`);
    }

    // Conditional requests are honoured.
    const first = await fetch(`${origin}/styles.css`);
    const etag = first.headers.get('etag');
    assert.ok(etag, 'static assets carry an ETag');
    const second = await fetch(`${origin}/styles.css`, { headers: { 'If-None-Match': etag } });
    assert.equal(second.status, 304);
  } finally {
    await close(server);
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test('account lifecycle over HTTP: CSRF, cookies, rotation and errors', async () => {
  // Production mode: hardened cookies (Secure + __Host- prefix).
  const server = await makeServer({ databasePath: ':memory:', env: { ...process.env, NODE_ENV: 'production' } });
  const origin = await listen(server);
  const api = client(origin);
  try {
    assert.equal((await api.json('/api/me')).data.user, null, 'a visitor is a session probe, not an error');
    assert.equal((await api.json('/api/tasks')).status, 401);
    assert.equal((await api.json('/api/profile', { method: 'POST', body: { name: 'Nobody' }, headers: { 'X-Stratarix-Request': '' } })).status, 403, 'writes need the CSRF header');

    const registered = await api.post('/api/register', { name: 'QA Client', email: 'QA@example.test', password: PASSWORD, timezone: 'Asia/Kolkata' });
    assert.equal(registered.status, 201);
    assert.equal(registered.data.user.email, 'qa@example.test');
    assert.equal(registered.data.user.name, 'QA Client');
    assert.match(registered.setCookie, /HttpOnly/);
    assert.match(registered.setCookie, /SameSite=Lax/);
    assert.match(registered.setCookie, /Secure/);
    assert.match(registered.setCookie, /^__Host-stratarix_session=/);
    assert.doesNotMatch(registered.setCookie, /Domain=/i);
    assert.equal(registered.data.user.password, undefined, 'no credential material in the response');

    assert.equal((await api.json('/api/me')).data.user.email, 'qa@example.test');

    const duplicate = await api.post('/api/register', { name: 'QA Client', email: 'qa@example.test', password: PASSWORD });
    assert.equal(duplicate.status, 409);
    assert.doesNotMatch(JSON.stringify(duplicate.data), /SQLITE|constraint/i);

    assert.equal((await api.post('/api/register', { name: 'QA', email: 'short@example.test', password: 'tiny' })).status, 400);
    assert.equal((await api.json('/api/register', { method: 'POST', body: '{broken' })).status, 400, 'invalid JSON is a clean 400');
    const wrongMethod = await api.json('/api/me', { method: 'DELETE' });
    assert.ok([404, 405].includes(wrongMethod.status), 'unsupported methods are refused');
    assert.match(wrongMethod.data.error, /does not exist|not found|not allowed/i);

    const updated = await api.post('/api/profile', { name: 'Renamed Client', timezone: 'Europe/London' });
    assert.equal(updated.status, 200);
    assert.equal(updated.data.user.name, 'Renamed Client');

    // Logout kills the server-side session, not just the cookie.
    const oldCookie = api.cookie;
    assert.equal((await api.post('/api/logout', {})).status, 200);
    const probe = await fetch(`${origin}/api/me`, { headers: { Cookie: oldCookie } });
    assert.equal((await probe.json()).user, null);
    assert.equal((await fetch(`${origin}/api/tasks`, { headers: { Cookie: oldCookie } })).status, 401);

    assert.equal((await api.post('/api/login', { email: 'qa@example.test', password: 'Wrong-password-long-123' })).status, 401);
    // The frontend always sends the browser timezone on sign-in (js/views/auth.js),
    // and the server keeps the account in sync with it.
    const signedIn = await api.post('/api/login', { email: 'qa@example.test', password: PASSWORD, timezone: 'Europe/London' });
    assert.equal(signedIn.status, 200);
    assert.equal((await api.json('/api/me')).data.user.timezone, 'Europe/London', 'the profile change stuck');

    // Origin checks block cross-site writes.
    assert.equal((await api.json('/api/profile', { method: 'POST', body: { name: 'Cross Site' }, headers: { Origin: 'https://evil.example' } })).status, 403);
  } finally {
    await close(server);
  }
});

test('same-origin writes work behind a TLS-terminating proxy', async () => {
  // No APP_ORIGIN configured: the public origin must come from the forwarded
  // headers, otherwise a proxied deployment would reject its own users.
  const server = await makeServer({
    databasePath: ':memory:',
    env: { ...process.env, NODE_ENV: 'production', APP_ORIGIN: '' },
  });
  const origin = await listen(server);
  try {
    const publicOrigin = 'https://life.example.app';
    const response = await fetch(`${origin}/api/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Stratarix-Request': '1',
        Origin: publicOrigin,
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-Host': 'life.example.app',
      },
      body: JSON.stringify({ name: 'Proxy User', email: 'proxy@example.test', password: PASSWORD }),
    });
    assert.equal(response.status, 201, 'the forwarded public origin is accepted');
    assert.match(response.headers.getSetCookie()[0], /^__Host-stratarix_session=/);

    // A genuinely foreign origin is still refused.
    const foreign = await fetch(`${origin}/api/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Stratarix-Request': '1',
        Origin: 'https://evil.example',
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-Host': 'life.example.app',
      },
      body: JSON.stringify({ name: 'Attacker', email: 'attacker@example.test', password: PASSWORD }),
    });
    assert.equal(foreign.status, 403);
  } finally {
    await close(server);
  }
});

test('repeated failed logins are rate limited with Retry-After', async () => {
  const server = await makeServer({ databasePath: ':memory:', env: { ...process.env, NODE_ENV: 'production' } });
  const origin = await listen(server);
  const api = client(origin);
  try {
    await api.post('/api/register', { name: 'Limit Tester', email: 'limit@example.test', password: PASSWORD });
    let limited = null;
    for (let attempt = 0; attempt < 30 && !limited; attempt += 1) {
      const response = await api.post('/api/login', { email: 'limit@example.test', password: `wrong-password-${attempt}` });
      if (response.status === 429) limited = response;
    }
    assert.ok(limited, 'brute force is throttled');
    assert.ok(Number(limited.headers.get('retry-after')) > 0, 'the client is told when to try again');
    assert.doesNotMatch(JSON.stringify(limited.data), /stack|SQLITE/i);
  } finally {
    await close(server);
  }
});

test('accounts, hashes and sessions behave across a restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stratarix-server-'));
  const databasePath = join(directory, 'accounts.sqlite');
  let server = await makeServer({ databasePath });
  let origin = await listen(server);
  let api = client(origin);
  try {
    const registered = await api.post('/api/register', { name: 'Persistent Client', email: 'persist@example.test', password: PASSWORD, timezone: 'Asia/Kolkata' });
    assert.equal(registered.status, 201);
    const cookie = api.cookie;

    await close(server);

    // Passwords are stored as salted scrypt hashes, never as text.
    const database = new DatabaseSync(databasePath);
    const row = database.prepare('SELECT password_hash, salt FROM users').get();
    assert.notEqual(row.password_hash, PASSWORD);
    assert.doesNotMatch(row.password_hash, new RegExp(PASSWORD));
    assert.match(row.password_hash, /^scrypt\$\d+\$\d+\$\d+\$[a-f0-9]+$/);
    assert.equal(row.salt.length, 32);
    database.prepare('UPDATE sessions SET expires_at = 0').run();
    database.close();

    server = await makeServer({ databasePath });
    origin = await listen(server);
    api = client(origin);

    const expired = await fetch(`${origin}/api/me`, { headers: { Cookie: cookie } });
    assert.equal((await expired.json()).user, null, 'an expired session cannot be reused');

    const signedIn = await api.post('/api/login', { email: 'persist@example.test', password: PASSWORD });
    assert.equal(signedIn.status, 200);
    assert.equal(signedIn.data.user.name, 'Persistent Client');
  } finally {
    if (server.listening) await close(server);
    await rm(directory, { recursive: true, force: true });
  }
});
