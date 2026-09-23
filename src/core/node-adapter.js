/**
 * Bridges Node's http request/response objects to the Web Request/Response
 * interfaces used by the API router.
 *
 * Two callers rely on this:
 *  - the local/dev Node server (server.mjs)
 *  - the serverless function (api/index.js), where the platform may have already
 *    parsed the JSON body into `req.body`
 */

export function nodeRequestToWebRequest(req, { origin } = {}) {
  const host = req.headers.host || 'localhost';
  const base = origin || `http://${host}`;
  const url = new URL(req.url || '/', base);

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined || value === null) continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : String(value));
  }

  const method = (req.method || 'GET').toUpperCase();
  const init = { method, headers };

  if (method !== 'GET' && method !== 'HEAD') {
    if (req.body !== undefined && req.body !== null) {
      // Already parsed by the platform (Vercel does this for JSON bodies).
      const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');
      // The original content-length no longer matches after re-serialisation.
      headers.delete('content-length');
      init.body = body;
    } else if (!req.readableEnded) {
      init.body = req;
      init.duplex = 'half';
    }
  }

  return new Request(url, init);
}

export async function sendWebResponse(res, response) {
  res.statusCode = response.status;
  const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  for (const [key, value] of response.headers.entries()) {
    if (key.toLowerCase() === 'set-cookie') continue;
    res.setHeader(key, value);
  }
  if (cookies.length) res.setHeader('set-cookie', cookies);
  if (response.status === 204 || response.status === 304) return res.end();
  const buffer = Buffer.from(await response.arrayBuffer());
  res.setHeader('Content-Length', String(buffer.length));
  return res.end(buffer);
}

/** Build a Vercel-style handler from an app instance (also used by tests). */
export function createNodeHandler(app) {
  return async function handler(req, res) {
    try {
      const request = nodeRequestToWebRequest(req, { origin: process.env.APP_ORIGIN || undefined });
      const response = await app.handle(request);
      await sendWebResponse(res, response);
    } catch {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
      }
      res.end(JSON.stringify({ error: 'Something went wrong. Please try again.', code: 'server_error' }));
    }
  };
}
