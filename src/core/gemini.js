/**
 * Gemini API client (server side only).
 *
 * The API key is read from the environment by the caller and is never included
 * in a response body, a log line or client-side code. Every failure mode is
 * mapped to an AppError with a user-safe message so the interface can show a
 * friendly state instead of breaking.
 *
 * Hardening included here:
 * - request timeout via AbortController (a hung provider cannot hang the request)
 * - bounded retries with jitter for 429 / 5xx
 * - automatic model discovery when the configured model name is not available
 *   for this API key (model names change over time)
 * - tolerant JSON extraction because a model occasionally wraps JSON in prose
 */
import { AppError, upstreamFailure } from './errors.js';

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com';
const DEFAULT_MODEL = 'gemini-3.5-flash';
const DEFAULT_TIMEOUT_MS = 15_000;

/** Preferred models, best first, used when the configured one is unavailable. */
const MODEL_PREFERENCE = [
  'gemini-3.5-flash',
  'gemini-3-flash',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
  'gemini-flash-latest',
];

const SKIP_MODEL = /embedding|aqa|imagen|veo|gemma|learnlm|vision-only|tts|native-audio/i;

export const aiNotConfigured = () =>
  new AppError(
    'The AI assistant is not configured yet. Add a Gemini API key in the server environment variables to enable it.',
    { status: 503, code: 'ai_not_configured' },
  );

export const aiTimeout = () =>
  new AppError('The AI assistant took too long to respond. Please try again.', { status: 504, code: 'ai_timeout' });

export const aiRateLimited = (retryAfter = 20) =>
  new AppError('The AI assistant is handling a lot of requests right now. Please try again in a moment.', {
    status: 429,
    code: 'ai_rate_limited',
    retryAfter,
  });

export const aiInvalidResponse = () =>
  new AppError('The AI assistant returned a response we could not read. Please try rephrasing your request.', {
    status: 502,
    code: 'ai_invalid_response',
  });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Extract a JSON object from model output that may contain prose or fences. */
export function extractJson(text) {
  if (typeof text !== 'string') return null;
  let value = text.trim();
  if (!value) return null;
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(value);
  if (fence) value = fence[1].trim();
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start !== -1 && end > start) value = value.slice(start, end + 1);
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readText(payload) {
  const candidate = payload?.candidates?.[0];
  const parts = candidate?.content?.parts;
  if (Array.isArray(parts)) {
    const text = parts
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .join('')
      .trim();
    if (text) return text;
  }
  return '';
}

function blockReason(payload) {
  return payload?.promptFeedback?.blockReason || payload?.candidates?.[0]?.finishReason || '';
}

