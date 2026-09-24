/**
 * HTTP API built on the Web Request/Response interfaces.
 *
 * The same router is used by the local Node server and by the serverless
 * function, so local behaviour and production behaviour cannot drift apart.
 *
 * Security boundaries enforced here (never in the UI):
 *  - state-changing requests must be same-origin and carry the app's request header
 *  - every task/chat route requires a valid session
 *  - request bodies are size limited and strictly validated
 *  - per-IP and per-user rate limits protect both the database and the AI quota
 *  - errors are mapped to safe messages; stack traces never leave the server
 */
import { AppError, logError, logInfo, toPublicError } from './errors.js';
import { badRequest, forbidden, notFound } from './errors.js';
import { createAuthService } from './auth.js';
import { createTaskService, FILTERS } from './tasks.js';
import { createChatService } from './chat.js';
import { createAiService } from './ai.js';
import { createRateLimiter } from './rate-limit.js';
import { assertId, assertTimezone, requireObject, safeMessage, text } from './validate.js';

export const APP_VERSION = '2.0.0';

const MAX_BODY_BYTES = 64 * 1024;
const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

class ApiResponse {
  constructor({ secureCookies = false } = {}) {
    this.secureCookies = secureCookies;
    this.status = 200;
    this.headers = new Headers({ 'Cache-Control': 'no-store' });
    this.cookies = [];
    this.payload = null;
  }

  setCookie(name, value, { maxAge, httpOnly = true, secure = false, sameSite = 'Lax' } = {}) {
    const parts = [`${name}=${value}`, 'Path=/', `SameSite=${sameSite}`];
    if (httpOnly) parts.push('HttpOnly');
    if (secure) parts.push('Secure');
    if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
    this.cookies.push(parts.join('; '));
    return this;
  }

  clearCookie(name, { secure = false } = {}) {
    return this.setCookie(name, '', { maxAge: 0, secure });
  }

  /** Session cookies always carry the app's hardened defaults. */
  setSessionCookie(name, value, maxAgeSeconds) {
    return this.setCookie(name, value, { maxAge: maxAgeSeconds, secure: this.secureCookies });
  }

  clearSessionCookie(name) {
    return this.clearCookie(name, { secure: this.secureCookies });
  }

  json(status, payload) {
    this.status = status;
    this.payload = payload;
    return this;
  }

  toResponse() {
    const headers = new Headers(this.headers);
    headers.set('Content-Type', 'application/json; charset=utf-8');
    for (const cookie of this.cookies) headers.append('Set-Cookie', cookie);
    const body = this.status === 204 || this.payload === null ? null : JSON.stringify(this.payload);
    return new Response(body, { status: this.status, headers });
  }
}

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

function clientIp(headers, { trustProxy }) {
  if (trustProxy) {
    const forwarded = headers['x-forwarded-for'] || headers['x-vercel-forwarded-for'];
    if (forwarded) return String(forwarded).split(',')[0].trim().slice(0, 64);
  }
  return String(headers['x-real-ip'] || 'unknown').slice(0, 64);
}

