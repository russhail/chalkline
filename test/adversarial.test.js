import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../lib/store.js';
import { handle, COOKIE, parseCookies } from '../lib/router.js';
import { sync } from '../lib/sync.js';
import * as auth from '../lib/auth.js';
import { placeBet } from '../lib/betting.js';

const NOW = Date.parse('2026-08-16T10:00:00Z');
let store;

const TEAMS = [
  { id: 1, name: 'Colony', abbreviation: 'COL', division: 'Open', country: 'Australia', seed: 1 },
  { id: 2, name: 'Aethers', abbreviation: 'AEW', division: 'Open', country: 'Poland', seed: 44 },
];
const GAMES = [{
  id: 1, homeTeamId: 1, awayTeamId: 2, homeLabel: null, awayLabel: null,
  division: 'Open', poolName: 'Pool A', poolId: 10, startsAt: '2026-08-16T14:00:00Z',
  status: 'scheduled', homeScore: null, awayScore: null, valid: true,
}];

const call = (method, url, { body, cookie, now = NOW, ip = '10.0.0.1' } = {}) =>
  handle({ method, url, body,
           headers: { ...(cookie ? { cookie } : {}), 'x-forwarded-for': ip } },
         { store, now, autoSync: false });
const cookieFrom = (res) => {
  const raw = res.headers?.['Set-Cookie'];
  return raw ? `${COOKIE}=${parseCookies(raw.split(';')[0])[COOKIE]}` : null;
};

// Nobody can open an account over HTTP any more, so an attacker's starting
// point is a session on an account that already exists. The row is created
// through lib/auth.js and the session through the one route that still issues
// them, which is exactly the state the router will meet in production.
let ipSeq = 0;
const account = async (displayName = 'Russ', { ip } = {}) => {
  ipSeq += 1;
  const made = await auth.createUser(store, { displayName, now: NOW });
  assert.ok(made.ok, `fixture account "${displayName}": ${made.errors?.join(' ')}`);
  const res = await call('POST', '/api/login',
    { body: { displayName, recoveryCode: made.recoveryCode }, ip: ip ?? `10.1.0.${ipSeq}` });
  return { userId: made.userId, code: made.recoveryCode, cookie: cookieFrom(res) };
};

beforeEach(async () => {
  store = createStore({ backend: 'sqlite' });
  await store.migrate();
  await sync(store, { force: true, fetcher: async () => ({
    heartbeat: { cacheVersion: 'v1' }, teams: TEAMS, fieldSizes: { Open: 48 }, games: GAMES }) });
});

// 1 — session tokens must be unguessable and unique
test('session tokens are long, random and never repeat', async () => {
  const seen = new Set();
  for (let i = 0; i < 12; i += 1) {
    const { cookie } = await account(`User${i}`);
    const tok = cookie.split('=')[1];
    assert.ok(tok.length >= 32, `token too short: ${tok.length}`);
    assert.ok(!seen.has(tok), 'token collision');
    seen.add(tok);
  }
});

// 2 — a forged session token gets you nothing
test('a made-up session cookie is not a session', async () => {
  await account();
  const me = await call('GET', '/api/me', { cookie: `${COOKIE}=totally-made-up-token` });
  assert.equal(me.body.user, null);
  // Not merely anonymous, either: a forged cookie must fall at the same door as
  // no cookie at all on everything a real session would have opened.
  const admin = await call('GET', '/api/admin/games', { cookie: `${COOKIE}=nope` });
  assert.equal(admin.status, 401);
  const rotate = await call('POST', '/api/regenerate-code', { cookie: `${COOKIE}=nope` });
  assert.equal(rotate.status, 401);
});

// 3 — money is conserved across a settlement
test('settlement neither creates nor destroys units beyond the stated payout', async () => {
  const ana = await account('Ana');
  const bob = await account('Bob');
  const betA = await placeBet(store,
    { userId: ana.userId, gameId: 1, side: 'home', stake: 3000, clock: () => NOW });
  const betB = await placeBet(store,
    { userId: bob.userId, gameId: 1, side: 'away', stake: 3000, clock: () => NOW });
  await store.query('UPDATE users SET is_admin = TRUE WHERE display_name = $1', ['Ana']);
  await call('POST', '/api/admin/settle',
    { body: { gameId: 1, homeScore: 15, awayScore: 9 }, cookie: ana.cookie });

  const rows = await store.query('SELECT display_name, bankroll FROM users ORDER BY display_name');
  const byName = Object.fromEntries(rows.map((r) => [r.display_name, r.bankroll]));
  assert.equal(byName.Ana, Math.round((7000 + 3000 * betA.odds) * 100) / 100);
  assert.equal(byName.Bob, 7000, 'the loser is down exactly their stake, no more');
  assert.ok(betB.odds > 1);
  const ledger = await store.query('SELECT SUM(amount) AS net FROM ledger');
  assert.ok(Number.isFinite(Number(ledger[0].net)), 'the ledger must stay coherent');
});

