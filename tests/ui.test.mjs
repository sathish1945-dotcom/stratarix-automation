/**
 * End-to-end UI flows, driven through the real browser bundle in jsdom against
 * the real backend router. These cover the user-facing flows that matter:
 * registration → dashboard, chat → AI → task, edit/complete/delete, reminders,
 * logout and session persistence across a reload.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountUI } from './ui-harness.mjs';
import { mockGemini, geminiJson } from './helpers.mjs';

/** A key assembled at runtime: never a literal credential-shaped string. */
const FAKE_KEY = ['AIza', 'SyTest', 'NotARealKey', '0000000000'].join('');
const AI_ENV = { GEMINI_API_KEY: FAKE_KEY, GEMINI_MAX_RETRIES: '0', GEMINI_TIMEOUT_MS: '2000' };

/** A date two days out, so the fixture never drifts as the clock moves. */
const FUTURE_DAY = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);

/** The flat JSON contract the Gemini schema asks for (see tests/chat.test.mjs). */
const TASK_REPLY = {
  intent: 'create_task',
  reply: 'Added “Submit my assignment”.',
  needs_confirmation: false,
  title: 'Submit my assignment',
  description: 'Physics lab report',
  due_date: FUTURE_DAY,
  due_time: '20:00',
  all_day: false,
  recurrence: 'none',
  priority: 'high',
  confidence: 0.94,
};

/** Count only the real generation calls; the model list is a separate request. */
const generations = (mock) => mock.calls.filter((entry) => entry.url.includes(':generateContent'));

async function withUI(options, run) {
  const ui = await mountUI(options);
  try {
    await run(ui);
    assert.deepEqual(ui.errors, [], `the UI logged errors: ${ui.errors.join(' | ')}`);
  } finally {
    ui.teardown();
  }
}

async function register(ui, { name = 'Satish Kumar', email = `sis${Math.random().toString(36).slice(2)}@example.test`, password = 'correct-horse-battery' } = {}) {
  await ui.goto('#register');
  ui.type('#auth-form [name="name"]', name);
  ui.type('#auth-form [name="email"]', email);
  ui.type('#auth-form [name="password"]', password);
  await ui.submit('#auth-form');
  await ui.waitFor(() => ui.store().user, { label: 'signed-in session' });
  return { name, email, password };
}

test('shell: home view renders, theme toggles, drawer opens and closes', async () => {
  await withUI({}, async (ui) => {
    assert.equal(ui.win.location.hash, '#home', 'a visitor with no hash lands on the marketing home page');
    assert.equal(ui.text('#page-title'), 'Overview');
    assert.match(ui.text('#view'), /Your day, handled/);
    assert.deepEqual(ui.$$('#nav a').map((link) => link.dataset.route), ['dashboard', 'assistant', 'tasks', 'services', 'contact', 'settings']);
    assert.equal(ui.text('#account-name'), 'Your workspace');
    assert.equal(ui.text('#year'), String(new Date().getFullYear()));

    // Theme toggle flips the document theme and swaps the icon.
    const before = ui.doc.body.dataset.theme;
    ui.click('#theme-toggle');
    assert.notEqual(ui.doc.body.dataset.theme, before);
    assert.equal(ui.$('#theme-icon use').getAttribute('href'), ui.doc.body.dataset.theme === 'dark' ? '#i-sun' : '#i-moon');

    // Mobile drawer: opened by the hamburger, dismissed by Escape and the scrim.
    assert.equal(ui.$('#app').dataset.nav, 'closed');
    ui.click('#sidebar-open');
    assert.equal(ui.$('#app').dataset.nav, 'open');
    assert.equal(ui.$('#scrim').hidden, false);
    ui.key(ui.doc, 'Escape');
    assert.equal(ui.$('#app').dataset.nav, 'closed');
    ui.click('#sidebar-open');
    ui.click('#scrim');
    assert.equal(ui.$('#app').dataset.nav, 'closed');
  });
});

test('registration signs the user straight in and lands on the assistant', async () => {
  await withUI({}, async (ui) => {
    const account = await register(ui);

    assert.equal(ui.win.location.hash, '#assistant', 'no second credential entry — register goes straight in');
    assert.equal(ui.store().user.email, account.email);
    assert.equal(ui.text('#account-name'), account.name);
    assert.equal(ui.text('#account-detail'), account.email);
    assert.match(ui.text('#view'), /AI Life Manager assistant/);

    // A duplicate email is explained, not dumped as a server error.
    await ui.goto('#register');
    assert.match(ui.text('#view'), /signed in as/);
  });
});

