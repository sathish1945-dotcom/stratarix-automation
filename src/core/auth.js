/**
 * Accounts, sessions and password hashing.
 *
 * Security notes
 * - Passwords are hashed with scrypt (N=32768, r=8, p=1) and a per-user random
 *   salt. The hash format is versioned so the cost can be raised later without
 *   locking anybody out.
 * - Session tokens are 32 random bytes; only their SHA-256 digest is stored, so
 *   a database leak does not hand over live sessions.
 * - The password of a non-existent account is still compared against a dummy
 *   hash so that response timing does not reveal which emails are registered.
 * - Registration creates the session immediately (no separate log-in step) and
 *   destroys any previous session cookie for the browser.
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { conflict, unauthorized, badRequest } from './errors.js';
import { assertEmail, assertName, assertPassword, normalizeEmail, text } from './validate.js';
import { safeTimezone } from './time.js';

const scrypt = promisify(scryptCallback);

export const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const SESSION_RENEW_WINDOW_MS = 24 * 60 * 60 * 1000;

/** scrypt cost parameters, kept in one place so they can be tuned. */
export const SCRYPT = { N: 32768, r: 8, p: 1, keyLength: 64, maxmem: 96 * 1024 * 1024 };

const dummySalt = randomBytes(16).toString('hex');

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function encodeHash(buffer, { N = SCRYPT.N, r = SCRYPT.r, p = SCRYPT.p } = {}) {
  return `scrypt$${N}$${r}$${p}$${buffer.toString('hex')}`;
}

/**
 * Verify a password against a stored record.
 * Supports the two shapes found in this project:
 *   - legacy:  salt column + raw hex hash column
 *   - current: versioned `scrypt$N$r$p$hash` string in password_hash
 */
export async function verifyPassword(password, row) {
  const stored = String(row?.password_hash || '');
  if (stored.startsWith('scrypt$')) {
    const [scheme, N, r, p, hash] = stored.split('$');
    if (scheme !== 'scrypt') return { valid: false };
    const expected = Buffer.from(hash, 'hex');
    const candidate = await scrypt(password, row.salt, expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
      maxmem: SCRYPT.maxmem,
    });
    return {
      valid: candidate.length === expected.length && timingSafeEqual(candidate, expected),
      needsUpgrade: Number(N) < SCRYPT.N,
    };
  }
  // Legacy rows: fixed cost, raw hex digest.
  const expected = Buffer.from(stored, 'hex');
  const candidate = await scrypt(password, row.salt, 64, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem });
  const valid = expected.length === candidate.length && timingSafeEqual(candidate, expected);
  return { valid, needsUpgrade: valid };
}

/** Constant-time-ish comparison for unknown accounts. */
export async function burnPasswordTime(password) {
  await scrypt(password, dummySalt, 64, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem });
  return false;
}

