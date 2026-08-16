import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../lib/store.js';
import { handle, parseCookies, COOKIE } from '../lib/router.js';
import { sync } from '../lib/sync.js';
import * as auth from '../lib/auth.js';
import { placeBet } from '../lib/betting.js';

const NOW = Date.parse('2026-08-16T10:00:00Z');
let store;

const TEAMS = [
  { id: 1131, name: 'Colony', abbreviation: 'COL', division: 'Open', country: 'Australia', seed: 1 },
  { id: 1109, name: 'Aethers', abbreviation: 'AEW', division: 'Open', country: 'Poland', seed: 44 },
];
const GAMES = [{
  id: 1, homeTeamId: 1131, awayTeamId: 1109, homeLabel: null, awayLabel: null,
  division: 'Open', poolName: 'Pool A', startsAt: '2026-08-16T14:00:00Z',
  status: 'scheduled', homeScore: null, awayScore: null, valid: true,
}];

const call = (method, url, { body, cookie, now = NOW, autoSync = false, ip = '10.0.0.1' } = {}) =>
  handle({ method, url, body,
           headers: { ...(cookie ? { cookie } : {}), 'x-forwarded-for': ip } },
         { store, now, autoSync });

const cookieFrom = (res) => {
  const raw = res.headers?.['Set-Cookie'];
  return raw ? `${COOKIE}=${parseCookies(raw.split(';')[0])[COOKIE]}` : null;
};

beforeEach(async () => {
  store = createStore({ backend: 'sqlite' });
  await store.migrate();
  await sync(store, {
    force: true,
    fetcher: async () => ({
      heartbeat: { cacheVersion: 'v1' }, teams: TEAMS,
      fieldSizes: { Open: 48 }, games: GAMES,
    }),
  });
});

// There is no signup endpoint any more, so accounts are made straight through
// lib/auth.js. Everything behind a session still has to be exercised, and the
// honest way to reach that state now is the way the site itself would: create
// the row, then sign in through the route that still exists.
async function account(displayName = 'Russ', email) {
  const made = await auth.createUser(store, { displayName, email, now: NOW });
  assert.ok(made.ok, `fixture account "${displayName}": ${made.errors?.join(' ')}`);
  const res = await call('POST', '/api/login',
    { body: { displayName, recoveryCode: made.recoveryCode } });
  return { res, userId: made.userId, code: made.recoveryCode, cookie: cookieFrom(res) };
}

test('signing in takes the name and code, and tolerates retyping', async () => {
  const { code } = await account();
  await call('POST', '/api/logout');
  for (const variant of [code, code.toUpperCase(), code.replace(/-/g, ' '), code.replace(/-/g, '')]) {
    const res = await call('POST', '/api/login', { body: { displayName: 'russ', recoveryCode: variant } });
    assert.equal(res.status, 200, `should accept "${variant}"`);
  }
});

test('a wrong code is refused', async () => {
  await account();
  const res = await call('POST', '/api/login',
    { body: { displayName: 'Russ', recoveryCode: 'huck-huck-huck' } });
  assert.equal(res.status, 401);
  assert.match(res.body.error, /do not match/);
});

test('the recovery code is never stored in a readable form', async () => {
  const { code, cookie } = await account();
  const [u] = await store.query('SELECT recovery_hash FROM users WHERE display_name = $1', ['Russ']);
  assert.ok(!u.recovery_hash.includes(code), 'the plain code must not be in the database');
  assert.match(u.recovery_hash, /^scrypt\$/);

  // Rotation is the only route that still issues a code, so it has to store it
  // the same way — a second issuing path is exactly where a plaintext write
  // would go unnoticed.
  const rotated = await call('POST', '/api/regenerate-code', { cookie });
  const [after] = await store.query('SELECT recovery_hash FROM users WHERE display_name = $1', ['Russ']);
  assert.ok(!after.recovery_hash.includes(rotated.body.recoveryCode));
  assert.match(after.recovery_hash, /^scrypt\$/);
});

