/**
 * Shared helpers for the API test suite.
 *
 * The app is exercised through the real router with real Request/Response
 * objects, so the tests cover validation, cookies, ownership checks and error
 * mapping exactly as production does — without opening a socket.
 */
import { openDatabase } from '../src/core/db/index.js';
import { createApp } from '../src/core/app.js';

export const ORIGIN = 'https://app.example.test';

export async function createTestApp({ env = {}, fetchImpl = fetch } = {}) {
  const db = await openDatabase({ forceMemory: true, onInfo: () => {} });
  const app = createApp({
    db,
    env: { NODE_ENV: 'production', APP_ORIGIN: ORIGIN, ...env },
    logger: { warn() {}, error() {}, log() {}, info() {} },
    fetchImpl,
  });
  return { app, db, origin: ORIGIN };
}

/** Build a request the way the browser would. */
export function makeRequest(path, { method = 'GET', body, cookie, headers = {}, origin = ORIGIN, raw = false } = {}) {
  const finalHeaders = new Headers({ 'x-stratarix-request': '1', ...headers });
  if (origin) finalHeaders.set('origin', origin);
  if (cookie) finalHeaders.set('cookie', cookie);
  if (body !== undefined && !raw) finalHeaders.set('content-type', 'application/json');
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: finalHeaders,
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    duplex: body === undefined ? undefined : 'half',
  });
}

export async function call(app, path, options = {}) {
  const response = await app.handle(makeRequest(path, options));
  let data = null;
  const text = await response.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  const setCookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  return { status: response.status, data, headers: response.headers, setCookies, cookie: setCookies[0]?.split(';')[0] };
}

/** Register a user and return a signed-in session. */
export async function signUp(app, { name = 'Test User', email = `user${Math.random().toString(36).slice(2)}@example.test`, password = 'test-password-long-123', timezone = 'Asia/Kolkata' } = {}) {
  const response = await call(app, '/api/register', { method: 'POST', body: { name, email, password, timezone } });
  if (response.status !== 201) throw new Error(`sign-up failed: ${response.status} ${JSON.stringify(response.data)}`);
  return { user: response.data.user, cookie: response.cookie, email, password };
}

/**
 * A scriptable stand-in for the Gemini REST API.
 * `script` is a list of responders: (request) => Response | Promise<Response>.
 * When the list is exhausted the last responder is reused.
 */
export function mockGemini(script, { models = ['gemini-3.5-flash', 'gemini-2.5-flash'] } = {}) {
  const calls = [];
  let index = 0;
  const fetchImpl = async (url, init = {}) => {
    const href = String(url);
    calls.push({ url: href, body: init.body ? JSON.parse(init.body) : null, headers: init.headers || {} });
    if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });

    if (/\/v1beta\/models(\?|$)/.test(href)) {
      return Response.json({
        models: models.map((name) => ({ name: `models/${name}`, supportedGenerationMethods: ['generateContent'] })),
      });
    }

    const responder = script[Math.min(index, script.length - 1)];
    index += 1;
    if (typeof responder === 'function') {
      return responder({ url: href, init, callIndex: index - 1 });
    }
    return responder;
  };
  return { fetchImpl, calls, get count() { return calls.length; } };
}

/** Build a Gemini success response containing `data` as JSON text. */
export function geminiJson(data, { model = 'gemini-3.5-flash' } = {}) {
  return Response.json({
    candidates: [
      {
        content: { role: 'model', parts: [{ text: typeof data === 'string' ? data : JSON.stringify(data) }] },
        finishReason: 'STOP',
      },
    ],
    modelVersion: model,
  });
}
