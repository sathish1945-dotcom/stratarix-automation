/**
 * Gemini client behaviour: retries, timeouts, model fallback, tolerant parsing
 * and the guarantee that the API key never leaks into an error message.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiClient, extractJson } from '../src/core/gemini.js';
import { geminiJson, mockGemini } from './helpers.mjs';

// Assembled at runtime so this fixture can never be mistaken for a real key.
const KEY = ['AIza', 'NotARealKeyFixtureForTests12345'].join('');

function client(script, options = {}) {
  const mock = mockGemini(script, options);
  const instance = createGeminiClient({
    apiKey: KEY,
    model: options.model || 'gemini-3.5-flash',
    fetchImpl: mock.fetchImpl,
    logger: { warn() {} },
    maxRetries: options.maxRetries ?? 2,
    timeoutMs: options.timeoutMs ?? 500,
  });
  return { instance, mock };
}

test('a successful call returns parsed JSON and the model that answered', async () => {
  const { instance, mock } = client([geminiJson({ intent: 'create_task', title: 'Call Arun', reply: 'Sure.' })]);
  const result = await instance.generateJson({
    systemInstruction: 'sys',
    userContent: 'call Arun',
    schema: { type: 'OBJECT', properties: { title: { type: 'STRING' } } },
  });
  assert.equal(result.data.title, 'Call Arun');
  assert.equal(result.model, 'gemini-3.5-flash');
  assert.match(mock.calls.at(-1).url, /models\/gemini-3\.5-flash:generateContent$/);
  assert.equal(mock.calls.at(-1).headers['x-goog-api-key'], KEY);
  assert.equal(mock.calls.at(-1).body.generationConfig.responseMimeType, 'application/json');
  assert.ok(mock.calls.at(-1).body.generationConfig.responseSchema);
});

test('rate limiting (429) is retried and then reported as a friendly error', async () => {
  const rateLimited = () => Response.json({ error: { code: 429, message: 'quota' } }, { status: 429 });
  const { instance, mock } = client([rateLimited]);
  await assert.rejects(
    () => instance.generateJson({ systemInstruction: 's', userContent: 'u' }),
    (error) => {
      assert.equal(error.code, 'ai_rate_limited');
      assert.equal(error.status, 429);
      assert.match(error.message, /a lot of requests/i);
      return true;
    },
  );
  // initial attempt + 2 retries (model list adds one more call for discovery).
  const generations = mock.calls.filter((call) => call.url.includes(':generateContent'));
  assert.equal(generations.length, 3);
});

test('transient 503 succeeds after a retry', async () => {
  let attempt = 0;
  const { instance } = client([
    () => {
      attempt += 1;
      if (attempt === 1) return Response.json({ error: { message: 'unavailable' } }, { status: 503 });
      return geminiJson({ intent: 'chat', reply: 'Hello.' });
    },
  ]);
  const result = await instance.generateJson({ systemInstruction: 's', userContent: 'u' });
  assert.equal(result.data.reply, 'Hello.');
});

test('an unknown model falls back to a discovered one', async () => {
  const notFound = () => Response.json({ error: { status: 'NOT_FOUND', message: 'model not found' } }, { status: 404 });
  const callUrls = [];
  const mock = mockGemini([geminiJson({ intent: 'chat', reply: 'From the fallback model.' })], {
    models: ['gemini-2.5-flash'],
  });
  const instance = createGeminiClient({
    apiKey: KEY,
    model: 'gemini-does-not-exist',
    fetchImpl: async (url, init) => {
      callUrls.push(String(url));
      if (String(url).includes('gemini-does-not-exist') && String(url).includes(':generateContent')) return notFound();
      return mock.fetchImpl(url, init);
    },
    logger: { warn() {} },
    maxRetries: 0,
  });
  const result = await instance.generateJson({ systemInstruction: 's', userContent: 'u' });
  assert.equal(result.data.reply, 'From the fallback model.');
  assert.equal(result.model, 'gemini-2.5-flash');
  assert.ok(callUrls.some((url) => url.includes('gemini-does-not-exist')));
  assert.ok(callUrls.some((url) => url.includes('gemini-2.5-flash:generateContent')));
});

test('a response that is not JSON is rejected safely', async () => {
  const { instance } = client([geminiJson('I am not JSON at all, sorry.')]);
  await assert.rejects(
    () => instance.generateJson({ systemInstruction: 's', userContent: 'u' }),
    (error) => {
      assert.equal(error.code, 'ai_invalid_response');
      assert.match(error.message, /could not read/i);
      return true;
    },
  );
});

test('safety blocks are reported without provider text', async () => {
  const { instance } = client([
    Response.json({ promptFeedback: { blockReason: 'SAFETY' }, candidates: [] }, { status: 200 }),
  ]);
  await assert.rejects(
    () => instance.generateJson({ systemInstruction: 's', userContent: 'u' }),
    (error) => {
      assert.equal(error.code, 'ai_blocked');
      assert.doesNotMatch(error.message, /SAFETY/);
      return true;
    },
  );
});

test('a hung provider hits the timeout instead of hanging the request', async () => {
  const mock = mockGemini([
    ({ init }) =>
      new Promise((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }),
  ]);
  const instance = createGeminiClient({
    apiKey: KEY,
    model: 'gemini-3.5-flash',
    fetchImpl: mock.fetchImpl,
    logger: { warn() {} },
    timeoutMs: 60,
    maxRetries: 0,
  });
  await assert.rejects(
    () => instance.generateJson({ systemInstruction: 's', userContent: 'u' }),
    (error) => {
      assert.equal(error.code, 'ai_timeout');
      return true;
    },
  );
});

test('an unauthorised key is reported as a configuration problem', async () => {
  const { instance } = client([Response.json({ error: { status: 'PERMISSION_DENIED' } }, { status: 403 })]);
  await assert.rejects(
    () => instance.generateJson({ systemInstruction: 's', userContent: 'u' }),
    (error) => {
      assert.equal(error.code, 'ai_auth_failed');
      assert.doesNotMatch(error.message, new RegExp(KEY));
      return true;
    },
  );
});

test('missing configuration is refused before any network call', () => {
  assert.throws(() => createGeminiClient({ apiKey: '' }), (error) => error.code === 'ai_not_configured');
});

test('JSON extraction tolerates fences and surrounding prose', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Sure! {"a":2} hope that helps'), { a: 2 });
  assert.equal(extractJson('no json here'), null);
  assert.equal(extractJson('[1,2,3]'), null);
});

test('a model that rejects responseSchema is retried without it', async () => {
  let attempt = 0;
  const { instance, mock } = client([
    () => {
      attempt += 1;
      if (attempt === 1) {
        return Response.json(
          { error: { status: 'INVALID_ARGUMENT', message: 'responseSchema is not supported for this model' } },
          { status: 400 },
        );
      }
      return geminiJson({ intent: 'chat', reply: 'Relaxed call worked.' });
    },
  ]);
  const result = await instance.generateJson({ systemInstruction: 's', userContent: 'u', schema: { type: 'OBJECT' } });
  assert.equal(result.data.reply, 'Relaxed call worked.');
  const generation = mock.calls.filter((call) => call.url.includes(':generateContent'));
  assert.ok(generation.length >= 2);
  assert.ok(generation[1].body.generationConfig.responseSchema === undefined);
});