test('an account can carry a recovery address, and one can be attached later', async () => {
  const withEmail = await account('Nell', 'nell@example.com');
  const me = await call('GET', '/api/me', { cookie: withEmail.cookie });
  assert.equal(me.body.user.hasRecoveryEmail, true);

  const { cookie } = await account('Sam');
  assert.equal((await call('GET', '/api/me', { cookie })).body.user.hasRecoveryEmail, false);
  const set = await call('POST', '/api/email', { body: { email: 'sam@example.com' }, cookie });
  assert.equal(set.status, 200);
  const after = await call('GET', '/api/me', { cookie });
  assert.equal(after.body.user.hasRecoveryEmail, true);
});

test('one email cannot cover two accounts', async () => {
  await account('Nell', 'nell@example.com');
  const { cookie } = await account('Other');
  const clash = await call('POST', '/api/email',
    { body: { email: 'NELL@example.com' }, cookie });
  assert.equal(clash.status, 400);
  assert.match(clash.body.error, /already attached/);
});

test('a malformed email is refused rather than silently dropped', async () => {
  const { cookie } = await account();
  const res = await call('POST', '/api/email', { body: { email: 'nope' }, cookie });
  assert.equal(res.status, 400);
  const [u] = await store.query('SELECT email FROM users WHERE display_name = $1', ['Russ']);
  assert.equal(u.email, null, 'a refused address must not be half-stored');
});

test('recovery is unavailable, and says so, when no mail provider is set up', async () => {
  await account('Nell', 'nell@example.com');
  const res = await call('POST', '/api/recover', { body: { email: 'nell@example.com' } });
  assert.equal(res.status, 503);
});

test('a failed send never invalidates the working code', async () => {
  const { code } = await account('Nell', 'nell@example.com');
  process.env.RESEND_API_KEY = 'test-key-that-will-fail';
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => 'nope' });
  try {
    await call('POST', '/api/recover', { body: { email: 'nell@example.com' } });
  } finally {
    globalThis.fetch = original;
    delete process.env.RESEND_API_KEY;
  }
  const still = await call('POST', '/api/login',
    { body: { displayName: 'Nell', recoveryCode: code } });
  assert.equal(still.status, 200, 'the old code must still work after a failed send');
});

test('the board prices every open game', async () => {
  const res = await call('GET', '/api/games');
  assert.equal(res.status, 200);
  assert.equal(res.body.games.length, 1);
  const g = res.body.games[0];
  assert.equal(g.home.name, 'Colony');
  assert.ok(g.home.prob > g.away.prob, 'top seed should be favourite');
  // The published number is the model's own probability, not a market price:
  // nothing can be staked any more, so no money bends it and the two sides sum
  // to exactly one with no margin taken out in between.
  assert.equal(Math.round((g.home.prob + g.away.prob) * 1e6) / 1e6, 1);
  assert.ok(!('odds' in g.home) && !('odds' in g.away), 'a stats board quotes no prices');
  assert.ok(!('staked' in g) && !('spreads' in g));
});

test('bets are hidden until the game locks, then revealed', async () => {
  const { userId } = await account();
  await placeBet(store, { userId, gameId: 1, side: 'home', stake: 500, clock: () => NOW });

  const before = await call('GET', '/api/game/1');
  assert.equal(before.body.revealed, false);
  assert.equal(before.body.bets.length, 0);

  const after = await call('GET', '/api/game/1', { now: Date.parse('2026-08-16T14:00:01Z') });
  assert.equal(after.body.revealed, true);
  assert.equal(after.body.bets.length, 1);
  assert.equal(after.body.bets[0].display_name, 'Russ');
});

test('admin endpoints are closed to ordinary punters', async () => {
  const { cookie } = await account();
  for (const [method, path, body] of [
    ['POST', '/api/admin/settle', { gameId: 1, homeScore: 15, awayScore: 9 }],
    ['POST', '/api/admin/void', { gameId: 1 }],
    ['GET', '/api/admin/games', undefined],
  ]) {
    const res = await call(method, path, { body, cookie });
    assert.equal(res.status, 403, `${path} should be admin-only`);
  }
});