test('assistant: the message shows at once, then the thinking state, then the real AI reply', async () => {
  // A deliberately slow provider so the loading state is observable.
  const gemini = mockGemini([async () => {
    await new Promise((resolve) => setTimeout(resolve, 120));
    return geminiJson(TASK_REPLY);
  }]);
  await withUI({ env: AI_ENV, fetchImpl: gemini.fetchImpl }, async (ui) => {
    await register(ui);
    await ui.goto('#assistant');

    ui.type('#chat-input', 'Remind me to submit my assignment tomorrow at 8 PM');
    await ui.submit('#chat-form');

    // 1. The user's own message is visible before the network settles.
    assert.ok(ui.$('[data-role="user"]'), 'the user bubble renders immediately');
    assert.match(ui.text('[data-role="user"] .bubble-text'), /submit my assignment/);
    // 2. A visible "AI is thinking" state, and the composer is locked.
    assert.ok(ui.$('[data-typing="true"]'), 'the typing indicator is shown while waiting');
    assert.match(ui.text('[data-typing="true"]'), /AI is thinking/);
    assert.equal(ui.$('#chat-send').disabled, true, 'duplicate submissions are blocked');
    assert.equal(ui.$('#chat-input').disabled, true);

    // 3. The indicator is replaced by the answer, tagged with its real source.
    await ui.waitFor(() => ui.$('[data-role="assistant"] .bubble-text') && !ui.$('[data-typing="true"]'), {
      label: 'AI reply',
      timeout: 8000,
    });
    assert.match(ui.text('[data-role="assistant"] .bubble-text'), /Added “Submit my assignment”/);
    assert.equal(ui.text('[data-role="assistant"] .source-tag'), 'Gemini AI');
    assert.equal(generations(gemini).length, 1, 'exactly one AI request — no duplicate submissions');
    assert.equal(ui.$('#chat-send').disabled, false, 'the composer is usable again');

    // 4. The tool call really wrote the task, and the card offers a way back.
    const listing = await ui.api('/api/tasks?filter=all');
    assert.equal(listing.status, 200);
    assert.equal(listing.data.tasks.length, 1);
    assert.equal(listing.data.tasks[0].title, 'Submit my assignment');
    assert.equal(listing.data.tasks[0].priority, 'high');
    assert.equal(
      new Date(listing.data.tasks[0].dueAt).toISOString(),
      `${FUTURE_DAY}T20:00:00.000Z`,
      'the date and time extracted from the sentence were stored',
    );
    assert.ok(ui.$('[data-task-card]'), 'the reply shows the created task');

    // 5. And the dashboard reflects it after the store refresh (two days out → Upcoming).
    await ui.goto('#dashboard');
    await ui.waitFor(() => ui.text('[data-filter="upcoming"] .stat-value') === '1', { label: 'dashboard upcoming count' });
    assert.equal(ui.text('[data-filter="upcoming"] .stat-value'), '1');
    assert.equal(ui.text('[data-filter="completed"] .stat-value'), '0');
    assert.match(ui.text('#dash-summary'), /Nothing is due today/);
  });
});

test('assistant: an AI outage degrades to the parser with a friendly notice', async () => {
  const gemini = mockGemini([() => new Response('upstream exploded', { status: 500 })]);
  await withUI({ env: AI_ENV, fetchImpl: gemini.fetchImpl }, async (ui) => {
    await register(ui);
    await ui.goto('#assistant');

    ui.type('#chat-input', 'Remind me to call Arun in 30 minutes');
    await ui.submit('#chat-form');
    await ui.waitFor(() => ui.$('[data-role="assistant"] .bubble-text') && !ui.$('[data-typing="true"]'), { label: 'fallback reply', timeout: 8000 });

    const body = ui.text('#chat-log');
    assert.match(body, /Call Arun/, 'the built-in parser still created the reminder');
    assert.equal(ui.text('[data-role="assistant"] .source-tag'), 'Built-in parser');
    assert.match(body, /temporarily unavailable|took too long|could not be read/, 'the outage is explained in plain language');
    assert.doesNotMatch(body, /500|upstream exploded|at .*\.js:/, 'no raw upstream or stack-trace text reaches the user');

    // The failure is honest about being degraded, and the task still exists.
    const listing = await ui.api('/api/tasks?filter=all');
    assert.equal(listing.data.tasks.length, 1);
    assert.match(listing.data.tasks[0].title, /Arun/i);
  });
});