export function createAuthService({ db, config }) {
  const sessionDuration = config.sessionDuration ?? SESSION_DURATION_MS;
  const cookieName = config.cookieName;

  async function hashPassword(password) {
    const salt = randomBytes(16).toString('hex');
    const hash = await scrypt(password, salt, SCRYPT.keyLength, {
      N: SCRYPT.N,
      r: SCRYPT.r,
      p: SCRYPT.p,
      maxmem: SCRYPT.maxmem,
    });
    return { salt, passwordHash: encodeHash(hash), algo: `scrypt-${SCRYPT.N}-${SCRYPT.r}-${SCRYPT.p}` };
  }

  const publicUser = (row) =>
    row ? { id: Number(row.id), name: row.name, email: row.email, timezone: row.timezone || 'UTC' } : null;

  async function createSession(response, user, request) {
    const token = randomBytes(32).toString('hex');
    const userAgent = text(request?.headers?.['user-agent']).slice(0, 180);
    await db.run('INSERT INTO sessions (token_hash, user_id, expires_at, created_at, user_agent) VALUES (?, ?, ?, ?, ?)', [
      sha256(token),
      user.id,
      Date.now() + sessionDuration,
      Date.now(),
      userAgent,
    ]);
    response.setSessionCookie(cookieName, token, Math.floor(sessionDuration / 1000));
    return token;
  }

  async function destroyCurrentSession(token) {
    if (!token) return;
    await db.run('DELETE FROM sessions WHERE token_hash = ?', [sha256(token)]);
  }

  async function currentSession(request) {
    const token = request.cookies[cookieName] || request.cookies[`__Host-${cookieName}`];
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    const row = await db.get(
      `SELECT users.*, sessions.token_hash AS session_hash, sessions.expires_at AS session_expires
       FROM sessions JOIN users ON users.id = sessions.user_id
       WHERE sessions.token_hash = ? AND sessions.expires_at > ?`,
      [sha256(token), Date.now()],
    );
    if (!row) return null;
    // Sliding expiry: extend once per day of active use instead of on every request.
    if (Number(row.session_expires) - Date.now() < sessionDuration - SESSION_RENEW_WINDOW_MS) {
      await db.run('UPDATE sessions SET expires_at = ? WHERE token_hash = ?', [
        Date.now() + sessionDuration,
        row.session_hash,
      ]);
    }
    return { token, user: row };
  }

  return {
    publicUser,

    async register({ name, email, password, timezone }, request, response) {
      const cleanName = assertName(name);
      const cleanEmail = assertEmail(email);
      assertPassword(password);
      const zone = safeTimezone(timezone, 'UTC');

      const existing = await db.get('SELECT id FROM users WHERE email = ?', [cleanEmail]);
      if (existing) {
        throw conflict('An account with this email already exists. Try logging in instead.', 'email_taken');
      }

      const { salt, passwordHash, algo } = await hashPassword(password);
      let result;
      try {
        result = await db.run(
          `INSERT INTO users (name, email, salt, password_hash, created_at, password_algo, timezone, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [cleanName, cleanEmail, salt, passwordHash, Date.now(), algo, zone, Date.now()],
        );
      } catch (error) {
        // Unique constraint from a race between two registrations.
        if (error?.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint failed/i.test(String(error?.message))) {
          throw conflict('An account with this email already exists. Try logging in instead.', 'email_taken');
        }
        throw error;
      }

      const user = { id: Number(result.lastInsertRowid), name: cleanName, email: cleanEmail, timezone: zone };
      // Registration signs the user in straight away — no second log-in step.
      await destroyCurrentSession(request?.cookies?.[cookieName]);
      await createSession(response, user, request);
      return { user: publicUser(user), sessionCreated: true };
    },

    async login({ email, password, timezone }, request, response) {
      const cleanEmail = normalizeEmail(email);
      if (!cleanEmail || typeof password !== 'string' || !password) {
        throw badRequest('Enter your email address and password.', 'missing_credentials');
      }
      const row = await db.get('SELECT * FROM users WHERE email = ?', [cleanEmail]);
      if (!row) {
        await burnPasswordTime(password);
        throw unauthorized('The email or password is incorrect.', 'invalid_credentials');
      }
      const { valid, needsUpgrade } = await verifyPassword(password, row);
      if (!valid) throw unauthorized('The email or password is incorrect.', 'invalid_credentials');

      if (needsUpgrade) {
        const { salt, passwordHash, algo } = await hashPassword(password);
        await db.run('UPDATE users SET salt = ?, password_hash = ?, password_algo = ? WHERE id = ?', [
          salt,
          passwordHash,
          algo,
          row.id,
        ]);
      }
      if (timezone) {
        await db.run('UPDATE users SET timezone = ?, last_seen_at = ? WHERE id = ?', [
          safeTimezone(timezone, row.timezone || 'UTC'),
          Date.now(),
          row.id,
        ]);
      }

      await destroyCurrentSession(request?.cookies?.[cookieName]);
      await createSession(response, row, request);
      return { user: publicUser({ ...row, timezone: timezone || row.timezone }) };
    },

    async logout(request, response) {
      await destroyCurrentSession(request?.cookies?.[cookieName]);
      response.clearSessionCookie(cookieName);
      return { ok: true };
    },

    /**
     * Load the signed-in user, or throw. Also keeps the user's timezone in sync
     * so relative commands ("in 30 minutes", "every Monday") are correct.
     */
    async requireUser(request, { timezone } = {}) {
      const session = await currentSession(request);
      if (!session) throw unauthorized();
      const zone = safeTimezone(timezone, session.user.timezone || 'UTC');
      if (zone !== session.user.timezone) {
        await db.run('UPDATE users SET timezone = ?, last_seen_at = ? WHERE id = ?', [zone, Date.now(), session.user.id]);
        session.user.timezone = zone;
      }
      return session.user;
    },

    async optionalUser(request) {
      const session = await currentSession(request);
      return session?.user ?? null;
    },

    async updateProfile(userId, { name, timezone }) {
      const cleanName = assertName(name);
      const zone = timezone === undefined ? null : safeTimezone(timezone, 'UTC');
      if (zone) {
        await db.run('UPDATE users SET name = ?, timezone = ?, last_seen_at = ? WHERE id = ?', [
          cleanName,
          zone,
          Date.now(),
          userId,
        ]);
      } else {
        await db.run('UPDATE users SET name = ?, last_seen_at = ? WHERE id = ?', [cleanName, Date.now(), userId]);
      }
      const row = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
      return publicUser(row);
    },

    /** Change password: requires the current password, then rotates sessions. */
    async changePassword(userId, { currentPassword, newPassword }, request, response) {
      const row = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
      if (!row) throw unauthorized();
      const { valid } = await verifyPassword(String(currentPassword || ''), row);
      if (!valid) throw unauthorized('Your current password is incorrect.', 'invalid_credentials');
      assertPassword(newPassword, { field: 'New password' });
      const { salt, passwordHash, algo } = await hashPassword(newPassword);
      await db.run('UPDATE users SET salt = ?, password_hash = ?, password_algo = ? WHERE id = ?', [
        salt,
        passwordHash,
        algo,
        userId,
      ]);
      // Sign out every other session, then create a fresh one for this browser.
      await db.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
      await createSession(response, row, request);
      return { ok: true };
    },

    async pruneExpiredSessions() {
      await db.run('DELETE FROM sessions WHERE expires_at < ?', [Date.now()]);
    },
  };
}
