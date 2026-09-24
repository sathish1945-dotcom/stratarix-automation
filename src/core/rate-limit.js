/**
 * Small in-memory sliding-window rate limiter.
 *
 * Scope: protects a single instance (and, importantly, protects the AI quota).
 * On a multi-instance deployment this is a first line of defence only; a shared
 * store (for example Redis) would be required for hard guarantees. Documented in
 * the README rather than silently assumed.
 */
import { tooManyRequests } from './errors.js';

export function createRateLimiter({ limit, windowMs, name = 'requests' }) {
  const buckets = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }, Math.max(windowMs, 30_000));
  timer.unref?.();

  return {
    name,
    /**
     * @param {string} key
     * @param {number} [cost]
     * @param {string} [message]
     */
    hit(key, cost = 1, message) {
      const now = Date.now();
      let bucket = buckets.get(key);
      if (!bucket || bucket.resetAt <= now) {
        bucket = { count: 0, resetAt: now + windowMs };
        buckets.set(key, bucket);
      }
      bucket.count += cost;
      if (bucket.count > limit) {
        const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
        throw tooManyRequests(
          message || `Too many ${name}. Please wait ${retryAfter} seconds and try again.`,
          retryAfter,
        );
      }
      return { remaining: Math.max(0, limit - bucket.count), resetAt: bucket.resetAt };
    },
    peek(key) {
      const bucket = buckets.get(key);
      return bucket ? { count: bucket.count, resetAt: bucket.resetAt } : null;
    },
    reset(key) {
      if (key === undefined) buckets.clear();
      else buckets.delete(key);
    },
    stop() {
      clearInterval(timer);
    },
  };
}