test('an admin can settle a game and it pays out', async () => {
  const { cookie } = await account();
  const punter = await account('Sam', 'sam@test.com');
  const bet = await placeBet(store,
    { userId: punter.userId, gameId: 1, side: 'home', stake: 1000, clock: () => NOW });
  await store.query('UPDATE users SET is_admin = TRUE WHERE display_name = $1', ['Russ']);

  const res = await call('POST', '/api/admin/settle',
    { body: { gameId: 1, homeScore: 15, awayScore: 7 }, cookie });
  assert.equal(res.status, 200);
  assert.equal(res.body.settledBets, 1);

  const [row] = await store.query('SELECT status, payout FROM bets WHERE id = $1', [bet.betId]);
  assert.equal(row.status, 'won');
  assert.ok(row.payout > 1000);
});

test('an admin can void a game and everyone is refunded', async () => {
  const { cookie } = await account();
  const punter = await account('Sam', 'sam@test.com');
  await placeBet(store,
    { userId: punter.userId, gameId: 1, side: 'away', stake: 3000, clock: () => NOW });
  await store.query('UPDATE users SET is_admin = TRUE WHERE display_name = $1', ['Russ']);

  const res = await call('POST', '/api/admin/void',
    { body: { gameId: 1, reason: 'Lightning delay, abandoned' }, cookie });
  assert.equal(res.status, 200);
  const me = await call('GET', '/api/me', { cookie: punter.cookie });
  assert.equal(me.body.user.bankroll, 10000);
});

test('the sync endpoint refuses anonymous callers without the cron secret', async () => {
  const res = await call('GET', '/api/sync');
  assert.equal(res.status, 401);
});

test('every read endpoint the site is built on answers without a session', async () => {
  for (const path of ['/api/games', '/api/results', '/api/rankings', '/api/health']) {
    const res = await call('GET', path);
    assert.equal(res.status, 200, `${path} must answer a visitor with no account`);
  }
  const health = await call('GET', '/api/health');
  assert.equal(health.body.games, 1);
});

test('unknown endpoints 404 rather than crashing', async () => {
  const res = await call('GET', '/api/nope');
  assert.equal(res.status, 404);
});

// The accounts, the sessions and the betting engine all survived the move to a
// stats site; only the four routes below were taken out. Nothing else proves
// they are gone, and re-exporting any one of them would quietly put play money
// back on a site that no longer claims to have any. A signed-in caller is used
// deliberately: 404 rather than 401 is the difference between "removed" and
// "merely guarded".
test('the four betting endpoints are gone, not merely closed', async () => {
  const { cookie } = await account();
  for (const [method, path, body] of [
    ['POST', '/api/bet', { gameId: 1, side: 'home', stake: 100 }],
    ['GET', '/api/mybets', undefined],
    ['GET', '/api/leaderboard', undefined],
    ['POST', '/api/signup', { displayName: 'Newcomer' }],
  ]) {
    const res = await call(method, path, { body, cookie });
    assert.equal(res.status, 404, `${method} ${path} must not be an endpoint`);
    assert.match(res.body.error, /No such endpoint/);
  }
  const [{ n }] = await store.query('SELECT COUNT(*) AS n FROM bets');
  assert.equal(Number(n), 0, 'and nothing may be written on the way to the 404');
});

test('logout clears the session', async () => {
  const { cookie } = await account();
  await call('POST', '/api/logout', { cookie });
  const me = await call('GET', '/api/me', { cookie });
  assert.equal(me.body.user, null);
});

test('the board still renders when the WFDF feed is unreachable', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network is down'); };
  try {
    const res = await call('GET', '/api/games', { autoSync: true });
    assert.equal(res.status, 200, 'a dead feed must not take the board down');
    assert.equal(res.body.games.length, 1, 'and the last-known board still prices');
  } finally { globalThis.fetch = original; }
});

