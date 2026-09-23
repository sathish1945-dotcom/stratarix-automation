/**
 * Serverless entry point (Vercel).
 *
 * Every /api/* request is rewritten to this function (see vercel.json). Static
 * files are served from the build output by the platform, so this handler only
 * deals with the API.
 *
 * The database connection is cached on the module scope so warm invocations
 * reuse it instead of reconnecting on every request.
 */
import { openDatabase } from '../src/core/db/index.js';
import { createApp } from '../src/core/app.js';
import { createNodeHandler } from '../src/core/node-adapter.js';

let handlerPromise = null;

async function build() {
  const db = await openDatabase({ env: process.env });
  const app = createApp({ db, env: process.env });
  return createNodeHandler(app);
}

export default async function handler(req, res) {
  if (!handlerPromise) handlerPromise = build();
  try {
    const nodeHandler = await handlerPromise;
    return await nodeHandler(req, res);
  } catch (error) {
    // A failed boot (for example a bad database URL) must not leak details.
    console.error('[stratarix] function boot failed', { message: error?.message, code: error?.code });
    handlerPromise = null;
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(
      JSON.stringify({
        error: 'The service could not start. Please try again in a moment.',
        code: 'boot_failed',
      }),
    );
  }
}
