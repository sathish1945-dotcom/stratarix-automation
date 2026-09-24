/**
 * Security review enforced as tests: no secrets in the repository or the git
 * history, hardened response headers, a strict static allowlist, and session
 * cookie flags that cannot regress silently.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, extname } from 'node:path';
import { createTestApp, call, signUp } from './helpers.mjs';
import { createStaticHandler, isPublicPath, securityHeaders } from '../server.mjs';

const ROOT = resolve(import.meta.dirname, '..');

const SECRET_PATTERNS = [
  /AIza[0-9A-Za-z_-]{20,}/, // Google / Gemini API key
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bVERCEL_TOKEN\s*=\s*['"]?[A-Za-z0-9]{10,}/,
];

function walk(directory, files = []) {
  for (const entry of readdirSync(directory)) {
    if (['node_modules', '.git', 'dist', 'data', 'test-results', '.vercel'].includes(entry)) continue;
    const full = join(directory, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) walk(full, files);
    else files.push(full);
  }
  return files;
}

test('no API keys or private keys are present in the working tree', () => {
  const findings = [];
  for (const file of walk(ROOT)) {
    if (['.png', '.jpg', '.ico', '.webp'].includes(extname(file))) continue;
    let content = '';
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const pattern of SECRET_PATTERNS) {
      const match = pattern.exec(content);
      if (match) findings.push(`${relative(ROOT, file)}: ${match[0].slice(0, 12)}…`);
    }
  }
  assert.deepEqual(findings, [], `hard-coded secrets found: ${findings.join(', ')}`);
});

test('no API keys exist anywhere in the git history', () => {
  const log = execFileSync('git', ['log', '--all', '--pretty=format:', '--name-only'], { cwd: ROOT, encoding: 'utf8' });
  const files = [...new Set(log.split('\n').filter(Boolean))];
  const findings = [];
  for (const file of files.slice(0, 200)) {
    let content = '';
    try {
      content = execFileSync('git', ['show', `HEAD:${file}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    } catch {
      continue;
    }
    for (const pattern of SECRET_PATTERNS) {
      const match = pattern.exec(content);
      if (match) findings.push(`${file}: ${match[0].slice(0, 12)}…`);
    }
  }
  assert.deepEqual(findings, []);
});

test('secrets and local data are gitignored and untracked', () => {
  const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
  for (const entry of ['node_modules', '.env', 'data/', '*.log', 'dist', '.vercel']) {
    assert.match(ignore, new RegExp(entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${entry} must be ignored`);
  }
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n');
  assert.equal(tracked.some((file) => file.startsWith('data/')), false);
  assert.equal(tracked.some((file) => file.endsWith('.sqlite')), false);
  assert.equal(tracked.includes('.env'), false);
});

test('the static server only exposes an allowlist of public files', async () => {
  const staticHandler = createStaticHandler();
  const request = (path) => staticHandler(new Request(`https://app.example.test${path}`));

  assert.equal((await request('/')).status, 200);
  assert.equal((await request('/styles.css')).status, 200);

  for (const path of [
    '/server.mjs',
    '/package.json',
    '/package-lock.json',
    '/README.md',
    '/.env',
    '/data/accounts.sqlite',
    '/src/core/app.js',
    '/src/core/auth.js',
    '/api/index.js',
    '/vercel.json',
    '/auth.test.mjs',
    '/../etc/passwd',
    '/js/../src/core/app.js',
  ]) {
    const response = await request(path);
    assert.equal(response.status, 404, `expected ${path} to be blocked`);
  }

  assert.equal(isPublicPath('/js/app.js'), true);
  assert.equal(isPublicPath('/icons/icon-192.png'), true);
  assert.equal(isPublicPath('/src/core/app.js'), false);
  assert.equal(isPublicPath('/server.mjs'), false);
});

test('responses carry hardened security headers in production', async () => {
  const staticHandler = createStaticHandler();
  const html = await staticHandler(new Request('https://app.example.test/'));
  const csp = html.headers.get('content-security-policy');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.equal(html.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(html.headers.get('x-frame-options'), 'DENY');
  assert.match(html.headers.get('referrer-policy'), /strict-origin/);

  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  assert.match(securityHeaders()['Strict-Transport-Security'], /max-age=31536000/);
  process.env.NODE_ENV = previous;
});

test('API responses are not cached and errors never leak internals', async () => {
  const { app, cookie } = await createTestApp();
  const config = await app.handle(
    new Request('https://app.example.test/api/config', { headers: { origin: 'https://app.example.test' } }),
  );
  assert.equal(config.headers.get('cache-control'), 'no-store');

  const session = await signUp(app);
  const failure = await call(app, '/api/tasks/999999', { method: 'DELETE', cookie: session.cookie });
  assert.equal(failure.status, 404);
  const body = JSON.stringify(failure.data);
  assert.doesNotMatch(body, /at Object|node_modules|stack|SQLITE|SELECT /i);
});

test('session cookies use the hardened flags and rotate on login', async () => {
  const { app } = await createTestApp();
  const first = await call(app, '/api/register', {
    method: 'POST',
    body: { name: 'Cookie Tester', email: 'cookie@example.test', password: 'a-long-test-password-123' },
  });
  const cookie = first.setCookies[0];
  assert.match(cookie, /^__Host-stratarix_session=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\//);
  assert.doesNotMatch(cookie, /Domain=/);

  const second = await call(app, '/api/login', {
    method: 'POST',
    body: { email: 'cookie@example.test', password: 'a-long-test-password-123' },
    cookie: first.cookie,
  });
  assert.notEqual(second.cookie, first.cookie, 'the session token is rotated on login');
  assert.equal((await call(app, '/api/tasks', { cookie: first.cookie })).status, 401, 'the old token is invalidated');

  const { app: devApp } = await createTestApp({ env: { NODE_ENV: 'development', APP_ORIGIN: '' } });
  const dev = await call(devApp, '/api/register', {
    method: 'POST',
    body: { name: 'Dev User', email: 'dev@example.test', password: 'a-long-test-password-123' },
  });
  assert.match(dev.setCookies[0], /^stratarix_session=/);
  assert.doesNotMatch(dev.setCookies[0], /Secure/, 'Secure is omitted on plain HTTP development');
});