test('the opportunistic sync does not re-run on every request', async () => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { calls += 1; throw new Error('down'); };
  try {
    await call('GET', '/api/games', { autoSync: true });
    const afterFirst = calls;
    await call('GET', '/api/games', { autoSync: true });
    assert.equal(calls, afterFirst, 'a second board load within the interval must not refetch');
  } finally { globalThis.fetch = original; }
});

test('a request with no supplied store migrates one itself', async () => {
  // Omitting opts.store is exactly what serverless does: the router owns the
  // connection and has to create the schema on a cold start. Production 500'd
  // because nothing ever did.
  const res = await handle(
    { method: 'GET', url: '/api/health', headers: {} },
    { now: NOW, autoSync: false }
  );
  assert.notEqual(res.status, 500, `health 500'd on a fresh db: ${res.body.error}`);
  assert.equal(res.body.ok, true);
});

test('health reports whether storage is actually durable', async () => {
  const res = await call('GET', '/api/health');
  assert.equal(res.body.storage.backend, 'sqlite');
  assert.equal(res.body.storage.durable, false);
  assert.match(res.body.storage.warning, /POSTGRES_URL/);
  assert.equal(res.body.teams, 2);
});

test('the board never waits on the feed', async () => {
  // A hung feed must not hold up the page. If the board awaited the sync this
  // would sit here for the full delay and blow the function timeout in prod.
  const original = globalThis.fetch;
  globalThis.fetch = () => new Promise((r) => setTimeout(r, 30_000));
  try {
    const started = Date.now();
    const res = await call('GET', '/api/games', { autoSync: true });
    assert.equal(res.status, 200);
    assert.ok(Date.now() - started < 1000, 'board should answer immediately');
  } finally { globalThis.fetch = original; }
});

test('tick is rate limited so it cannot be hammered', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error('down'); };
  try {
    await call('GET', '/api/tick', { autoSync: true });
    const after = calls;
    const second = await call('GET', '/api/tick', { autoSync: true });
    assert.equal(calls, after, 'a second tick inside the interval must not refetch');
    assert.equal(second.body.skipped, true);
  } finally { globalThis.fetch = original; }
});

test('tick is open without auth but reports honestly', async () => {
  const res = await call('GET', '/api/tick');
  assert.equal(res.status, 200);
  assert.equal(res.body.skipped, true);
});

// --- the email must never leave the server ---------------------------------

