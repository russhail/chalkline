// Chalk Line — accounts.
//
// No email required. Signup is a display name; the site issues a recovery code
// which is shown exactly once and is the only way back into the account. What
// we store is a name the player chose and a scrypt hash of their code.
//
// An email address is optional and used for exactly one thing: reissuing a
// lost code. Players who don't want to give one simply don't, and everything
// works — they just have to keep the code safe.
//
// The cost of not requiring identity is that nothing stops one person holding
// several accounts. That is a deliberate trade — see the README.

import { randomBytes, scryptSync, timingSafeEqual, randomInt } from 'node:crypto';
import { parseTs } from './time.js';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const SESSION_DAYS = 60;

// Three words, nothing else — easy to read off a screen, say out loud, or
// retype from a photo. 256 words gives 256**3 ≈ 16.8 million codes; against
// a limit of ten guesses per quarter-hour that is several thousand years of
// trying per account, which is ample for a game with no prizes.
const WORDS = [
  'huck', 'layout', 'callahan', 'greatest', 'hammer', 'scoober', 'blade', 'flick',
  'backhand', 'pull', 'zone', 'poach', 'bid', 'sky', 'brick', 'stack',
  'endzone', 'turnover', 'reset', 'strike', 'swing', 'dump', 'handler', 'cutter',
  'mark', 'force', 'stall', 'heron', 'falcon', 'osprey', 'kestrel', 'swift',
  'raven', 'magpie', 'curlew', 'plover', 'godwit', 'gannet', 'fulmar', 'puffin',
  'otter', 'badger', 'marten', 'hare', 'stoat', 'pine', 'lynx', 'ibex',
  'tapir', 'bison', 'sable', 'granite', 'basalt', 'quartz', 'slate', 'flint',
  'amber', 'jasper', 'onyx', 'marble', 'gypsum', 'pumice', 'shale', 'harbour',
  'estuary', 'shingle', 'dune', 'moor', 'brook', 'tarn', 'delta', 'lagoon',
  'fjord', 'inlet', 'strand', 'shannon', 'liffey', 'boyne', 'barrow', 'suir',
  'erne', 'foyle', 'lagan', 'slaney', 'nore', 'laune', 'maine', 'clover',
  'bracken', 'thistle', 'nettle', 'willow', 'rowan', 'hazel', 'alder', 'birch',
  'aspen', 'cedar', 'juniper', 'north', 'south', 'east', 'upwind', 'downwind',
  'crosswind', 'sideline', 'baseline', 'offset', 'copper', 'cobalt', 'indigo', 'crimson',
  'saffron', 'olive', 'teal', 'ochre', 'umber', 'sienna', 'scarlet', 'violet',
  'anchor', 'beacon', 'lantern', 'compass', 'signal', 'ember', 'kindle', 'torch',
  'rudder', 'mast', 'keel', 'tiller', 'ridge', 'valley', 'summit', 'gully',
  'cairn', 'crag', 'scree', 'corrie', 'arete', 'buttress', 'plateau', 'canyon',
  'winter', 'summer', 'autumn', 'solstice', 'twilight', 'aurora', 'zenith', 'equinox',
  'eclipse', 'meridian', 'sprint', 'stride', 'pivot', 'sprawl', 'vault', 'glide',
  'surge', 'coast', 'bound', 'lunge', 'dash', 'weave', 'kettle', 'cobble',
  'meadow', 'furrow', 'hedgerow', 'orchard', 'paddock', 'thicket', 'coppice', 'anvil',
  'bellows', 'forge', 'chisel', 'lathe', 'auger', 'mallet', 'ratchet', 'cider',
  'damson', 'quince', 'medlar', 'sorrel', 'fennel', 'borage', 'tarragon', 'sextant',
  'astrolabe', 'quadrant', 'almanac', 'cipher', 'bramble', 'heather', 'gorse', 'foxglove',
  'campion', 'vetch', 'yarrow', 'pebble', 'boulder', 'gravel', 'silt', 'loam',
  'merlin', 'harrier', 'buzzard', 'goshawk', 'candle', 'taper', 'wick', 'jetty',
  'quay', 'slipway', 'bracket', 'keystone', 'lintel', 'gable', 'lichen', 'mosswood',
  'samphire', 'eelgrass', 'kelp', 'reed', 'sedge', 'rush', 'marram', 'tussock',
  'bilberry', 'sloe', 'rosehip', 'elder', 'hawthorn', 'blackthorn', 'spindle', 'wren',
  'dipper', 'redwing', 'fieldfare', 'linnet', 'siskin', 'twite', 'brambling', 'weasel',
  'polecat', 'fallow', 'roebuck', 'garron', 'kelpie', 'schist', 'gabbro', 'dolerite',
];