export function createGeminiClient({
  apiKey,
  model = DEFAULT_MODEL,
  baseUrl = DEFAULT_BASE,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
  maxRetries = 2,
  logger = console,
} = {}) {
  if (!apiKey) throw aiNotConfigured();
  const root = baseUrl.replace(/\/$/, '');
  const modelCache = { current: model, discovered: null, rejected: new Set() };

  async function request(path, init, { timeout = timeoutMs } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      return await fetchImpl(`${root}${path}`, {
        ...init,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey, ...(init?.headers || {}) },
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw aiTimeout();
      // Network/DNS/TLS problems: report as provider unavailability without details.
      throw upstreamFailure('The AI service is unreachable right now. Please try again shortly.', 'ai_unavailable');
    } finally {
      clearTimeout(timer);
    }
  }

  /** Ask the API which models this key can use. Cached for the process lifetime. */
  async function discoverModels() {
    if (modelCache.discovered) return modelCache.discovered;
    const response = await request(`/v1beta/models`, { method: 'GET' }, { timeout: 8000 });
    if (!response.ok) return [];
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      return [];
    }
    const names = (payload?.models || [])
      .filter((entry) => (entry.supportedGenerationMethods || []).includes('generateContent'))
      .map((entry) => String(entry.name || '').replace(/^models\//, ''))
      .filter((name) => name && !SKIP_MODEL.test(name));
    const ranked = [...names].sort((a, b) => {
      const rank = (value) => (MODEL_PREFERENCE.findIndex((preferred) => value.includes(preferred)) + 1 || 999);
      return rank(a) - rank(b);
    });
    const ordered = [...MODEL_PREFERENCE.filter((name) => names.includes(name)), ...ranked];
    modelCache.discovered = [...new Set(ordered)];
    return modelCache.discovered;
  }

  async function post(path, body, retry = 0) {
    const response = await request(path, { method: 'POST', body: JSON.stringify(body) });
    if (response.status === 429) {
      if (retry < maxRetries) {
        await sleep(400 * 2 ** retry + Math.floor(Math.random() * 250));
        return post(path, body, retry + 1);
      }
      throw aiRateLimited(Number(response.headers?.get?.('retry-after')) || 20);
    }
    if (response.status >= 500) {
      if (retry < maxRetries) {
        await sleep(300 * 2 ** retry + Math.floor(Math.random() * 200));
        return post(path, body, retry + 1);
      }
      throw upstreamFailure('The AI service is temporarily unavailable. Please try again shortly.', 'ai_unavailable');
    }
    return response;
  }

  async function readError(response) {
    try {
      const payload = await response.json();
      return {
        status: response.status,
        message: String(payload?.error?.message || ''),
        status2: String(payload?.error?.status || ''),
      };
    } catch {
      return { status: response.status, message: '', status2: '' };
    }
  }

  /**
   * Generate a JSON object from the model.
   * @param {object} options
   * @param {string} options.systemInstruction
   * @param {string} options.userContent
   * @param {object} [options.schema]
   * @param {number} [options.temperature]
   * @param {number} [options.maxOutputTokens]
   * @param {Array} [options.history]  previous turns: [{role:'user'|'model', text:string}]
   */
  async function generateJson({
    systemInstruction,
    userContent,
    schema,
    temperature = 0.25,
    maxOutputTokens = 900,
    history = [],
  }) {
    const contents = [
      ...history.slice(-8).map((turn) => ({ role: turn.role === 'assistant' ? 'model' : 'user', parts: [{ text: turn.text }] })),
      { role: 'user', parts: [{ text: userContent }] },
    ];

    const baseBody = {
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents,
      generationConfig: {
        temperature,
        maxOutputTokens,
        responseMimeType: 'application/json',
        ...(schema ? { responseSchema: schema } : {}),
      },
    };

    const candidates = [modelCache.current, ...(await discoverModelsSafe())];
    const attempted = new Set();
    let lastError = null;

    for (const candidate of candidates) {
      if (!candidate || attempted.has(candidate) || modelCache.rejected.has(candidate)) continue;
      attempted.add(candidate);
      let response = await post(`/v1beta/models/${encodeURIComponent(candidate)}:generateContent`, baseBody);

      if (response.status === 404) {
        modelCache.rejected.add(candidate);
        continue;
      }
      if (response.status === 400) {
        const detail = await readError(response);
        // Some models reject `responseSchema`; retry once without structured
        // output and rely on the instruction plus tolerant JSON extraction.
        if (/schema|response_mime|responseMime|responseFormat/i.test(detail.message)) {
          const relaxed = {
            ...baseBody,
            generationConfig: { temperature, maxOutputTokens },
          };
          response = await post(`/v1beta/models/${encodeURIComponent(candidate)}:generateContent`, relaxed);
        } else if (/not found|not supported|does not support/i.test(detail.message)) {
          modelCache.rejected.add(candidate);
          continue;
        } else if (detail.status === 400) {
          lastError = detail;
          logger.warn?.('[stratarix] gemini rejected the request', { status: detail.status, reason: detail.status2 });
          continue;
        }
      }
      if (response.status === 403) {
        // Bad key / API not enabled for the project.
        throw new AppError(
          'The AI assistant could not authenticate with the AI service. An administrator needs to check the API key.',
          { status: 503, code: 'ai_auth_failed' },
        );
      }
      if (!response.ok) {
        const detail = await readError(response);
        lastError = detail;
        continue;
      }

      let payload;
      try {
        payload = await response.json();
      } catch {
        throw aiInvalidResponse();
      }

      const text = readText(payload);
      if (!text) {
        const reason = blockReason(payload);
        if (reason && /SAFETY|BLOCKLIST|PROHIBITED|RECITATION/i.test(reason)) {
          throw new AppError(
            'I could not answer that one. Try rephrasing it as a reminder, for example “Remind me to call Arun at 5 PM”.',
            { status: 422, code: 'ai_blocked' },
          );
        }
        if (reason === 'MAX_TOKENS') throw aiInvalidResponse();
        throw aiInvalidResponse();
      }

      const json = extractJson(text);
      if (!json) throw aiInvalidResponse();
      modelCache.current = candidate;
      return { data: json, model: candidate, raw: payload };
    }

    logger.warn?.('[stratarix] no usable gemini model', { status: lastError?.status, reason: lastError?.status2 });
    throw upstreamFailure('The AI service is temporarily unavailable. Please try again shortly.', 'ai_unavailable');
  }

  async function discoverModelsSafe() {
    try {
      return await discoverModels();
    } catch {
      return [];
    }
  }

  return {
    generateJson,
    get model() {
      return modelCache.current;
    },
    async probe() {
      // Lightweight check used by /api/config so the UI can tell the truth about
      // whether the assistant is reachable.
      try {
        const models = await discoverModels();
        return { reachable: true, models: models.slice(0, 5) };
      } catch {
        return { reachable: false, models: [] };
      }
    },
  };
}

export { DEFAULT_MODEL };