test('no public endpoint exposes an email address', async () => {
  const { cookie, userId } = await account('Russ', 'secret-address@example.com');
  await placeBet(store, { userId, gameId: 1, side: 'home', stake: 1000, clock: () => NOW });
  await store.query('UPDATE users SET is_admin = TRUE WHERE display_name = $1', ['Russ']);
  await call('POST', '/api/admin/settle',
    { body: { gameId: 1, homeScore: 15, awayScore: 9 }, cookie });

  const endpoints = [
    ['GET', '/api/games', undefined],
    ['GET', '/api/game/1', undefined],
    ['GET', '/api/rankings', undefined],
    ['GET', '/api/search?q=colony', undefined],
    ['GET', '/api/health', undefined],
    ['GET', '/api/me', cookie],
    ['GET', '/api/admin/games', cookie],
    ['GET', '/api/tick', cookie],
  ];

  for (const [method, path, c] of endpoints) {
    const res = await call(method, path, { cookie: c, now: Date.parse('2026-08-16T15:00:00Z') });
    const body = JSON.stringify(res.body);
    assert.ok(!body.includes('secret-address'), `${path} leaked the address: ${body.slice(0, 300)}`);
    assert.ok(!body.includes('@example.com'), `${path} leaked an email`);
    assert.ok(!/"email"\s*:\s*"/.test(body), `${path} returned an email field`);
  }
});

test('the revealed bet feed shows names only, never contact details', async () => {
  const { userId } = await account('Russ', 'russ@example.com');
  await placeBet(store, { userId, gameId: 1, side: 'home', stake: 500, clock: () => NOW });
  const res = await call('GET', '/api/game/1', { now: Date.parse('2026-08-16T15:00:00Z') });
  assert.equal(res.body.revealed, true);
  assert.deepEqual(Object.keys(res.body.bets[0]).sort(),
    ['display_name', 'odds', 'side', 'stake', 'status']);
});

test('the recovery hash never leaves the server either', async () => {
  const { cookie } = await account();
  for (const path of ['/api/me', '/api/game/1', '/api/rankings']) {
    const res = await call('GET', path, { cookie });
    const body = JSON.stringify(res.body);
    assert.ok(!body.includes('scrypt'), `${path} leaked a password hash`);
    assert.ok(!/recovery_hash|recoveryCode/.test(body), `${path} leaked recovery material`);
  }
});

test('a signed-in player can rotate their code, and the old one dies', async () => {
  const { cookie, code } = await account();
  const res = await call('POST', '/api/regenerate-code', { cookie });
  assert.equal(res.status, 200);
  const fresh = res.body.recoveryCode;
  assert.notEqual(fresh, code);
  assert.match(fresh, /^[a-z]+-[a-z]+-[a-z]+$/);

  await call('POST', '/api/logout', { cookie });
  const old = await call('POST', '/api/login', { body: { displayName: 'Russ', recoveryCode: code } });
  assert.equal(old.status, 401, 'the shared code must stop working');
  const now = await call('POST', '/api/login', { body: { displayName: 'Russ', recoveryCode: fresh } });
  assert.equal(now.status, 200);
});

test('rotating a code keeps you signed in on the device you did it from', async () => {
  const { cookie } = await account();
  await call('POST', '/api/regenerate-code', { cookie });
  const me = await call('GET', '/api/me', { cookie });
  assert.equal(me.body.user.displayName, 'Russ');
});

test('you cannot rotate someone else’s code', async () => {
  await account();
  const res = await call('POST', '/api/regenerate-code');
  assert.equal(res.status, 401);
});

test('health reports enough to tell whether settlement is alive', async () => {
  const res = await call('GET', '/api/health', { now: Date.parse('2026-08-16T15:00:00Z') });
  assert.equal(res.status, 200);
  assert.ok(res.body.sync, 'health must expose sync state');
  assert.equal(res.body.sync.startedUnsettledGames, 1, 'the 14:00 game has started and is unsettled');
  assert.ok('poolsAwaitingScores' in res.body.sync);
  assert.ok('lastAttempt' in res.body.sync);
  assert.ok('lastError' in res.body.sync);
});

test('a forced tick ignores the rate limit', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error('feed down'); };
  try {
    await call('GET', '/api/tick', { autoSync: true });
    const after = calls;
    await call('GET', '/api/tick?force=1', { autoSync: true });
    assert.ok(calls > after, 'force must bypass the interval');
  } finally { globalThis.fetch = original; }
});

test('a rate-limited tick says when it will next run', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('down'); };
  try {
    await call('GET', '/api/tick', { autoSync: true });
    const res = await call('GET', '/api/tick', { autoSync: true });
    assert.equal(res.body.skipped, true);
    assert.ok(res.body.nextDueInSeconds >= 0 && res.body.nextDueInSeconds <= 180);
  } finally { globalThis.fetch = original; }
});

test('a failed sync is recorded where health can see it', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('WFDF is on fire'); };
  try {
    await call('GET', '/api/tick?force=1', { autoSync: true });
  } finally { globalThis.fetch = original; }
  const health = await call('GET', '/api/health');
  assert.match(health.body.sync.lastError || '', /WFDF is on fire/);
});

// --- admin surface -----------------------------------------------------------

const ADMIN_ROUTES = [
  ['POST', '/api/admin/settle', { gameId: 1, homeScore: 15, awayScore: 9 }],
  ['POST', '/api/admin/void', { gameId: 1, reason: 'nope' }],
  ['GET', '/api/admin/games', undefined],
  ['GET', '/api/sync', undefined],
];