// 4 — the published price is not for sale
test('a stake on the books cannot bend the price the board publishes', async () => {
  const { userId } = await account();
  const before = (await call('GET', '/api/games')).body.games[0];
  await placeBet(store, { userId, gameId: 1, side: 'home', stake: 10000, clock: () => NOW });
  const after = (await call('GET', '/api/games')).body.games[0];

  // The board is priced from the model alone — no stakes are handed to the
  // pricing call any more — so a whole bankroll landing on one side must leave
  // the published number exactly where it was.
  assert.deepEqual(after.home, before.home);
  assert.deepEqual(after.away, before.away);
  assert.equal(Math.round((after.home.prob + after.away.prob) * 1e6) / 1e6, 1,
    'two true probabilities, with no margin taken out between them');
  assert.ok(after.home.prob > 0 && after.home.prob < 1);
});

// 5 — the board must not be expensive
test('the board answers in reasonable time with a full slate', async () => {
  const many = Array.from({ length: 400 }, (_, i) => ({
    ...GAMES[0], id: 100 + i, startsAt: '2026-08-16T18:00:00Z',
  }));
  await sync(store, { force: true, fetcher: async () => ({
    heartbeat: { cacheVersion: 'v2' }, teams: TEAMS, fieldSizes: { Open: 48 }, games: many }) });
  const started = Date.now();
  const res = await call('GET', '/api/games');
  const ms = Date.now() - started;
  assert.equal(res.status, 200);
  assert.ok(res.body.games.length >= 100);
  assert.ok(ms < 2000, `board took ${ms}ms with ${res.body.games.length} games`);
});

// 6 — logging out one device must not log out the other
test('signing out on one device leaves your other session alone', async () => {
  const phone = await account('Russ');
  const laptop = cookieFrom(await call('POST', '/api/login',
    { body: { displayName: 'Russ', recoveryCode: phone.code } }));
  assert.ok(laptop && laptop !== phone.cookie, 'two sign-ins are two separate sessions');

  await call('POST', '/api/logout', { cookie: phone.cookie });
  assert.equal((await call('GET', '/api/me', { cookie: phone.cookie })).body.user, null);
  const still = await call('GET', '/api/me', { cookie: laptop });
  assert.equal(still.body.user.displayName, 'Russ', 'the other device stays signed in');
});

// --- rate limiting ----------------------------------------------------------

test('a different address is unaffected by someone else hitting the cap', async () => {
  const ip = '203.0.113.8';
  for (let i = 0; i < 3; i += 1) {
    const res = await call('POST', '/api/recover', { body: { email: 'nell@example.com' }, ip });
    assert.notEqual(res.status, 429, `request ${i + 1} is within the hourly allowance`);
  }
  const capped = await call('POST', '/api/recover', { body: { email: 'nell@example.com' }, ip });
  assert.equal(capped.status, 429);

  const other = await call('POST', '/api/recover',
    { body: { email: 'nell@example.com' }, ip: '203.0.113.9' });
  assert.notEqual(other.status, 429, 'a second address starts on a counter of its own');
});

test('brute-forcing a recovery code gets locked out', async () => {
  await account('Target', { ip: '10.9.9.1' });
  const ip = '198.51.100.4';
  let refused = 0;
  for (let i = 0; i < 14; i += 1) {
    const res = await call('POST', '/api/login',
      { body: { displayName: 'Target', recoveryCode: `guess-guess-guess-${1000 + i}` }, ip });
    if (res.status === 429) refused += 1;
  }
  assert.ok(refused >= 3, `expected lockout after 10 attempts, got ${refused} refusals`);
});

test('an attacker cannot lock a victim out by hammering their name', async () => {
  const { code } = await account('Victim', { ip: '10.9.9.9' });
  for (let i = 0; i < 12; i += 1) {
    await call('POST', '/api/login',
      { body: { displayName: 'Victim', recoveryCode: 'wrong-wrong-wrong-0000' }, ip: '198.51.100.66' });
  }
  // The victim, from their own address, can still get in.
  const ok = await call('POST', '/api/login',
    { body: { displayName: 'Victim', recoveryCode: code }, ip: '10.9.9.9' });
  assert.equal(ok.status, 200, 'the real owner must not be collateral damage');
});

test('a successful sign-in clears the failure counter', async () => {
  const ip = '10.8.8.8';
  const { code } = await account('Fumble', { ip });
  for (let i = 0; i < 8; i += 1) {
    await call('POST', '/api/login', { body: { displayName: 'Fumble', recoveryCode: 'no' }, ip });
  }
  const good = await call('POST', '/api/login', { body: { displayName: 'Fumble', recoveryCode: code }, ip });
  assert.equal(good.status, 200);
  for (let i = 0; i < 8; i += 1) {
    const res = await call('POST', '/api/login', { body: { displayName: 'Fumble', recoveryCode: 'no' }, ip });
    assert.notEqual(res.status, 429, 'the counter should have reset on success');
  }
});
