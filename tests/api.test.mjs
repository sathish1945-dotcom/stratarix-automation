/**
 * End-to-end API behaviour through the real router:
 * accounts, sessions, task CRUD, ownership isolation, filters and validation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, call, makeRequest, signUp } from './helpers.mjs';
import { zonedToUtc } from '../src/core/time.js';

const TZ = 'Asia/Kolkata';

test('registration signs the user in immediately and keeps the session alive', async () => {
  const { app } = await createTestApp();
  const response = await call(app, '/api/register', {
    method: 'POST',
    body: { name: 'Satish Kumar', email: 'Satish@Example.test', password: 'a-long-test-password-123', timezone: TZ },
  });
  assert.equal(response.status, 201);
  assert.equal(response.data.user.email, 'satish@example.test', 'email is normalised');
  assert.equal(response.data.signedIn, true);
  assert.match(response.setCookies[0], /HttpOnly/);
  assert.match(response.setCookies[0], /SameSite=Lax/);
  assert.match(response.setCookies[0], /Secure/);
  assert.match(response.setCookies[0], /__Host-stratarix_session=/);

  // The cookie from registration is already a full session: no second log-in.
  const me = await call(app, '/api/me', { cookie: response.cookie });
  assert.equal(me.status, 200);
  assert.equal(me.data.user.name, 'Satish Kumar');
  assert.equal(me.data.user.timezone, TZ);

  // A protected route works with the same cookie.
  const tasks = await call(app, '/api/tasks?timezone=Asia/Kolkata', { cookie: response.cookie });
  assert.equal(tasks.status, 200);
  assert.deepEqual(tasks.data.tasks, []);
  assert.equal(tasks.data.counts.all, 0);
});

test('registration validates input and rejects duplicates', async () => {
  const { app } = await createTestApp();
  const base = { name: 'Dup User', email: 'dup@example.test', password: 'a-long-test-password-123' };
  assert.equal((await call(app, '/api/register', { method: 'POST', body: base })).status, 201);

  const duplicate = await call(app, '/api/register', { method: 'POST', body: base });
  assert.equal(duplicate.status, 409);
  assert.match(duplicate.data.error, /already exists/i);
  assert.doesNotMatch(JSON.stringify(duplicate.data), /SQLITE|constraint/i);

  assert.equal((await call(app, '/api/register', { method: 'POST', body: { ...base, email: 'dup2@example.test', password: 'short' } })).status, 400);
  assert.equal((await call(app, '/api/register', { method: 'POST', body: { ...base, email: 'not-an-email', name: 'X Y' } })).status, 400);
  assert.equal((await call(app, '/api/register', { method: 'POST', body: { ...base, email: 'dup3@example.test', name: 'A' } })).status, 400);
  const htmlName = await call(app, '/api/register', {
    method: 'POST',
    body: { ...base, email: 'dup4@example.test', name: '<script>alert(1)</script>' },
  });
  assert.equal(htmlName.status, 400);
});

test('login, logout and protected routes behave correctly', async () => {
  const { app } = await createTestApp();
  const { cookie, email, password } = await signUp(app);

  const wrong = await call(app, '/api/login', { method: 'POST', body: { email, password: 'definitely-wrong-1234' } });
  assert.equal(wrong.status, 401);
  assert.match(wrong.data.error, /incorrect/i);

  const unknown = await call(app, '/api/login', { method: 'POST', body: { email: 'nobody@example.test', password: 'definitely-wrong-1234' } });
  assert.equal(unknown.status, 401);
  assert.equal(unknown.data.error, wrong.data.error, 'the response does not reveal whether the account exists');

  // A real browser sends its existing cookie, so logging in rotates that session.
  const loggedIn = await call(app, '/api/login', { method: 'POST', body: { email, password, timezone: TZ }, cookie });
  assert.equal(loggedIn.status, 200);
  assert.equal(loggedIn.data.signedIn, true);

  const out = await call(app, '/api/logout', { method: 'POST', body: {}, cookie: loggedIn.cookie });
  assert.equal(out.status, 200);
  assert.match(out.setCookies[0], /Max-Age=0/);
  assert.equal((await call(app, '/api/me', { cookie: loggedIn.cookie })).data.user, null);
  assert.equal((await call(app, '/api/tasks', { cookie: loggedIn.cookie })).status, 401);
  assert.equal((await call(app, '/api/tasks', { cookie })).status, 401, 'the first session was rotated away');

  // Profile updates require a session and validate the name.
  const fresh = await call(app, '/api/login', { method: 'POST', body: { email, password } });
  const updated = await call(app, '/api/profile', { method: 'POST', body: { name: 'Renamed User' }, cookie: fresh.cookie });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.user.name, 'Renamed User');
  assert.equal((await call(app, '/api/profile', { method: 'POST', body: { name: 'x' }, cookie: fresh.cookie })).status, 400);
  assert.equal((await call(app, '/api/profile', { method: 'POST', body: { name: 'No Session' } })).status, 401);
});

test('changing the password ends other sessions', async () => {
  const { app } = await createTestApp();
  const { cookie, password, email } = await signUp(app);
  const second = await call(app, '/api/login', { method: 'POST', body: { email, password } });

  const changed = await call(app, '/api/password', {
    method: 'POST',
    body: { currentPassword: password, newPassword: 'brand-new-long-password-456' },
    cookie: second.cookie,
  });
  assert.equal(changed.status, 200);
  assert.equal((await call(app, '/api/tasks', { cookie })).status, 401, 'the old session is gone');
  assert.equal((await call(app, '/api/tasks', { cookie: changed.cookie })).status, 200);
  assert.equal(
    (await call(app, '/api/password', { method: 'POST', body: { currentPassword: 'nope-nope-nope', newPassword: 'another-long-password-789' }, cookie: changed.cookie })).status,
    401,
  );
  assert.equal((await call(app, '/api/login', { method: 'POST', body: { email, password } })).status, 401);
  assert.equal((await call(app, '/api/login', { method: 'POST', body: { email, password: 'brand-new-long-password-456' } })).status, 200);
});

test('tasks can be created, filtered, edited, completed, rescheduled and deleted', async () => {
  const { app } = await createTestApp();
  const { cookie } = await signUp(app);
  const now = Date.now();
  const query = '?timezone=Asia/Kolkata';

  const overdue = await call(app, '/api/tasks', {
    method: 'POST',
    cookie,
    body: { title: 'Overdue report', dueAt: now - 3 * 60 * 60 * 1000, priority: 'high' },
  });
  assert.equal(overdue.status, 201);
  const today = await call(app, '/api/tasks', {
    method: 'POST',
    cookie,
    body: { title: 'Today standup', dueAt: now + 60 * 60 * 1000 },
  });
  const upcoming = await call(app, '/api/tasks', {
    method: 'POST',
    cookie,
    body: { title: 'Next month tax', dueAt: now + 10 * 24 * 60 * 60 * 1000, recurrence: 'monthly:05' },
  });
  const recurring = await call(app, '/api/tasks', {
    method: 'POST',
    cookie,
    body: { title: 'Every Monday review', dueAt: zonedToUtc({ year: 2026, month: 9, day: 28, hour: 9 }, TZ), recurrence: 'weekly:1' },
  });
  assert.equal([today, upcoming, recurring].every((r) => r.status === 201), true);

  const all = await call(app, `/api/tasks${query}`, { cookie });
  assert.equal(all.data.tasks.length, 4);
  assert.equal(all.data.counts.overdue, 1, 'the task due three hours ago is overdue');
  assert.equal(all.data.counts.today, 2, 'the overdue task also falls on today');
  assert.equal(all.data.counts.upcoming, 2);
  assert.equal(all.data.counts.all, 4);
  assert.equal(all.data.filter, 'all');

  assert.equal((await call(app, `/api/tasks?filter=overdue&timezone=Asia/Kolkata`, { cookie })).data.tasks[0].title, 'Overdue report');
  const todayFilter = await call(app, `/api/tasks?filter=today&timezone=Asia/Kolkata`, { cookie });
  assert.deepEqual(
    todayFilter.data.tasks.map((task) => task.title).sort(),
    ['Overdue report', 'Today standup'],
  );
  assert.equal((await call(app, `/api/tasks?filter=upcoming&timezone=Asia/Kolkata`, { cookie })).data.tasks.length, 2);
  assert.equal((await call(app, `/api/tasks?search=tax&timezone=Asia/Kolkata`, { cookie })).data.tasks.length, 1);

  const id = today.data.task.id;
  const edited = await call(app, `/api/tasks/${id}`, { method: 'PATCH', cookie, body: { title: 'Daily standup', priority: 'urgent', description: 'Notes' } });
  assert.equal(edited.data.task.title, 'Daily standup');
  assert.equal(edited.data.task.priority, 'urgent');
  assert.equal(edited.data.task.description, 'Notes');

  const completed = await call(app, `/api/tasks/${id}/complete`, { method: 'POST', body: {}, cookie });
  assert.equal(completed.data.task.completed, true);
  assert.equal(completed.data.repeated, false);
  assert.equal((await call(app, `/api/tasks?filter=completed&timezone=Asia/Kolkata`, { cookie })).data.tasks.length, 1);

  const reopened = await call(app, `/api/tasks/${id}/reopen`, { method: 'POST', body: {}, cookie });
  assert.equal(reopened.data.task.completed, false);

  const snoozed = await call(app, `/api/tasks/${id}/reschedule`, { method: 'POST', cookie, body: { preset: 'in-30-min' } });
  assert.ok(snoozed.data.task.dueAt >= Date.now() + 29 * 60_000);

  // Completing a repeating task moves it forward instead of closing it.
  const repeatDone = await call(app, `/api/tasks/${recurring.data.task.id}/complete`, { method: 'POST', body: {}, cookie });
  assert.equal(repeatDone.data.repeated, true);
  assert.equal(repeatDone.data.task.completed, false);
  assert.ok(repeatDone.data.task.dueAt > recurring.data.task.dueAt);

  const removed = await call(app, `/api/tasks/${upcoming.data.task.id}`, { method: 'DELETE', cookie });
  assert.equal(removed.data.ok, true);
  assert.equal((await call(app, `/api/tasks${query}`, { cookie })).data.tasks.length, 3);
  assert.equal((await call(app, `/api/tasks/999999`, { method: 'DELETE', cookie })).status, 404);
});

test('task input is validated and raw database errors never reach the client', async () => {
  const { app } = await createTestApp();
  const { cookie } = await signUp(app);
  const cases = [
    [{ title: 'A' }, 400],
    [{ title: 'x'.repeat(200) }, 400],
    [{ title: 'Valid title', dueAt: 'not-a-date' }, 400],
    [{ title: 'Valid title', dueAt: Date.now() + 1000 * 60 * 60 * 24 * 365 * 40 }, 400],
    [{ title: 'Valid title', priority: 'sometime' }, 400],
    [{ title: 'Valid title', recurrence: 'fortnightly-maybe' }, 400],
    [{ title: 'Valid title', description: 'y'.repeat(2500) }, 400],
    [{ title: 'O' }, 400],
  ];
  for (const [body, expected] of cases) {
    const response = await call(app, '/api/tasks', { method: 'POST', cookie, body });
    assert.equal(response.status, expected, `expected ${expected} for ${JSON.stringify(body).slice(0, 60)}`);
    assert.doesNotMatch(JSON.stringify(response.data), /SQLITE|INSERT INTO|stack/i);
  }
  const ok = await call(app, '/api/tasks', { method: 'POST', cookie, body: { title: 'Valid task', dueAt: null } });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.task.dueAt, null);

  // Ids that are not numbers are rejected without a 500.
  assert.equal((await call(app, '/api/tasks/abc', { method: 'DELETE', cookie })).status, 404);
});

test('one user cannot read or change another user\'s tasks', async () => {
  const { app } = await createTestApp();
  const alice = await signUp(app, { email: 'alice@example.test' });
  const bob = await signUp(app, { email: 'bob@example.test' });

  const created = await call(app, '/api/tasks', { method: 'POST', cookie: alice.cookie, body: { title: 'Alice private task' } });
  const aliceTask = created.data.task.id;

  const bobList = await call(app, '/api/tasks?timezone=Asia/Kolkata', { cookie: bob.cookie });
  assert.equal(bobList.data.tasks.length, 0);

  assert.equal((await call(app, `/api/tasks/${aliceTask}`, { method: 'PATCH', cookie: bob.cookie, body: { title: 'Hijacked' } })).status, 404);
  assert.equal((await call(app, `/api/tasks/${aliceTask}/complete`, { method: 'POST', cookie: bob.cookie, body: {} })).status, 404);
  assert.equal((await call(app, `/api/tasks/${aliceTask}`, { method: 'DELETE', cookie: bob.cookie })).status, 404);

  const aliceList = await call(app, '/api/tasks?timezone=Asia/Kolkata', { cookie: alice.cookie });
  assert.equal(aliceList.data.tasks.length, 1);
  assert.equal(aliceList.data.tasks[0].title, 'Alice private task');
});

test('cross-origin, missing header and wrong content-type writes are refused', async () => {
  const { app } = await createTestApp();
  const { cookie } = await signUp(app);

  const crossSite = await app.handle(
    makeRequest('/api/tasks', { method: 'POST', body: { title: 'Nope' }, cookie, origin: 'https://evil.example' }),
  );
  assert.equal(crossSite.status, 403);

  const noHeader = await app.handle(
    new Request('https://app.example.test/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://app.example.test', cookie },
      body: JSON.stringify({ title: 'Nope' }),
    }),
  );
  assert.equal(noHeader.status, 403);

  const wrongType = await call(app, '/api/tasks', {
    method: 'POST',
    cookie,
    body: 'title=plain',
    raw: true,
    headers: { 'content-type': 'text/plain' },
  });
  assert.equal(wrongType.status, 400);

  const crossSiteFetch = await app.handle(
    makeRequest('/api/tasks', { method: 'POST', body: { title: 'Nope' }, cookie, headers: { 'sec-fetch-site': 'cross-site' } }),
  );
  assert.equal(crossSiteFetch.status, 403);

  assert.equal((await call(app, '/api/nope', { cookie })).status, 404);
  assert.equal((await call(app, '/api/config')).status, 200);
  assert.equal((await call(app, '/api/health')).status, 200);
});

test('rate limits stop credential stuffing and chat flooding', async () => {
  const { app } = await createTestApp();
  let last = 0;
  for (let attempt = 0; attempt < 21; attempt += 1) {
    const response = await call(app, '/api/login', { method: 'POST', body: { email: 'nobody@example.test', password: 'wrong-password-1234' } });
    last = response.status;
  }
  assert.equal(last, 429);
});

test('the due-reminders endpoint only returns tasks whose time has arrived', async () => {
  const { app } = await createTestApp();
  const { cookie } = await signUp(app);
  const soon = await call(app, '/api/tasks', { method: 'POST', cookie, body: { title: 'Drink water', dueAt: Date.now() + 30_000 } });
  await call(app, '/api/tasks', { method: 'POST', cookie, body: { title: 'Later task', dueAt: Date.now() + 6 * 60 * 60 * 1000 } });

  const due = await call(app, '/api/reminders/due?timezone=Asia/Kolkata', { cookie });
  assert.equal(due.data.tasks.length, 1);
  assert.equal(due.data.tasks[0].title, 'Drink water');

  await call(app, `/api/tasks/${soon.data.task.id}/notified`, { method: 'POST', body: {}, cookie });
  assert.equal((await call(app, '/api/reminders/due?timezone=Asia/Kolkata', { cookie })).data.tasks.length, 0);
});

test('sessions expire and unauthenticated access is denied', async () => {
  const { app } = await createTestApp({ env: { SESSION_TTL_MS: '1200' } });
  const { cookie } = await signUp(app);
  assert.equal((await call(app, '/api/tasks', { cookie })).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 1300));
  assert.equal((await call(app, '/api/tasks', { cookie })).status, 401);
  assert.equal((await call(app, '/api/me', { cookie })).data.user, null);
});

test('health and config endpoints never expose secrets', async () => {
  const { app } = await createTestApp({ env: { GEMINI_API_KEY: ['AIza', 'SecretValueThatMustNeverAppear1234'].join('') } });
  for (const path of ['/api/config', '/api/health', '/api/me']) {
    const response = await call(app, path);
    assert.doesNotMatch(JSON.stringify(response.data), /SecretValueThatMustNeverAppear/);
  }
  const config = await call(app, '/api/config');
  assert.equal(config.data.ai.configured, true);
  assert.equal(config.data.push.enabled, false);
  assert.match(config.data.push.reason, /not enabled/i);
});