test('every admin route rejects an anonymous caller', async () => {
  for (const [method, path, body] of ADMIN_ROUTES) {
    const res = await call(method, path, { body });
    assert.equal(res.status, 401, `${path} must not answer an anonymous caller`);
  }
});

test('every admin route rejects an ordinary signed-in player', async () => {
  const { cookie } = await account('Nosy');
  for (const [method, path, body] of ADMIN_ROUTES) {
    const res = await call(method, path, { body, cookie });
    assert.equal(res.status, 403, `${path} must not answer a non-admin`);
    assert.match(res.body.error, /Admins only|cron/i);
  }
});

test('a non-admin cannot settle a game by calling the API directly', async () => {
  const punter = await account('Punter');
  await placeBet(store,
    { userId: punter.userId, gameId: 1, side: 'home', stake: 1000, clock: () => NOW });
  const attacker = await account('Attacker');
  const res = await call('POST', '/api/admin/settle',
    { body: { gameId: 1, homeScore: 0, awayScore: 15 }, cookie: attacker.cookie });
  assert.equal(res.status, 403);
  const [g] = await store.query('SELECT settled FROM games WHERE id = 1');
  assert.equal(Boolean(g.settled), false, 'the game must be untouched');
  const [b] = await store.query('SELECT status FROM bets WHERE game_id = 1');
  assert.equal(b.status, 'open');
});

test('nobody is an admin by default', async () => {
  const { res } = await account();
  assert.equal(res.body.user.isAdmin, false);
});

test('another player cannot see whether you are an admin', async () => {
  const { userId } = await account('Boss');
  await store.query('UPDATE users SET is_admin = TRUE WHERE display_name = $1', ['Boss']);
  await placeBet(store, { userId, gameId: 1, side: 'home', stake: 100, clock: () => NOW });

  const feed = await call('GET', '/api/game/1', { now: Date.parse('2026-08-16T15:00:00Z') });
  assert.equal(feed.body.bets.length, 1, 'the feed has to be showing something to be a leak');
  assert.ok(!JSON.stringify(feed.body).includes('is_admin'));
});

test('a game that has kicked off leaves the board rather than lingering on it', async () => {
  const after = await call('GET', '/api/games', { now: Date.parse('2026-08-16T15:00:00Z') });
  assert.equal(after.body.games.length, 0, 'the board is what is still to come');
  assert.ok(!('recent' in after.body), 'and does not clutter itself with what is not');
});

test('a started game exposes who backed what; an upcoming one does not', async () => {
  const { userId } = await account();
  await placeBet(store, { userId, gameId: 1, side: 'home', stake: 500, clock: () => NOW });

  const hidden = await call('GET', '/api/game/1');
  assert.equal(hidden.body.revealed, false);
  assert.equal(hidden.body.bets.length, 0);

  const shown = await call('GET', '/api/game/1', { now: Date.parse('2026-08-16T15:00:00Z') });
  assert.equal(shown.body.revealed, true);
  assert.equal(shown.body.bets[0].display_name, 'Russ');
  assert.equal(shown.body.bets[0].stake, 500);
});

// --- caching correctness ----------------------------------------------------

test('personal responses are never cacheable', async () => {
  const { cookie } = await account();
  for (const path of ['/api/me', '/api/game/1', '/api/tick', '/api/health']) {
    const res = await call('GET', path, { cookie });
    assert.match(res.headers['Cache-Control'], /no-store/,
      `${path} must not be storable — a shared cache would serve one player another's data`);
  }
  const login = await call('POST', '/api/login',
    { body: { displayName: 'Russ', recoveryCode: 'x' } });
  assert.match(login.headers['Cache-Control'], /no-store/);
});

test('the board, the results and the rankings are shareable, and set no cookie', async () => {
  for (const path of ['/api/games', '/api/results', '/api/rankings']) {
    const res = await call('GET', path);
    assert.match(res.headers['Cache-Control'], /s-maxage/, `${path} should be shared-cacheable`);
    assert.ok(!res.headers['Set-Cookie'], 'a cacheable response must never carry a cookie');
  }
});

