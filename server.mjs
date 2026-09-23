/**
 * Production-style Node server.
 *
 * Serves the static frontend (with security headers) and the API from the same
 * origin, using the shared router in src/core. Run with `npm start`.
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './src/core/db/index.js';
import { createApp, APP_VERSION } from './src/core/app.js';
import { createNodeHandler } from './src/core/node-adapter.js';

const root = dirname(fileURLToPath(import.meta.url));
const publicRoot = resolve(root);
const isProduction = () => process.env.NODE_ENV === 'production';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/** Only these paths are ever served; everything else is a 404. */
const PUBLIC_FILES = new Set([
  'index.html',
  'styles.css',
  'sw.js',
  'manifest.webmanifest',
  'favicon.svg',
  'offline.html',
  'robots.txt',
]);

const PUBLIC_DIRECTORIES = ['js/', 'icons/'];

export function securityHeaders({ html = false } = {}) {
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), geolocation=(), microphone=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "manifest-src 'self'",
      "worker-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; '),
  };
  if (isProduction()) headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  void html;
  return headers;
}

function isPublicPath(pathname) {
  const clean = pathname.replace(/^\/+/, '');
  if (PUBLIC_FILES.has(clean)) return true;
  return PUBLIC_DIRECTORIES.some((prefix) => clean.startsWith(prefix) && CONTENT_TYPES[extname(clean)]);
}

let etagCache = new Map();

export function createStaticHandler({ directory = publicRoot, cache = true } = {}) {
  return async function staticHandler(request) {
    const url = new URL(request.url);
    const pathname = decodeURIComponent(url.pathname);
    const requested = pathname === '/' ? '/index.html' : pathname;
    if (!isPublicPath(requested)) {
      return new Response(JSON.stringify({ error: 'Page not found.', code: 'not_found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }

    const target = normalize(join(directory, requested));
    if (!target.startsWith(directory + sep) && target !== directory) {
      return new Response('Not found', { status: 404 });
    }
    if (!existsSync(target) || !statSync(target).isFile()) {
      return new Response(JSON.stringify({ error: 'Page not found.', code: 'not_found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }

    const stats = statSync(target);
    const type = CONTENT_TYPES[extname(target)] || 'application/octet-stream';
    const isHtml = type.startsWith('text/html');
    const cacheKey = `${target}:${stats.mtimeMs}:${stats.size}`;
    let etag = cache ? etagCache.get(target) : null;
    if (!etag || etag.key !== cacheKey) {
      etag = { key: cacheKey, value: `W/"${createHash('sha1').update(cacheKey).digest('hex').slice(0, 20)}"` };
      if (cache) {
        if (etagCache.size > 200) etagCache = new Map();
        etagCache.set(target, etag);
      }
    }

    const headers = {
      ...securityHeaders({ html: isHtml }),
      'Content-Type': type,
      ETag: etag.value,
      // The service worker handles offline caching; keep HTML fresh so updates land.
      'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=3600, must-revalidate',
      ...(isHtml ? { 'X-Robots-Tag': 'noindex' } : {}),
    };

    if (request.headers.get('if-none-match') === etag.value) {
      return new Response(null, { status: 304, headers });
    }

    if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
    const body = await readFile(target);
    return new Response(body, { status: 200, headers });
  };
}

/**
 * Build a listening-ready HTTP server for the app.
 *
 * Used by `start()` and by the socket-level test suite, so the tests exercise
 * exactly the same wiring as production.
 */
export async function makeServer({ env = process.env, databasePath, directory = publicRoot } = {}) {
  const effectiveEnv = databasePath ? { ...env, DATABASE_PATH: databasePath } : env;
  const db = await openDatabase({ env: effectiveEnv });
  const app = createApp({ db, env: effectiveEnv, staticHandler: createStaticHandler({ directory }) });
  const server = createServer(createNodeHandler(app));

  server.requestTimeout = 20_000;
  server.headersTimeout = 12_000;
  server.keepAliveTimeout = 10_000;
  server.stratarix = { app, db };
  return server;
}

async function start() {
  const server = await makeServer();
  const { app, db } = server.stratarix;

  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';

  server.listen(port, host, () => {
    const driver = db.kind || 'unknown';
    console.log(`Stratarix AI Life Manager v${APP_VERSION}`);
    console.log(`  listening   http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
    console.log(`  database    ${driver}${db.persistent ? '' : ' (ephemeral — set DATABASE_PATH to persist)'}`);
    console.log(`  ai          ${app.ai.configured ? `gemini (${app.ai.model})` : 'not configured (offline parser fallback)'}`);
    console.log(`  mode        ${isProduction() ? 'production' : 'development'}`);
  });

  const shutdown = async (signal) => {
    console.log(`\nReceived ${signal}, shutting down…`);
    app.stop();
    server.closeAllConnections?.();
    await new Promise((resolveClose) => server.close(resolveClose));
    await db.close?.();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start().catch((error) => {
    console.error('[stratarix] failed to start:', error?.message);
    process.exit(1);
  });
}

export { start, isPublicPath };
export default { makeServer, start, securityHeaders, createStaticHandler, isPublicPath };
