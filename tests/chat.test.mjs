/**
 * Chat behaviour with a mocked Gemini API: structured task creation, degradation
 * when the provider fails, and the guarantee that a failure never breaks the app.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, call, signUp, mockGemini, geminiJson } from './helpers.mjs';

const FAKE_KEY = ['AIza', 'MockKeyForAutomatedTests123456789'].join('');
const AI_ENV = { GEMINI_API_KEY: FAKE_KEY, GEMINI_TIMEOUT_MS: '800', GEMINI_MAX_RETRIES: '0' };

const createTaskReply = (overrides = {}) =>
  geminiJson({
    intent: 'create_task',
    reply: 'Got it.',
    needs_confirmation: false,
    title: 'Submit my assignment',
    description: '',
    due_date: '2026-09-24',
    due_time: '20:00',
    all_day: false,
    recurrence: 'none',
    priority: 'normal',
    confidence: 0.93,
    ...overrides,
  });

async function chatSetup(script, options = {}) {
  const mock = mockGemini(script, options);
  const { app } = await createTestApp({ env: { ...AI_ENV, ...(options.env || {}) }, fetchImpl: mock.fetchImpl });
  const session = await signUp(app, { timezone: 'Asia/Kolkata' });
  return { app, mock, ...session };
}

const send = (app, cookie, message) =>
  call(app, '/api/chat', { method: 'POST', cookie, body: { message, timezone: 'Asia/Kolkata' } });

test('a real AI reply creates the task and reports which model answered', async () => {
  const { app, mock, cookie } = await chatSetup([createTaskReply()]);
  const response = await send(app, cookie, 'Remind me to submit my assignment tomorrow at 8 PM.');

  assert.equal(response.status, 200);
  assert.equal(response.data.source, 'gemini');
  assert.equal(response.data.model, 'gemini-3.5-flash');
  assert.equal(response.data.intent, 'create_task');
  assert.equal(response.data.degraded, false);
  assert.equal(response.data.task.title, 'Submit my assignment');
  assert.equal(response.data.task.priority, 'normal');

  // The prompt must carry the user's local time, otherwise "tomorrow" is wrong.
  const generation = mock.calls.find((entry) => entry.url.includes(':generateContent'));
  assert.match(generation.body.systemInstruction.parts[0].text, /Current date and time for this user/);
  assert.equal(generation.body.generationConfig.responseMimeType, 'application/json');
  assert.ok(generation.body.generationConfig.responseSchema);

  const tasks = await call(app, '/api/tasks?timezone=Asia/Kolkata', { cookie });
  assert.equal(tasks.data.tasks.length, 1);
  assert.equal(tasks.data.tasks[0].source, 'gemini');

  const history = await call(app, '/api/chat', { cookie });
  assert.equal(history.data.messages.length, 2);
  assert.equal(history.data.messages[0].role, 'user');
  assert.equal(history.data.messages[1].role, 'assistant');
});

test('repeat rules and all-day dates from the model are normalised', async () => {
  const { app, cookie } = await chatSetup([
    createTaskReply({ title: 'Check Buyora', due_date: '2026-09-28', due_time: '', all_day: true, recurrence: 'weekly:MONDAY' }),
  ]);
  const response = await send(app, cookie, 'Remind me every Monday to check Buyora.');
  assert.equal(response.data.task.recurrence, 'weekly:1');
  assert.equal(response.data.task.allDay, true);
});

test('the model can complete, list and answer without inventing tasks', async () => {
  const completeScript = [
    createTaskReply({ title: 'Call Arun', due_time: '18:00', due_date: '2026-09-23' }),
    geminiJson({ intent: 'complete_task', reply: 'Marked as done.', target_task: 'Call Arun' }),
  ];
  const { app, cookie } = await chatSetup(completeScript);
  await send(app, cookie, 'Remind me to call Arun today at 6 PM');
  const completed = await send(app, cookie, 'I finished calling Arun');
  assert.equal(completed.data.intent, 'complete_task');
  assert.equal(completed.data.task.completed, true);

  // One responder per message: create, then list.
  const listScript = [
    createTaskReply({ title: 'Call Arun', due_time: '18:00', due_date: '2026-09-23' }),
    geminiJson({ intent: 'list_tasks', reply: 'Here is your day.' }),
  ];
  const second = await chatSetup(listScript);
  await send(second.app, second.cookie, 'Remind me to call Arun today at 6 PM');
  const listed = await send(second.app, second.cookie, 'What do I have on today?');
  assert.equal(listed.data.intent, 'list_tasks');
  assert.equal(listed.data.counts.all, 1);

  const chatOnly = await chatSetup([geminiJson({ intent: 'chat', reply: 'Meetings are best batched in the morning.' })]);
  const answer = await send(chatOnly.app, chatOnly.cookie, 'When should I schedule meetings?');
  assert.equal(answer.data.intent, 'chat');
  assert.equal(answer.data.task, null);
  assert.match(answer.data.reply, /batched/);
});

test('an ambiguous request is shown for confirmation instead of being saved', async () => {
  const { app, cookie } = await chatSetup([
    createTaskReply({ needs_confirmation: true, title: 'Call someone', due_date: '', due_time: '', confidence: 0.3 }),
  ]);
  const response = await send(app, cookie, 'remind me to call that person sometime');
  assert.equal(response.data.needsConfirmation, true);
  assert.equal(response.data.task, null);
  assert.equal(response.data.preview.title, 'Call someone');
  const tasks = await call(app, '/api/tasks?timezone=Asia/Kolkata', { cookie });
  assert.equal(tasks.data.tasks.length, 0, 'nothing was written');
  // The user can still save the preview through the normal task endpoint.
  const saved = await call(app, '/api/tasks', { method: 'POST', cookie, body: { title: response.data.preview.title } });
  assert.equal(saved.status, 201);
});

test('provider failures fall back to the offline parser and say so', async () => {
  const failing = () => Response.json({ error: { message: 'quota' } }, { status: 429 });
  const { app, cookie } = await chatSetup([failing]);
  const response = await send(app, cookie, 'Remind me to call Arun in 30 minutes.');
  assert.equal(response.status, 200);
  assert.equal(response.data.degraded, true);
  assert.equal(response.data.source, 'offline-parser');
  assert.equal(response.data.notice.code, 'ai_rate_limited');
  assert.equal(response.data.task.title, 'Call Arun');
  assert.equal(response.data.notice.retryable, true);
  const tasks = await call(app, '/api/tasks?timezone=Asia/Kolkata', { cookie });
  assert.equal(tasks.data.tasks.length, 1, 'the reminder still reached the database');
});

test('an unreadable AI response does not crash the chat', async () => {
  const { app, cookie } = await chatSetup([geminiJson('I think you should just remember it yourself.')]);
  const response = await send(app, cookie, 'Add gym at 6 PM.');
  assert.equal(response.status, 200);
  assert.equal(response.data.degraded, true);
  assert.equal(response.data.notice.code, 'ai_invalid_response');
  assert.equal(response.data.task.title, 'Gym');
});

test('with no API key the app explains itself and still parses reminders', async () => {
  const { app } = await createTestApp({ env: {} });
  const { cookie } = await signUp(app, { timezone: 'Asia/Kolkata' });

  const parsed = await send(app, cookie, 'Wake me at 6 AM.');
  assert.equal(parsed.data.source, 'offline-parser');
  assert.equal(parsed.data.notice.code, 'ai_not_configured');
  assert.match(parsed.data.notice.message, /not connected yet/i);
  assert.equal(parsed.data.task.title, 'Wake up');

  const unparsed = await send(app, cookie, 'What is the meaning of life?');
  assert.equal(unparsed.data.source, 'none');
  assert.equal(unparsed.data.task, null);
  assert.match(unparsed.data.reply, /could not|not reachable|not connected/i);
  assert.equal(unparsed.status, 200);

  const config = await call(app, '/api/config');
  assert.equal(config.data.ai.configured, false);
});

test('chat requires a session and is rate limited per user', async () => {
  const { app, cookie } = await chatSetup([createTaskReply()]);
  assert.equal((await call(app, '/api/chat', { method: 'POST', body: { message: 'hi' } })).status, 401);
  assert.equal((await call(app, '/api/chat')).status, 401);

  // The limiter allows 20 messages per minute per user.
  let status = 0;
  for (let index = 0; index < 21; index += 1) {
    const response = await send(app, cookie, `Remind me to stretch in ${index + 5} minutes`);
    status = response.status;
  }
  assert.equal(status, 429);
});

test('messages are stored as plain text and hostile input is neutralised', async () => {
  const { app, cookie } = await chatSetup([geminiJson({ intent: 'chat', reply: 'Noted.' })]);
  const hostile = '<img src=x onerror="alert(1)"> <script>alert(2)</script>';
  const response = await send(app, cookie, hostile);
  assert.equal(response.status, 200);
  const history = await call(app, '/api/chat', { cookie });
  assert.equal(history.data.messages[0].content, hostile, 'stored verbatim, escaped by the client');
  assert.doesNotMatch(JSON.stringify(response.data), /<script>/);

  assert.equal((await send(app, cookie, '')).status, 400);
  assert.equal((await send(app, cookie, 'x'.repeat(1600))).status, 400);

  const cleared = await call(app, '/api/chat', { method: 'DELETE', cookie });
  assert.equal(cleared.status, 200);
  assert.equal((await call(app, '/api/chat', { cookie })).data.messages.length, 0);
});

test('the API key is never echoed back to the client', async () => {
  const { app, mock, cookie } = await chatSetup([createTaskReply()]);
  const response = await send(app, cookie, 'Remind me to submit my assignment tomorrow at 8 PM.');
  assert.doesNotMatch(JSON.stringify(response.data), /MockKeyForAutomatedTests/);
  assert.ok(mock.calls.length > 0);
  const list = await call(app, '/api/tasks?timezone=Asia/Kolkata', { cookie });
  assert.doesNotMatch(JSON.stringify(list.data), /MockKeyForAutomatedTests/);
});