test('a signed-in board request still cannot leak a session into the cache', async () => {
  const { cookie } = await account();
  const res = await call('GET', '/api/games', { cookie });
  assert.ok(!res.headers['Set-Cookie']);
  assert.ok(!JSON.stringify(res.body).includes('Russ'), 'the board is identical for everyone');
});

test('an admin can export everything that cannot be rebuilt from the feed', async () => {
  const { cookie, userId } = await account();
  await placeBet(store, { userId, gameId: 1, side: 'home', stake: 250, clock: () => NOW });
  await store.query('UPDATE users SET is_admin = TRUE WHERE display_name = $1', ['Russ']);

  const res = await call('GET', '/api/admin/export', { cookie });
  assert.equal(res.status, 200);
  assert.equal(res.body.counts.users, 1);
  assert.equal(res.body.counts.bets, 1);
  assert.equal(res.body.bets[0].stake, 250);
  assert.ok(res.body.teamRatings.length > 0, 'learned ratings must travel with the backup');
  assert.match(res.headers['Cache-Control'], /no-store/, 'a backup must never be cached');
});

test('the export is admin-only', async () => {
  const { cookie } = await account('Nosy');
  assert.equal((await call('GET', '/api/admin/export', { cookie })).status, 403);
  assert.equal((await call('GET', '/api/admin/export')).status, 401);
});

// --- search -----------------------------------------------------------------