test('tasks: filters, edit, complete, reschedule and delete all round-trip', async () => {
  const gemini = mockGemini([() => geminiJson(TASK_REPLY)]);
  await withUI({ env: AI_ENV, fetchImpl: gemini.fetchImpl }, async (ui) => {
    await register(ui);

    // Seed one task through the assistant and one through the manual modal.
    await ui.goto('#assistant');
    ui.type('#chat-input', 'Remind me to submit my assignment tomorrow at 8 PM');
    await ui.submit('#chat-form');
    await ui.waitFor(() => ui.$('[data-role="assistant"] .bubble-text') && !ui.$('[data-typing="true"]'), { label: 'seed task', timeout: 8000 });

    await ui.goto('#tasks');
    // The AI task is due tomorrow, so switch to the All filter before asserting rows.
    ui.click('[data-filter="all"]');
    await ui.waitFor(() => ui.$$('.task').length > 0, { label: 'task list' });
    assert.match(ui.text('#task-list-region'), /Submit my assignment/);
    ui.click('[data-action="open-task-modal"]');
    assert.equal(ui.$('#task-modal').hasAttribute('open'), true, 'the dialog opens');
    ui.type('#task-title', 'Buy groceries');
    ui.type('#task-date', '2026-12-24');
    ui.type('#task-time', '18:00');
    await ui.submit('#task-form');
    await ui.waitFor(() => ui.$$('.task').length === 2, { label: 'second task saved' });
    assert.match(ui.text('#task-list-region'), /Buy groceries/);

    // Edit.
    const groceriesRow = ui.$$('.task').find((row) => row.textContent.includes('Buy groceries'));
    ui.click(groceriesRow.querySelector('[data-action="edit-task"]'));
    await ui.waitFor(() => ui.$('#task-modal').hasAttribute('open'), { label: 'edit dialog' });
    assert.equal(ui.$('#task-title').value, 'Buy groceries', 'the dialog is prefilled');
    ui.type('#task-title', 'Buy groceries and milk');
    await ui.submit('#task-form');
    await ui.waitFor(() => ui.text('#task-list-region').includes('Buy groceries and milk'), { label: 'edited title' });
    let listing = await ui.api('/api/tasks?filter=all');
    assert.ok(listing.data.tasks.some((task) => task.title === 'Buy groceries and milk'));

    // Complete.
    const target = listing.data.tasks.find((task) => task.title === 'Buy groceries and milk');
    ui.click(`.task[data-task-id="${target.id}"] [data-action="complete"]`);
    await ui.waitFor(async () => {
      const check = await ui.api('/api/tasks?filter=completed');
      return check.data.tasks.some((task) => task.id === target.id);
    }, { label: 'task completed' });

    // Reschedule (through the preset menu).
    const open = (await ui.api('/api/tasks?filter=all')).data.tasks.find((task) => task.title === 'Submit my assignment');
    ui.click(`.task[data-task-id="${open.id}"] [data-action="reschedule-menu"]`);
    await ui.waitFor(() => ui.$('#confirm-body [data-preset]'), { label: 'reschedule menu' });
    const preset = ui.$('#confirm-body [data-preset]');
    assert.match(ui.text('#confirm-body'), /In 10 minutes/);
    const before = open.dueAt;
    ui.click(preset);
    await ui.waitFor(async () => {
      const after = (await ui.api('/api/tasks?filter=all')).data.tasks.find((task) => task.id === open.id);
      return after && after.dueAt !== before;
    }, { label: 'task rescheduled', timeout: 6000 });
    // Moved into today, so the sidebar badge now counts it.
    await ui.waitFor(() => ui.text('#nav-task-count') === '1', { label: 'sidebar today count' });

    // Delete, with confirmation.
    ui.click(`.task[data-task-id="${open.id}"] [data-action="delete-task"]`);
    assert.equal(ui.$('#confirm-modal').hasAttribute('open'), true, 'destructive actions ask first');
    ui.click('#confirm-ok');
    await ui.waitFor(async () => {
      const after = await ui.api('/api/tasks?filter=all');
      return !after.data.tasks.some((task) => task.id === open.id);
    }, { label: 'task deleted' });
    assert.doesNotMatch(ui.text('#task-list-region'), /Submit my assignment/);

    // Filter switch keeps working after the churn.
    ui.click('[data-filter="completed"]');
    await ui.waitFor(() => ui.$('[data-filter="completed"]').getAttribute('aria-selected') === 'true', { label: 'filter applied' });
  });
});

