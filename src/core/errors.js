/**
 * Error handling, safe logging and secret redaction.
 *
 * Rule: user-facing messages are written by us, never taken from a thrown
 * exception, a database driver or an upstream API. Stack traces, SQL text and
 * provider payloads stay in the server log.
 */

const SECRET_PATTERNS = [
  /AIza[0-9A-Za-z_-]{10,}/g, // Google/Gemini API keys
  /\b(?:GEMINI|GOOGLE|API|TURSO|LIBSQL|VERCEL)[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)\b\s*[:=]\s*["']?[^\s"',]+/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, // JWT
];

/** Remove anything that looks like a credential before it reaches a log sink. */
export function redact(value) {
  let text = typeof value === 'string' ? value : String(value ?? '');
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '[redacted]');
  return text;
}

export class AppError extends Error {
  /**
   * @param {string} message   Safe, human-readable message (shown to the user).
   * @param {object} [options]
   * @param {number} [options.status]  HTTP status code.
   * @param {string} [options.code]    Stable machine code for the client.
   * @param {boolean} [options.expose] Whether the message may be shown to users.
   * @param {Error} [options.cause]    Underlying error (logged, never returned).
   */
  constructor(message, { status = 400, code = 'bad_request', expose = true, cause, retryAfter } = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.expose = expose;
    this.cause = cause;
    this.retryAfter = retryAfter;
  }
}

export const badRequest = (message, code = 'bad_request') => new AppError(message, { status: 400, code });
export const unauthorized = (message = 'Please sign in to continue.', code = 'unauthenticated') =>
  new AppError(message, { status: 401, code });
export const forbidden = (message = 'That request is not allowed.', code = 'forbidden') =>
  new AppError(message, { status: 403, code });
export const notFound = (message = 'We could not find that item.', code = 'not_found') =>
  new AppError(message, { status: 404, code });
export const conflict = (message, code = 'conflict') => new AppError(message, { status: 409, code });
export const tooManyRequests = (message, retryAfter = 30) =>
  new AppError(message, { status: 429, code: 'rate_limited', retryAfter });
export const upstreamFailure = (message, code = 'upstream_unavailable') =>
  new AppError(message, { status: 503, code, expose: true });
export const serverFailure = (message = 'Something went wrong on our side. Please try again.', code = 'server_error') =>
  new AppError(message, { status: 500, code, expose: true });

/**
 * Convert any thrown value into a safe public error descriptor.
 * The original error is attached for logging only.
 */
export function toPublicError(error) {
  if (error instanceof AppError) {
    return {
      status: error.status,
      code: error.code,
      message: error.expose ? error.message : 'Something went wrong. Please try again.',
      retryAfter: error.retryAfter,
      original: error,
    };
  }
  // Never leak driver/upstream text to the browser.
  return {
    status: 500,
    code: 'server_error',
    message: 'Something went wrong on our side. Please try again.',
    retryAfter: undefined,
    original: error,
  };
}

/**
 * Log an error without leaking secrets or stack traces to clients.
 * Stack traces are logged only outside production.
 */
export function logError(error, context = {}) {
  const isProduction = process.env.NODE_ENV === 'production';
  const detail = {
    at: new Date().toISOString(),
    message: redact(error?.message || String(error)),
    code: error?.code,
    route: context.route,
    method: context.method,
    ...(isProduction ? {} : { stack: redact(error?.stack || '') }),
  };
  console.error('[stratarix]', JSON.stringify(detail));
}

/** Log an informational event (no PII beyond an internal user id). */
export function logInfo(event, detail = {}) {
  console.log('[stratarix]', JSON.stringify({ at: new Date().toISOString(), event, ...detail }));
}
