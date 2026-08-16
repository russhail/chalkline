// Chalk Line — rate limiting.
//
// Counters live in the database, not in memory: serverless instances don't
// share state, so an in-process counter would reset on every cold start and
// limit nothing. Fixed windows rather than a sliding log — cruder, but one row
// and one statement per check, which is what we want on a per-request path.
//
// Timestamps are stored as ISO text so the same lexicographic comparison works
// on both backends.

import { parseTs } from './time.js';

const WINDOW = {
  SIGNUP: { limit: 5, windowMs: 60 * 60 * 1000 },      // 5 accounts per hour per address
  LOGIN: { limit: 10, windowMs: 15 * 60 * 1000 },      // 10 failed attempts per name
  RECOVER: { limit: 3, windowMs: 60 * 60 * 1000 },     // 3 recovery mails per address
  BET: { limit: 120, windowMs: 60 * 1000 },            // generous; catches runaway scripts
};

// The caller's address, as Vercel presents it. Everything here is attacker-
// controlled except the leftmost hop Vercel itself appends, so this is a
// speed bump, not an identity — which is all a rate limit ever is.
function clientKey(headers = {}) {
  const fwd = headers['x-forwarded-for'] || headers['X-Forwarded-For'] || '';
  const first = String(fwd).split(',')[0].trim();
  return first || headers['x-real-ip'] || 'unknown';
}

async function hit(store, bucket, { limit, windowMs }, now = Date.now()) {
  // window_start is stored as text, but read it through the same parser as
  // every other timestamp so a schema change can't quietly break the limiter.
  const startedAt = new Date(now).toISOString();
  const cutoff = new Date(now - windowMs).toISOString();

  const rows = await store.query(
    `INSERT INTO rate_limits (bucket, hits, window_start) VALUES ($1, 1, $2)
     ON CONFLICT (bucket) DO UPDATE SET
       hits = CASE WHEN rate_limits.window_start < $3 THEN 1 ELSE rate_limits.hits + 1 END,
       window_start = CASE WHEN rate_limits.window_start < $3 THEN $2
                           ELSE rate_limits.window_start END
     RETURNING hits, window_start`,
    [bucket, startedAt, cutoff]
  );

  const hits = Number(rows[0]?.hits ?? 1);
  const windowStart = parseTs(rows[0]?.window_start) ?? now;
  const retryAfter = Math.max(0, Math.ceil((windowStart + windowMs - now) / 1000));
  return { allowed: hits <= limit, hits, limit, retryAfter };
}

// A successful login clears the failure counter, so someone who fat-fingers
// their code a few times isn't locked out once they get it right.
async function clear(store, bucket) {
  await store.query('DELETE FROM rate_limits WHERE bucket = $1', [bucket]);
}

export { hit, clear, clientKey, WINDOW };