test('search finds a club by name, however it is typed', async () => {
  for (const q of ['colony', 'COLONY', 'colo', 'ony']) {
    const res = await call('GET', `/api/search?q=${encodeURIComponent(q)}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.teams[0].name, 'Colony', `"${q}" should find Colony`);
  }
});

test('search finds clubs by country and abbreviation too', async () => {
  const byCountry = await call('GET', '/api/search?q=poland');
  assert.equal(byCountry.body.teams[0].name, 'Aethers');
  const byAbbr = await call('GET', '/api/search?q=col');
  assert.ok(byAbbr.body.teams.some((t) => t.name === 'Colony'));
});

test('search returns a club’s upcoming fixtures, priced the same way the board prices them', async () => {
  const res = await call('GET', '/api/search?q=colony');
  assert.equal(res.body.games.length, 1);
  const g = res.body.games[0];
  assert.ok(g.home.prob > 0 && g.away.prob > 0);
  assert.equal(Math.round((g.home.prob + g.away.prob) * 1e6) / 1e6, 1);
  // Search and the board go through one pricing call, so a fixture cannot be
  // quoted one way here and another way there.
  const board = (await call('GET', '/api/games')).body.games[0];
  assert.deepEqual(g.home, board.home);
});

test('search reaches games the board is too near-sighted to show', async () => {
  await store.query(
    `INSERT INTO games (id,home_team_id,away_team_id,division,pool_name,starts_at,status)
     VALUES (99,1131,1109,'Open','Final',$1,'scheduled')`, ['2026-08-22T14:00:00Z']);
  const board = await call('GET', '/api/games');
  assert.ok(!board.body.games.some((g) => g.id === 99), 'the final is beyond the horizon');
  const search = await call('GET', '/api/search?q=colony');
  assert.ok(search.body.games.some((g) => g.id === 99), 'but search finds it');
});

test('a short or empty query returns nothing rather than everything', async () => {
  for (const q of ['', 'a', ' ']) {
    const res = await call('GET', `/api/search?q=${encodeURIComponent(q)}`);
    assert.equal(res.body.teams.length, 0, `"${q}" must not return the whole tournament`);
  }
});

test('a query matching nothing is handled cleanly', async () => {
  const res = await call('GET', '/api/search?q=zzzznotateam');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.teams, []);
  assert.deepEqual(res.body.games, []);
});

test('search cannot be used to inject SQL', async () => {
  const res = await call('GET', `/api/search?q=${encodeURIComponent("' OR 1=1 --")}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.teams.length, 0, 'a quote is just a character to match on');
  const still = await store.query('SELECT COUNT(*) AS n FROM teams');
  assert.equal(Number(still[0].n), 2);
});

test('search results are shared-cacheable and carry no session', async () => {
  const { cookie } = await account();
  const res = await call('GET', '/api/search?q=colony', { cookie });
  assert.match(res.headers['Cache-Control'], /s-maxage/);
  assert.ok(!res.headers['Set-Cookie']);
});

test('a recovery code is exactly three words and nothing else', async () => {
  // Rotation is the only path that still issues codes, so it is the one that
  // has to keep producing readable, unguessable ones.
  const { cookie, code } = await account();
  const seen = new Set([code]);
  for (let i = 0; i < 39; i += 1) {
    const fresh = (await call('POST', '/api/regenerate-code', { cookie })).body.recoveryCode;
    assert.match(fresh, /^[a-z]+-[a-z]+-[a-z]+$/, `got "${fresh}"`);
    assert.equal(fresh.split('-').length, 3);
    seen.add(fresh);
  }
  assert.ok(seen.size > 35, `codes should not repeat: ${seen.size} distinct of 40`);
});

test('search returns fixtures even when timestamps arrive in Postgres format', async () => {
  // Postgres hands back '2026-08-16 14:00:00+00'. A naive Date.parse of that
  // is NaN, which silently emptied the results.
  await store.query("UPDATE games SET starts_at = '2026-08-16 14:00:00+00' WHERE id = 1");
  const res = await call('GET', '/api/search?q=colony');
  assert.equal(res.status, 200);
  assert.equal(res.body.games.length, 1, 'the fixture must survive the timestamp format');
});

test('search exposes what the model has learned about a club', async () => {
  const res = await call('GET', '/api/search?q=colony');
  const t = res.body.teams[0];
  assert.equal(typeof t.rating, 'number');
  assert.ok(t.rating > 1000 && t.rating < 2200, `implausible rating ${t.rating}`);
  assert.ok(t.confidence >= 0 && t.confidence <= 100, `confidence ${t.confidence} out of range`);
  assert.equal(t.played, 0, 'nothing played yet');
});

test('a result raises the winner’s rating and the site can show it', async () => {
  const before = (await call('GET', '/api/search?q=aethers')).body.teams[0];
  const { cookie } = await account();
  await store.query('UPDATE users SET is_admin = TRUE WHERE display_name = $1', ['Russ']);
  await call('POST', '/api/admin/settle',
    { body: { gameId: 1, homeScore: 9, awayScore: 15 }, cookie });
  const after = (await call('GET', '/api/search?q=aethers')).body.teams[0];

  assert.ok(after.rating > before.rating, 'the underdog winner should gain rating');
  assert.ok(after.confidence > before.confidence, 'and the model should be surer of them');
  assert.equal(after.played, 1);
});

test('a session expires even when its timestamp arrives in Postgres format', async () => {
  const { cookie } = await account();
  // Exactly what Postgres returns; Date.parse reads it as NaN.
  await store.query("UPDATE sessions SET created_at = '2026-01-01 10:00:00+00'");
  const stale = await call('GET', '/api/me', { now: Date.parse('2026-08-16T10:00:00Z') });
  assert.equal(stale.status, 200);
  const me = await call('GET', '/api/me', { cookie, now: Date.parse('2026-08-16T10:00:00Z') });
  assert.equal(me.body.user, null, 'a session seven months old must not still be valid');
});

test('a fresh session is not expired by the same parsing', async () => {
  const { cookie } = await account();
  await store.query("UPDATE sessions SET created_at = '2026-08-16 09:00:00+00'");
  const me = await call('GET', '/api/me', { cookie, now: Date.parse('2026-08-16T10:00:00Z') });
  assert.equal(me.body.user.displayName, 'Russ');
});