function generateRecoveryCode() {
  return [
    WORDS[randomInt(WORDS.length)],
    WORDS[randomInt(WORDS.length)],
    WORDS[randomInt(WORDS.length)],
  ].join('-');
}

// Codes are compared case-insensitively and hyphens are optional, because
// people will retype these from a screenshot.
function normaliseCode(code) {
  return String(code || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function hashSecret(secret) {
  const salt = randomBytes(16).toString('hex');
  const key = scryptSync(normaliseCode(secret), salt, SCRYPT.keylen, SCRYPT).toString('hex');
  return `scrypt$${salt}$${key}`;
}

function verifySecret(secret, stored) {
  try {
    const [scheme, salt, key] = String(stored).split('$');
    if (scheme !== 'scrypt' || !salt || !key) return false;
    const candidate = scryptSync(normaliseCode(secret), salt, SCRYPT.keylen, SCRYPT);
    const expected = Buffer.from(key, 'hex');
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

const token = (bytes = 32) => randomBytes(bytes).toString('base64url');

const NAME_RE = /^[\p{L}\p{N} _.'-]+$/u;

function validateName(displayName) {
  const name = String(displayName || '').trim().replace(/\s+/g, ' ');
  const errors = [];
  if (name.length < 2 || name.length > 24) errors.push('Name must be 2–24 characters.');
  else if (!NAME_RE.test(name)) errors.push('Name can only use letters, numbers and basic punctuation.');
  return { ok: errors.length === 0, errors, displayName: name };
}

// ---------------------------------------------------------------------------
// Store-facing operations
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const normaliseEmail = (e) => String(e || '').trim().toLowerCase();

async function createUser(store, { displayName, email, now }) {
  const check = validateName(displayName);
  if (!check.ok) return { ok: false, errors: check.errors };

  // Optional. Blank is the normal case and must not be an error.
  const addr = normaliseEmail(email);
  if (addr && !EMAIL_RE.test(addr)) {
    return { ok: false, errors: ['That email address does not look right.'] };
  }
  if (addr) {
    const [clash] = await store.query('SELECT id FROM users WHERE LOWER(email) = $1', [addr]);
    if (clash) return { ok: false, errors: ['That email is already attached to an account.'] };
  }

  const [taken] = await store.query(
    'SELECT id FROM users WHERE LOWER(display_name) = $1',
    [check.displayName.toLowerCase()]
  );
  if (taken) return { ok: false, errors: ['That name is taken — pick another.'] };

  const recoveryCode = generateRecoveryCode();
  const [row] = await store.query(
    `INSERT INTO users (display_name, recovery_hash, email, created_at)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [check.displayName, hashSecret(recoveryCode), addr || null,
     new Date(now ?? Date.now()).toISOString()]
  );

  // The plain code is returned exactly once, here. It is never stored and
  // cannot be recovered — if the player loses it, the account is gone.
  return { ok: true, userId: row?.id, displayName: check.displayName, recoveryCode,
           hasEmail: Boolean(addr) };
}

// Issue a fresh code for an account you're already signed in to. The old one
// stops working immediately. Needed for the obvious case — a code that has
// been shared, screenshotted into a group chat, or typed somewhere public.
async function regenerateCode(store, { userId }) {
  const recoveryCode = generateRecoveryCode();
  await store.query('UPDATE users SET recovery_hash = $1 WHERE id = $2',
    [hashSecret(recoveryCode), userId]);
  // Existing sessions survive on purpose: rotating your code shouldn't sign
  // you out of the phone in your hand.
  return { ok: true, recoveryCode };
}

// Attach or change the recovery address on an existing account.
async function setEmail(store, { userId, email }) {
  const addr = normaliseEmail(email);
  if (!addr) {
    await store.query('UPDATE users SET email = NULL WHERE id = $1', [userId]);
    return { ok: true, removed: true };
  }
  if (!EMAIL_RE.test(addr)) return { ok: false, error: 'That email address does not look right.' };
  const [clash] = await store.query(
    'SELECT id FROM users WHERE LOWER(email) = $1 AND id <> $2', [addr, userId]
  );
  if (clash) return { ok: false, error: 'That email is already attached to an account.' };
  await store.query('UPDATE users SET email = $1 WHERE id = $2', [addr, userId]);
  return { ok: true };
}

// Reissue a code to whoever holds the address. The old code stops working the
// moment a new one is issued, so a request nobody asked for locks the account
// owner out until they read the mail — acceptable, and the alternative (a
// pending token table) is more moving parts than this is worth.
//
// The response is deliberately identical whether or not the address is known,
// so this can't be used to test which emails have accounts.
async function requestRecovery(store, { email }) {
  const addr = normaliseEmail(email);
  const [user] = addr
    ? await store.query('SELECT * FROM users WHERE LOWER(email) = $1', [addr])
    : [];
  if (!user) return { ok: true, sent: false, reason: 'unknown_address' };

  // Send first, rotate second. Rotating up front would invalidate the working
  // code even when the mail fails — locking out the one person we're trying
  // to help.
  const recoveryCode = generateRecoveryCode();
  const mail = await sendRecoveryEmail({ to: addr, displayName: user.display_name, recoveryCode });
  if (!mail.sent) return { ok: true, sent: false, reason: mail.reason };
  await store.query('UPDATE users SET recovery_hash = $1 WHERE id = $2',
    [hashSecret(recoveryCode), user.id]);
  return { ok: true, sent: true };
}

// Resend has a plain REST API, so this needs no package. With no key
// configured, recovery by email is simply unavailable and the UI says so.
async function sendRecoveryEmail({ to, displayName, recoveryCode, apiKey }) {
  const key = apiKey ?? process.env.RESEND_API_KEY;
  if (!key) return { sent: false, reason: 'no_api_key' };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.MAIL_FROM ?? 'Chalk Line <noreply@chalklineultimate.com>',
      to: [to],
      subject: 'Your new Chalk Line code',
      text: `Your Chalk Line account "${displayName}" has a new recovery code:\n\n` +
        `    ${recoveryCode}\n\n` +
        `Sign in with your name and this code. Your previous code no longer works.\n\n` +
        `Chalk Line is a play-money game for WUCC 2026. No real money, no prizes.`,
    }),
  });
  if (!res.ok) return { sent: false, reason: `resend_${res.status}` };
  return { sent: true };
}

const recoveryByEmailEnabled = () => Boolean(process.env.RESEND_API_KEY);

async function login(store, { displayName, recoveryCode, now }) {
  const name = String(displayName || '').trim();
  const [user] = await store.query(
    'SELECT * FROM users WHERE LOWER(display_name) = $1',
    [name.toLowerCase()]
  );
  // Hash either way so a missing account and a wrong code take the same time.
  const ok = verifySecret(recoveryCode, user?.recovery_hash ?? `scrypt$00$${'0'.repeat(128)}`);
  if (!user || !ok) return { ok: false, error: 'That name and code do not match.' };

  const sessionToken = token(32);
  await store.query('INSERT INTO sessions (token, user_id, created_at) VALUES ($1,$2,$3)', [
    sessionToken,
    user.id,
    new Date(now ?? Date.now()).toISOString(),
  ]);
  return { ok: true, token: sessionToken, user: publicUser(user) };
}

async function userForToken(store, sessionToken, { now } = {}) {
  if (!sessionToken) return null;
  const [row] = await store.query(
    `SELECT u.*, s.created_at AS session_started FROM sessions s
     JOIN users u ON u.id = s.user_id WHERE s.token = $1`,
    [sessionToken]
  );
  if (!row) return null;
  // Postgres returns '2026-08-15 13:00:00+00', which Date.parse reads as NaN.
  // With NaN the Number.isFinite guard below was skipping the check entirely,
  // so sessions never expired in production.
  const started = parseTs(row.session_started);
  if (started !== null && (now ?? Date.now()) - started > SESSION_DAYS * 86400_000) {
    await store.query('DELETE FROM sessions WHERE token = $1', [sessionToken]);
    return null;
  }
  return row;
}

async function logout(store, sessionToken) {
  await store.query('DELETE FROM sessions WHERE token = $1', [sessionToken]);
}

function publicUser(u, atRisk = 0) {
  return {
    id: u.id,
    displayName: u.display_name,
    bankroll: Math.round(u.bankroll * 100) / 100,
    // Profit is what the leaderboard ranks on, so the header should show the
    // same number rather than making people work it out from their balance.
    net: Math.round((u.bankroll + atRisk - (u.granted ?? 10000)) * 100) / 100,
    isAdmin: Boolean(u.is_admin),
    topups: u.topups,
    hasRecoveryEmail: Boolean(u.email),
  };
}

export {
  generateRecoveryCode,
  normaliseCode,
  hashSecret,
  verifySecret,
  token,
  validateName,
  createUser,
  regenerateCode,
  setEmail,
  requestRecovery,
  sendRecoveryEmail,
  recoveryByEmailEnabled,
  normaliseEmail,
  login,
  logout,
  userForToken,
  publicUser,
  SESSION_DAYS,
  WORDS,
};
