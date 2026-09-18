# Stratarix Automation

Automation services website and client account backend, prepared for **sathish1945-dotcom**.

Contact: **p.satish9988@gmail.com**

## Included

- Responsive overview, mobile navigation, and six clearly labelled example automation services.
- Login and registration pages with real account creation when the Node server runs.
- SQLite account persistence, scrypt password hashing, HttpOnly session cookies, session expiry, same-origin write protection, validation, and basic request throttling.
- Profile editing and logout. Light/dark, compact layout, and reduced-motion preferences are saved in the browser.
- Contact page with Gmail compose, email copying, and a prefilled project enquiry. Visitors send the email themselves; no email is sent automatically.
- GitHub Pages preview served from the main branch. Pages displays the interface and an explicit demo account; it cannot run the Node backend.

All service descriptions are temporary examples. No automation executes and no external services are connected. There are no fabricated clients, staff counts, testimonials, prices, or delivery promises.

## Run on Windows PowerShell

Install Node.js 24 or newer from the official Node.js website. Extract this project under **D:\sathishai\stratarix-automation**.

```powershell
Set-Location D:\sathishai\stratarix-automation
node --version
npm start
```

Open **http://localhost:3000**. No npm package installation is required. The database is created at `data/accounts.sqlite`; never commit it to GitHub. Register using the website, log out, and log back in. Data survives a server restart.

```powershell
npm test
```

## Publish the preview on GitHub Pages

Repository: https://github.com/sathish1945-dotcom/stratarix-automation

1. Sign in to GitHub as **sathish1945-dotcom** and create a public repository named `stratarix-automation`. Leave it empty (do not add a README).
2. In PowerShell, from the project folder, run:

```powershell
git init -b main
git add .
git commit -m "Create Stratarix automation client portal"
git remote add origin https://github.com/sathish1945-dotcom/stratarix-automation.git
git push -u origin main
```

3. Open the repository's **Settings → Pages**, choose **Deploy from a branch**, select **main** and **/(root)**, and save.
4. GitHub builds the preview and shows the live link in Pages settings. Run `npm test` locally before pushing updates.

If a repository with this name already exists, inspect it before pushing. Do not force-push over unrelated work.

## Run accounts on a hosted backend

GitHub stores this complete project; GitHub Pages serves static files only. To provide real accounts publicly, deploy the Node server and frontend together on a Node-compatible host with a persistent disk. Use a single server instance for this SQLite MVP.

Environment variables:

| Variable | Purpose |
|---|---|
| `NODE_ENV=production` | Enables Secure cookies and HSTS; requires an HTTPS origin. |
| `APP_ORIGIN` | Exact public HTTPS origin, without trailing slash. |
| `HOST=0.0.0.0` | Allows the hosting platform to reach the process. |
| `PORT` | Listening port; defaults to 3000. |
| `DATABASE_PATH` | Absolute path on persistent storage for the SQLite database. |

The server binds to localhost by default for local development. Put the production server behind the hosting platform's HTTPS proxy. Do not expose a development server with unencrypted account traffic. Do not put passwords, cookies, email credentials, or API keys in GitHub or frontend files.

## MVP limits

- Account email addresses are not verified. Password recovery and email verification are not included.
- No administrator panel, payments, live chat, project tracking, email delivery service, or workflow execution is included.
- Rate limiting is in-memory and per connection IP. It is a starter safeguard, not a distributed abuse prevention system. Do not trust arbitrary forwarded-IP headers.
- SQLite and the rate limiter target a small single-instance deployment. Plan a managed database and shared rate limiter before running multiple instances.
- Set a privacy/retention policy, backups, email verification/recovery, and operational monitoring before enrolling real clients. The current site is an MVP with temporary content.
- Google Fonts is loaded for typography, with system font fallbacks. No analytics or tracking scripts are included.

## Files

`index.html`, `style.css`, `app.js`, and `favicon.svg` contain the website. `server.mjs` serves only those allowlisted assets and the account API. `auth.test.mjs` verifies authentication and security boundaries. `.nojekyll` keeps the GitHub Pages preview static.

Reference: [GitHub Pages documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages), [Node.js SQLite API](https://nodejs.org/api/sqlite.html).