export function createApp({ db, env = process.env, logger = console, staticHandler = null, fetchImpl = fetch } = {}) {
  const production = env.NODE_ENV === 'production';
  const secureCookies = production || String(env.APP_ORIGIN || '').startsWith('https://');
  const cookieName = secureCookies ? '__Host-stratarix_session' : 'stratarix_session';
  const configuredOrigin = String(env.APP_ORIGIN || '').replace(/\/$/, '');
  const trustProxy = Boolean(env.TRUST_PROXY) || Boolean(env.VERCEL) || Boolean(configuredOrigin);

  const auth = createAuthService({ db, config: { cookieName, sessionDuration: Number(env.SESSION_TTL_MS) || undefined } });
  const taskService = createTaskService({ db });
  const ai = createAiService({ env, logger, fetchImpl });
  const chat = createChatService({ db, tasks: taskService, ai });

  const limiters = {
    auth: createRateLimiter({ limit: 20, windowMs: 60_000, name: 'sign-in attempts' }),
    write: createRateLimiter({ limit: 90, windowMs: 60_000, name: 'requests' }),
    chat: createRateLimiter({ limit: 20, windowMs: 60_000, name: 'chat messages' }),
    chatDaily: createRateLimiter({ limit: 300, windowMs: 24 * 60 * 60 * 1000, name: 'daily chat messages' }),
    read: createRateLimiter({ limit: 300, windowMs: 60_000, name: 'requests' }),
  };

  async function readJson(ctx) {
    const contentType = ctx.headers['content-type'] || '';
    if (!contentType.includes('application/json')) throw badRequest('Send this request as JSON.', 'unsupported_type');
    const body = await ctx.raw.text();
    if (body.length > MAX_BODY_BYTES) {
      throw new AppError('That request is too large.', { status: 413, code: 'payload_too_large' });
    }
    if (!body) return {};
    try {
      return requireObject(JSON.parse(body));
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw badRequest('The request body was not valid JSON.', 'invalid_json');
    }
  }

  /** CSRF / cross-origin protection for state-changing requests. */
  function assertSameOrigin(ctx) {
    if (ctx.headers['sec-fetch-site'] === 'cross-site') {
      throw forbidden('That request was blocked for security reasons.', 'cross_site');
    }
    if (ctx.headers['x-stratarix-request'] !== '1') {
      throw forbidden('That request was blocked for security reasons.', 'missing_request_header');
    }
    const origin = ctx.headers.origin;
    if (!origin) return; // Older same-origin clients: the header check above already passed.
    const requestOrigin = new URL(ctx.raw.url).origin;
    if (origin !== requestOrigin && (!configuredOrigin || origin !== configuredOrigin)) {
      throw forbidden('That request came from a different site.', 'bad_origin');
    }
  }

  async function route(ctx, response, url) {
    const path = url.pathname.replace(/\/+$/, '') || '/api';
    const method = ctx.method;

    /* ---------------- public endpoints ---------------- */

    if (path === '/api/health' && method === 'GET') {
      return response.json(200, { ok: true, version: APP_VERSION, ai: ai.configured });
    }

    if (path === '/api/config' && method === 'GET') {
      return response.json(200, {
        authentication: true,
        version: APP_VERSION,
        ai: { configured: ai.configured, model: ai.model, fallbackParser: ai.fallbackEnabled },
        push: {
          // Web Push needs VAPID keys plus a server-side scheduler. Until those
          // exist this stays false, and the interface says so plainly rather than
          // promising notifications that cannot be delivered.
          enabled: false,
          reason: 'Web Push delivery is not enabled on this deployment yet.',
        },
        limits: { maxTitle: 160, maxDescription: 2000, maxMessage: 1500 },
      });
    }

    if (path === '/api/me' && method === 'GET') {
      const user = await auth.optionalUser(ctx);
      return response.json(200, { user: auth.publicUser(user) });
    }

    if (path === '/api/register' && method === 'POST') {
      const body = await readJson(ctx);
      const result = await auth.register(
        {
          name: body.name,
          email: body.email,
          password: body.password,
          timezone: assertTimezone(body.timezone, 'UTC'),
        },
        ctx,
        response,
      );
      logInfo('auth.register', { userId: result.user.id });
      return response.json(201, { user: result.user, signedIn: true });
    }

    if (path === '/api/login' && method === 'POST') {
      const body = await readJson(ctx);
      const result = await auth.login(
        { email: body.email, password: body.password, timezone: assertTimezone(body.timezone, 'UTC') },
        ctx,
        response,
      );
      return response.json(200, { user: result.user, signedIn: true });
    }

    if (path === '/api/logout' && method === 'POST') {
      await auth.logout(ctx, response);
      return response.json(200, { ok: true, signedIn: false });
    }

    if (path === '/api/push/config' && method === 'GET') {
      return response.json(200, {
        enabled: false,
        reason:
          'Scheduled push notifications need VAPID keys and a server-side scheduler, which are not configured on this deployment. Notifications work while the app is open in a tab.',
      });
    }

    /* ---------------- authenticated endpoints ---------------- */

    const timezone = assertTimezone(url.searchParams.get('timezone') || '', 'UTC');

    if (path === '/api/profile' && method === 'POST') {
      const body = await readJson(ctx);
      const user = await auth.requireUser(ctx, { timezone: assertTimezone(body.timezone, '') || undefined });
      const updated = await auth.updateProfile(user.id, { name: body.name, timezone: text(body.timezone) || undefined });
      return response.json(200, { user: updated });
    }

    if (path === '/api/password' && method === 'POST') {
      const body = await readJson(ctx);
      const user = await auth.requireUser(ctx);
      await auth.changePassword(
        user.id,
        { currentPassword: body.currentPassword, newPassword: body.newPassword },
        ctx,
        response,
      );
      return response.json(200, { ok: true, message: 'Password updated. Other devices have been signed out.' });
    }

    if (path === '/api/tasks' && method === 'GET') {
      const user = await auth.requireUser(ctx, { timezone });
      const filter = url.searchParams.get('filter') || 'all';
      const search = safeMessage(url.searchParams.get('search') || '', 80);
      const listing = await taskService.list(user.id, { filter, timeZone: timezone, search });
      return response.json(200, listing);
    }

    if (path === '/api/tasks' && method === 'POST') {
      const body = await readJson(ctx);
      const user = await auth.requireUser(ctx, { timezone: assertTimezone(body.timezone, '') || undefined });
      const task = await taskService.create(
        user.id,
        { ...body, timezone: body.timezone || timezone },
        { timeZone: timezone },
      );
      return response.json(201, { task });
    }

    if (path === '/api/reminders/due' && method === 'GET') {
      const user = await auth.requireUser(ctx, { timezone });
      const due = await taskService.dueReminders(user.id, { timeZone: timezone });
      return response.json(200, { tasks: due, serverTime: Date.now() });
    }

    if (path === '/api/chat' && method === 'GET') {
      const user = await auth.requireUser(ctx, { timezone });
      const messages = await chat.list(user.id);
      return response.json(200, { messages, ai: { configured: ai.configured, model: ai.model } });
    }

    if (path === '/api/chat' && method === 'DELETE') {
      const user = await auth.requireUser(ctx);
      await chat.clear(user.id);
      return response.json(200, { ok: true });
    }

    if (path === '/api/chat' && method === 'POST') {
      const body = await readJson(ctx);
      const user = await auth.requireUser(ctx, { timezone: assertTimezone(body.timezone, '') || undefined });
      limiters.chat.hit(`chat:${user.id}`);
      limiters.chatDaily.hit(`chat-day:${user.id}`, 1, 'You have reached today’s AI message limit. It resets in 24 hours.');
      const result = await chat.handleMessage(user, { message: body.message, timeZone: timezone });
      return response.json(200, result);
    }

    const taskAction = /^\/api\/tasks\/(\d+)(?:\/(complete|reopen|reschedule|notified))?$/.exec(path);
    if (taskAction) {
      const id = assertId(taskAction[1]);
      const action = taskAction[2];

      if (method === 'PATCH' && !action) {
        const body = await readJson(ctx);
        const user = await auth.requireUser(ctx, { timezone: assertTimezone(body.timezone, '') || undefined });
        const task = await taskService.update(user.id, id, body, { timeZone: timezone });
        return response.json(200, { task });
      }

      if (method === 'DELETE' && !action) {
        const user = await auth.requireUser(ctx);
        const result = await taskService.remove(user.id, id);
        return response.json(200, result);
      }

      if (method === 'POST' && action === 'complete') {
        const user = await auth.requireUser(ctx, { timezone });
        const result = await taskService.complete(user.id, id, { timeZone: timezone });
        return response.json(200, result);
      }

      if (method === 'POST' && action === 'reopen') {
        const user = await auth.requireUser(ctx, { timezone });
        const task = await taskService.reopen(user.id, id, { timeZone: timezone });
        return response.json(200, { task });
      }

      if (method === 'POST' && action === 'reschedule') {
        const body = await readJson(ctx);
        const user = await auth.requireUser(ctx, { timezone: assertTimezone(body.timezone, '') || undefined });
        const task = await taskService.reschedule(user.id, id, {
          dueAt: body.dueAt,
          preset: body.preset,
          timeZone: timezone,
        });
        return response.json(200, { task });
      }

      if (method === 'POST' && action === 'notified') {
        const user = await auth.requireUser(ctx);
        await taskService.markNotified(user.id, id);
        return response.json(200, { ok: true });
      }

      return response.json(405, { error: 'That method is not allowed here.', code: 'method_not_allowed' });
    }

    /* ---------------- Web Push scaffolding ---------------- */
    if (path === '/api/push/subscribe' && method === 'POST') {
      const user = await auth.requireUser(ctx);
      const body = await readJson(ctx);
      const endpoint = safeMessage(body.endpoint, 500);
      if (!endpoint) throw badRequest('A push subscription endpoint is required.', 'invalid_subscription');
      await db.run(
        `INSERT INTO push_subscriptions (user_id, endpoint, keys, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, keys = excluded.keys`,
        [user.id, endpoint, JSON.stringify(body.keys || {}).slice(0, 2000), Date.now()],
      );
      // Stored so delivery can start the moment VAPID keys and a scheduler exist.
      return response.json(202, {
        ok: true,
        delivering: false,
        message: 'Subscription stored. Automatic push delivery is not enabled on this deployment yet.',
      });
    }

    if (path === '/api/push/unsubscribe' && method === 'POST') {
      const user = await auth.requireUser(ctx);
      const body = await readJson(ctx);
      const endpoint = safeMessage(body.endpoint, 500);
      if (endpoint) {
        await db.run('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', [endpoint, user.id]);
      }
      return response.json(200, { ok: true });
    }

    throw notFound('That endpoint does not exist.', 'unknown_endpoint');
  }

  return {
    auth,
    taskService,
    chat,
    ai,

    async handle(request) {
      const url = new URL(request.url);
      const response = new ApiResponse({ secureCookies });
      const ctx = {
        raw: request,
        method: request.method.toUpperCase(),
        url,
        headers: Object.fromEntries(request.headers.entries()),
        cookies: parseCookies(request.headers.get('cookie')),
      };

      try {
        if (!url.pathname.startsWith('/api')) {
          if (staticHandler) return await staticHandler(request);
          throw notFound('Not found.', 'not_found');
        }

        if (ctx.method === 'OPTIONS') {
          response.headers.set('Allow', 'GET, POST, PATCH, DELETE, OPTIONS');
          return response.json(204, null).toResponse();
        }

        if (WRITE_METHODS.has(ctx.method)) {
          assertSameOrigin(ctx);
          const ip = clientIp(ctx.headers, { trustProxy });
          if (url.pathname === '/api/register' || url.pathname === '/api/login') limiters.auth.hit(`auth:${ip}`);
          else limiters.write.hit(`write:${ip}:${url.pathname}`);
        } else if (ctx.method === 'GET') {
          limiters.read.hit(`read:${clientIp(ctx.headers, { trustProxy })}`);
        }

        await route(ctx, response, url);
        return response.toResponse();
      } catch (error) {
        const publicError = toPublicError(error);
        if (!(error instanceof AppError) || publicError.status >= 500) {
          logError(publicError.original, { route: url.pathname, method: ctx.method });
        }
        if (publicError.retryAfter) response.headers.set('Retry-After', String(publicError.retryAfter));
        if (publicError.status === 401) response.clearSessionCookie(cookieName);
        return response.json(publicError.status, { error: publicError.message, code: publicError.code }).toResponse();
      }
    },

    stop() {
      for (const limiter of Object.values(limiters)) limiter.stop?.();
    },
  };
}

export { FILTERS };