test('task dialog: invalid input is explained inside the dialog', async () => {
  await withUI({}, async (ui) => {
    await register(ui);
    await ui.goto('#tasks');
    ui.click('[data-action="open-task-modal"]');
    ui.type('#task-title', 'x');
    await ui.submit('#task-form');

    await ui.waitFor(() => ui.$('#task-form-error').hidden === false, { label: 'validation error' });
    const message = ui.text('#task-form-error');
    assert.match(message, /at least 2 characters|title/i);
    assert.doesNotMatch(message, /Error:|at .*\.js:|SQLITE|stack/, 'no stack traces or driver errors');
    assert.equal(ui.$('#task-modal').hasAttribute('open'), true, 'the dialog stays open so the user can fix it');
  });
});

test('reminders: permission is asked once and a due task fires a notification', async () => {
  await withUI({}, async (ui) => {
    await register(ui);
    await ui.goto('#dashboard');

    // A task whose reminder time has already passed, created through the API.
    const created = await ui.api('/api/tasks', {
      method: 'POST',
      body: { title: 'Drink water', dueAt: Date.now() - 60_000, timezone: 'UTC' },
    });
    assert.equal(created.status, 201);

    const prompt = ui.$('#notify-prompt');
    assert.ok(prompt, 'the app explains why it needs notification permission');
    assert.match(ui.text('#notify-prompt'), /Allow browser notifications/);

    ui.click('[data-action="enable-notifications"]');
    await ui.waitFor(() => ui.notifications.permission === 'granted', { label: 'permission granted' });
    assert.equal(ui.notifications.asks, 1, 'permission is requested exactly once');
    assert.equal(ui.$('#notify-prompt'), null, 'the prompt disappears once answered');

    // The ticker runs when the tab becomes visible again.
    ui.doc.dispatchEvent(new ui.win.Event('visibilitychange'));
    await ui.waitFor(() => ui.notifications.shown.length > 0, { label: 'reminder notification', timeout: 8000 });
    assert.equal(ui.notifications.shown[0].title, 'Drink water', 'the notification carries the task title');
    assert.equal(ui.notifications.shown[0].options.tag, `task-${created.data.task.id}`, 'so the same task never double-fires');

    // Navigating away and back does not ask again.
    await ui.goto('#tasks');
    await ui.goto('#dashboard');
    assert.equal(ui.$('#notify-prompt'), null);
  });
});

test('reminders: declining is remembered and never re-asked', async () => {
  await withUI({}, async (ui) => {
    await register(ui);
    await ui.goto('#dashboard');
    ui.click('[data-action="dismiss-notify"]');
    assert.equal(ui.$('#notify-prompt'), null);
    assert.equal(ui.win.localStorage.getItem('stratarix-notification-choice'), 'dismissed');
    await ui.goto('#tasks');
    await ui.goto('#dashboard');
    assert.equal(ui.$('#notify-prompt'), null, 'the dismissed prompt stays dismissed');
    assert.equal(ui.notifications.asks, 0);
  });
});

test('logout ends the session and protected pages ask for sign-in', async () => {
  await withUI({}, async (ui) => {
    await register(ui);
    await ui.goto('#settings');
    ui.click('[data-action="logout"]');
    await ui.waitFor(() => ui.store().user === null, { label: 'signed out' });
    assert.equal(ui.win.location.hash, '#login');

    // /api/me is a session probe (200 + user:null); protected routes must reject.
    const me = await ui.api('/api/me');
    assert.equal(me.data.user, null, 'the server session is gone, not just the client state');
    const tasks = await ui.api('/api/tasks?filter=all');
    assert.equal(tasks.status, 401, 'protected data is refused after logout');

    await ui.goto('#dashboard');
    assert.match(ui.text('#view'), /Sign in to continue/);
    await ui.goto('#tasks');
    assert.match(ui.text('#view'), /Sign in to continue/);
  });
});

