# AI Life Manager — Stratarix Automation

A chat-first personal task manager. You tell the assistant what to remember in
plain language ("Remind me to submit my assignment tomorrow at 8 PM") and it
creates the task with the right date, time, repeat rule and priority. It also
keeps the Stratarix automation pages, accounts and the Node backend in the same
project.

Contact: **p.satish9988@gmail.com**

## What is in the box

- **Chat-first tasks.** Natural-language messages are interpreted by Gemini on
  the server (`/api/chat`); the interpreted task is shown while it is saved, and
  manual creation/editing stays available in the task dialog.
- **Real AI on the server only.** The API key lives in an environment variable
  and is never sent to the browser. Timeouts, rate limits, invalid model output
  and outages all degrade to a friendly message plus a deterministic built-in
  parser, so a reminder is never lost silently.
- **Dashboard and task list.** Today, upcoming, overdue and completed are always
  one click apart, with create, edit, reschedule, complete/reopen and delete.
- **Reminders.** While a tab is open the app asks the server which tasks are due
  and raises a real browser notification with the task title; clicking it focuses
  the app on the task list. Permission is explained, requested once from a button,
  and never re-requested after a refusal.
- **Accounts.** Registration signs you in immediately, sessions are HttpOnly
  cookies with server-side records, logout deletes the session server-side, and
  every task query is scoped to the signed-in user.
- **Design system.** One palette, one type scale and one set of components across
  every screen, light/dark themes, reduced-motion and compact modes, responsive
  from small phones to wide desktops, and an installable PWA manifest with an
  offline page.

## Run it locally

Node.js 24 or newer.

```bash
npm install          # only needed for the test suite (jsdom)
npm start            # http://localhost:3000
```

The database defaults to an in-memory store; set `DATABASE_PATH=./data/app.sqlite`
to keep accounts and tasks across restarts. Copy `.env.example` for the full list.

```bash
npm test             # every suite (unit, API, security, server, UI)
npm run test:ui      # jsdom end-to-end flows through the real frontend
```

## Environment variables

| Variable | Purpose |
|---|---|
| `GEMINI_API_KEY` | Server-side Gemini key. Without it the app still works using the built-in parser and says so in the interface. |
| `GEMINI_MODEL` | Model name; defaults to `gemini-3.5-flash`. |
| `GEMINI_TIMEOUT_MS` / `GEMINI_MAX_RETRIES` | Provider timeout (15000) and retry count (2). |
| `AI_OFFLINE_FALLBACK` | `false` disables the deterministic parser fallback. |
| `DATABASE_PATH` | SQLite file for the local Node server. |
| `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` | libSQL over HTTP — use this on serverless hosting, where the filesystem is read-only. |
| `NODE_ENV=production` | Secure cookie names/flags, HSTS. |
| `APP_ORIGIN` | Exact public HTTPS origin, no trailing slash. |
| `SESSION_TTL_MS` | Session lifetime in milliseconds (default 7 days). |
| `TRUST_PROXY=true` | Only when a trusted proxy sets `X-Forwarded-For`. |
| `HOST` / `PORT` | Bind address and port (default `127.0.0.1:3000`). |

Secrets belong in your host's environment settings, never in the repository.
`.env` is git-ignored and `.env.example` documents every name.

## Deploy on Vercel

1. Import the repository `sathish1945-dotcom/stratarix-automation` into Vercel
   (Framework preset: **Other**). `vercel.json` runs the build, serves `dist/`
   for static files and routes `/api/*` to the serverless function in `api/`.
2. Add the environment variables above in **Project → Settings → Environment
   Variables** (Production and Preview). At minimum: `GEMINI_API_KEY` and either
   the two Turso values or nothing at all to run on the in-memory database.
3. Redeploy so the new variables are picked up.
4. Open the deployment, register an account and try "Remind me to call Arun in 30
   minutes" — the reply should be tagged **Gemini AI**.

Alternatively, host it anywhere Node 24 runs (`npm start`); the server serves the
frontend and the API from one origin.

## Honest notes

- **Notifications** fire while the site is open in a tab. Delivery when the
  browser or phone is completely closed needs Web Push (VAPID keys, a scheduler
  and a stored subscription); that infrastructure is scaffolded but **not
  active**, and `/api/push/config` reports `enabled: false` until it exists. The
  interface never claims otherwise.
- **Sessions** live in the database. Without `DATABASE_PATH` or Turso, an
  in-memory database means a server restart signs everyone out.
- **Rate limits** are per instance and in memory: auth 20/min/IP, writes
  90/min/IP+path, chat 20/min and 300/day per user, reads 300/min.
- Email addresses are not verified and there is no password recovery yet.

## Security

- The Gemini key is read from the environment on the server; no key appears in
  the frontend, in tests, or anywhere in the Git history.
- Password hashing is scrypt with a per-user salt; older raw-hex hashes are
  upgraded on the next successful sign-in.
- Writes require a same-origin request plus the `X-Stratarix-Request` header;
  cross-site submissions are rejected.
- The static server exposes an explicit allowlist of public files (HTML, CSS, the
  `js/` and `icons/` trees, the service worker, the manifest, the offline page and
  `robots.txt`). Source, data files and configuration are never served.
- Responses carry CSP, HSTS (in production), `nosniff`, `Referrer-Policy`,
  `X-Frame-Options: DENY` and a Permissions-Policy; API responses are `no-store`;
  errors are mapped to safe messages and never leak driver or upstream text.

## Layout

| Path | Purpose |
|---|---|
| `index.html`, `styles.css`, `js/` | The application shell, the design system and the view modules. |
| `sw.js`, `manifest.webmanifest`, `offline.html`, `icons/` | PWA: offline shell, install metadata and icons. |
| `server.mjs` | Node server: static allowlist + API, used by `npm start` and the server tests. |
| `api/index.js` | Serverless entry point for Vercel. |
| `src/core/` | Router, auth, tasks, chat, Gemini client, NLP parser, time rules, validation, database drivers. |
| `tests/` | Unit, API, chat, security, libSQL, server (over a real socket) and jsdom UI suites. |
| `tools/build-vercel.mjs` | Copies the static allowlist into `dist/` for Vercel. |