test('the session and tasks survive a reload', async () => {
  let first;
  let second;
  try {
    first = await mountUI({});
    const account = await register(first);
    const created = await first.api('/api/tasks', {
      method: 'POST',
      body: { title: 'Renew insurance', dueAt: Date.now() + 3_600_000, timezone: 'UTC' },
    });
    assert.equal(created.status, 201);

    // A brand-new document with the same cookie is exactly what a refresh does.
    second = await mountUI({ app: first.app, cookie: first.jar(), hash: 'dashboard' });

    assert.equal(second.store().user.email, account.email, 'the cookie restores the session');
    await second.waitFor(() => second.text('#today-list').includes('Renew insurance'), { label: 'tasks after reload' });
    assert.match(second.text('#account-name'), /Satish/);
    assert.deepEqual(second.errors, []);
  } finally {
    second?.teardown();
    first?.teardown();
  }
});

test('a static-only copy (no API behind it) explains itself instead of failing everywhere', async () => {
  // Exactly what GitHub Pages does with /api/*: a plain 404 for every call.
  const staticHost = async (input) => {
    const url = String(input);
    if (url.includes('/api/')) {
      return new Response('<!doctype html><title>404</title><h1>404</h1>', {
        status: 404,
        headers: { 'content-type': 'text/html' },
      });
    }
    return new Response('not found', { status: 404 });
  };

  await withUI({ uiFetch: staticHost }, async (ui) => {
    // The marketing page still renders, so the copy is not a blank screen.
    assert.equal(ui.win.location.hash, '#home');
    assert.match(ui.text('#view'), /Your day, handled/);

    const notice = ui.$('#backend-notice');
    assert.ok(notice, 'a notice explains that this copy has no API');
    assert.match(ui.text('#backend-notice'), /no API, database or AI behind it/);
    assert.equal(ui.store().backendReachable, false);

    // Sign-in is still visible, but the notice stays in front of the user.
    await ui.goto('#register');
    assert.ok(ui.$('#auth-form'), 'the form is shown');
    assert.ok(ui.$('#backend-notice'), 'and the explanation is still there');

    // Nothing leaked from the host's error page, and no crash.
    assert.doesNotMatch(ui.text('#view') + ui.text('#backend-notice'), /404|doctype|<!doctype/i);
    assert.deepEqual(ui.errors, []);
  });
});

test('the backend notice clears itself once the API answers again', async () => {
  let failing = true;
  const ui = await mountUI({
    uiFetch: (input, init, { bridge }) =>
      failing && String(input).includes('/api/')
        ? Promise.resolve(new Response('gone', { status: 503 }))
        : bridge(input, init),
  });
  try {
    await ui.waitFor(() => ui.$('#backend-notice'), { label: 'notice for a failing service' });
    assert.match(ui.text('#backend-notice'), /having trouble|not available/);
    assert.doesNotMatch(ui.text('#backend-notice'), /503|gone/, 'no raw host error is shown');

    failing = false;
    ui.click('[data-action="retry-backend"]');
    await ui.waitFor(() => !ui.$('#backend-notice'), { label: 'notice cleared after recovery' });
    assert.equal(ui.store().backendReachable, true);
    assert.deepEqual(ui.errors, []);
  } finally {
    ui.teardown();
  }
});

test('a broken JSON reply from the API never leaves a blank screen', async () => {
  await withUI({}, async (ui) => {
    await register(ui);

    // Sabotage only the chat endpoint for this check.
    const realHandle = ui.app.handle.bind(ui.app);
    const original = ui.app.handle;
    ui.app.handle = async (request) => {
      if (new URL(request.url).pathname === '/api/chat' && request.method === 'GET') {
        return new Response('<html>gateway timeout</html>', { status: 502, headers: { 'content-type': 'text/html' } });
      }
      return realHandle(request);
    };

    await ui.goto('#assistant');
    assert.ok(ui.$('#chat-log'), 'the assistant view still renders');
    await ui.waitFor(() => ui.$('#chat-log').textContent.trim().length > 0, { label: 'welcome message' });
    assert.doesNotMatch(ui.text('#chat-log'), /gateway timeout|502/, 'the failure is not surfaced verbatim');
    assert.deepEqual(ui.errors, []);
    ui.app.handle = original;
  });
});
