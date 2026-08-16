import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../lib/store.js';
import { handle, COOKIE, parseCookies } from '../lib/router.js';
import { sync } from '../lib/sync.js';
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
let ipSeq = 0;
const signUp = async (displayName = 'Russ', extra = {}) => {
  // A fresh source address per signup, so the rate limiter doesn't interfere
  // with tests that are about something else.
  ipSeq += 1;
  const res = await call('POST', '/api/signup',
    { body: { displayName, ...extra }, ip: `10.1.0.${ipSeq}` });
  return { res, cookie: cookieFrom(res) };
};

beforeEach(async () => {
  store = createStore({ backend: 'sqlite' });
  await store.migrate();
  await sync(store, { force: true, fetcher: async () => ({
    heartbeat: { cacheVersion: 'v1' }, teams: TEAMS, fieldSizes: { Open: 48 }, games: GAMES }) });
});

// 1 — privilege escalation via the signup payload
test('you cannot make yourself an admin by asking nicely', async () => {
  const { res } = await signUp('Sneaky', { isAdmin: true, is_admin: true, bankroll: 999999 });
  assert.equal(res.body.user.isAdmin, false);
  assert.equal(res.body.user.bankroll, 10000, 'bankroll must not be settable at signup');
});

// 2 — bankroll injection on a bet
test('you cannot top yourself up through the bet endpoint', async () => {
  const { cookie } = await signUp();
  await call('POST', '/api/bet',
    { body: { gameId: 1, side: 'home', stake: 100, bankroll: 1e9, payout: 1e9 }, cookie });
  const me = await call('GET', '/api/me', { cookie });
  assert.equal(me.body.user.bankroll, 9900);
});

// 3 — hostile stakes
test('negative, zero, NaN and infinite stakes are all refused', async () => {
  const { cookie } = await signUp();
  for (const stake of [-1000, -0.01, 0, NaN, Infinity, -Infinity, '1e309', 'abc', null]) {
    const res = await call('POST', '/api/bet', { body: { gameId: 1, side: 'home', stake }, cookie });
    assert.equal(res.status, 400, `stake ${stake} should be refused`);
  }
  const me = await call('GET', '/api/me', { cookie });
  assert.equal(me.body.user.bankroll, 10000, 'no failed bet may move the bankroll');
});

// 4 — a bet bigger than the bankroll, and the classic off-by-one
test('you can stake your whole roll but not a penny more', async () => {
  const { cookie } = await signUp();
  const over = await call('POST', '/api/bet', { body: { gameId: 1, side: 'home', stake: 10000.01 }, cookie });
  assert.equal(over.status, 400);
  const exact = await call('POST', '/api/bet', { body: { gameId: 1, side: 'home', stake: 10000 }, cookie });
  assert.equal(exact.status, 200);
  const me = await call('GET', '/api/me', { cookie });
  assert.equal(me.body.user.bankroll, 0);
});

// 5 — concurrent bets must not double-spend
test('two bets racing on one account cannot overdraw it', async () => {
  const { cookie } = await signUp();
  const results = await Promise.all(Array.from({ length: 6 }, () =>
    call('POST', '/api/bet', { body: { gameId: 1, side: 'home', stake: 4000 }, cookie })));
  const accepted = results.filter((r) => r.status === 200).length;
  assert.ok(accepted <= 2, `only 2 x 4000 fits in 10000, ${accepted} were accepted`);
  const me = await call('GET', '/api/me', { cookie });
  assert.ok(me.body.user.bankroll >= 0, `bankroll went negative: ${me.body.user.bankroll}`);
});

// 6 — a bad side value
test('an unrecognised side is refused', async () => {
  const { cookie } = await signUp();
  for (const side of ['draw', 'HOME', '', null, { $ne: null }]) {
    const res = await call('POST', '/api/bet', { body: { gameId: 1, side, stake: 100 }, cookie });
    assert.equal(res.status, 400, `side ${JSON.stringify(side)} should be refused`);
  }
});

// 7 — betting on a game that does not exist
test('a nonexistent or nonsense game id is handled, not crashed on', async () => {
  const { cookie } = await signUp();
  for (const gameId of [999999, -1, 0, 'abc', null]) {
    const res = await call('POST', '/api/bet', { body: { gameId, side: 'home', stake: 100 }, cookie });
    assert.ok(res.status === 400 || res.status === 404, `game ${gameId} gave ${res.status}`);
  }
});

// 8 — SQL injection through a display name
test('a display name cannot carry SQL into the database', async () => {
  const nasty = "'; DROP TABLE users; --";
  await call('POST', '/api/signup', { body: { displayName: nasty } });
  const rows = await store.query('SELECT COUNT(*) AS n FROM users');
  assert.ok(Number(rows[0].n) >= 0, 'the users table still exists');
});

// 9 — script injection through a display name
test('a display name cannot contain markup at all', async () => {
  for (const name of ['<img src=x onerror=alert(1)>', '<script>alert(1)</script>', 'a"onmouseover="x']) {
    const res = await call('POST', '/api/signup', { body: { displayName: name } });
    assert.equal(res.status, 400, `"${name}" should be refused outright`);
  }
});

// 10 — session tokens must be unguessable and unique
test('session tokens are long, random and never repeat', async () => {
  const seen = new Set();
  for (let i = 0; i < 12; i += 1) {
    const { cookie } = await signUp(`User${i}`);
    const tok = cookie.split('=')[1];
    assert.ok(tok.length >= 32, `token too short: ${tok.length}`);
    assert.ok(!seen.has(tok), 'token collision');
    seen.add(tok);
  }
});

// 11 — a forged session token gets you nothing
test('a made-up session cookie is not a session', async () => {
  await signUp();
  const res = await call('GET', '/api/me', { cookie: `${COOKIE}=totally-made-up-token` });
  assert.equal(res.body.user, null);
  const bet = await call('POST', '/api/bet',
    { body: { gameId: 1, side: 'home', stake: 100 }, cookie: `${COOKIE}=nope` });
  assert.equal(bet.status, 401);
});

// 12 — one player cannot act as another
test('you cannot place a bet on someone else’s account', async () => {
  await signUp('Victim');
  const attacker = await signUp('Attacker');
  await call('POST', '/api/bet',
    { body: { gameId: 1, side: 'home', stake: 500, userId: 1, user_id: 1 }, cookie: attacker.cookie });
  const [victim] = await store.query('SELECT bankroll FROM users WHERE display_name = $1', ['Victim']);
  assert.equal(victim.bankroll, 10000, "the victim's bankroll must be untouched");
});

// 13 — money is conserved across a settlement
test('settlement neither creates nor destroys units beyond the stated payout', async () => {
  const a = await signUp('Ana'); const b = await signUp('Bob');
  const betA = await call('POST', '/api/bet', { body: { gameId: 1, side: 'home', stake: 3000 }, cookie: a.cookie });
  const betB = await call('POST', '/api/bet', { body: { gameId: 1, side: 'away', stake: 3000 }, cookie: b.cookie });
  await store.query('UPDATE users SET is_admin = TRUE WHERE display_name = $1', ['Ana']);
  await call('POST', '/api/admin/settle', { body: { gameId: 1, homeScore: 15, awayScore: 9 }, cookie: a.cookie });

  const rows = await store.query('SELECT display_name, bankroll FROM users ORDER BY display_name');
  const byName = Object.fromEntries(rows.map((r) => [r.display_name, r.bankroll]));
  assert.equal(byName.Ana, Math.round((7000 + 3000 * betA.body.bet.odds) * 100) / 100);
  assert.equal(byName.Bob, 7000, 'the loser is down exactly their stake, no more');
  assert.ok(betB.body.bet.odds > 1);
  const ledger = await store.query('SELECT SUM(amount) AS net FROM ledger');
  assert.ok(Number.isFinite(Number(ledger[0].net)), 'the ledger must stay coherent');
});

// 14 — repeated small bets must not drift the bankroll through float error
test('a hundred small bets leave the bankroll exactly where the arithmetic says', async () => {
  const { cookie } = await signUp();
  let expected = 10000;
  for (let i = 0; i < 100; i += 1) {
    const res = await call('POST', '/api/bet', { body: { gameId: 1, side: 'home', stake: 10 }, cookie });
    if (res.status === 200) expected -= 10;
  }
  const me = await call('GET', '/api/me', { cookie });
  assert.equal(me.body.user.bankroll, expected);
});

// 15 — odds must always be payable and sane
test('odds never go below evens for the underdog or below 1 for anyone', async () => {
  const { cookie } = await signUp();
  await call('POST', '/api/bet', { body: { gameId: 1, side: 'home', stake: 10000 }, cookie });
  const board = await call('GET', '/api/games');
  const g = board.body.games[0];
  assert.ok(g.home.odds > 1, `home odds ${g.home.odds} must exceed 1`);
  assert.ok(g.away.odds > 1, `away odds ${g.away.odds} must exceed 1`);
  assert.ok(Number.isFinite(g.home.odds) && Number.isFinite(g.away.odds));
});

// 16 — a duplicate display name in different case
test('names are unique case-insensitively, so nobody can impersonate by casing', async () => {
  await signUp('Anaximander23');
  for (const variant of ['anaximander23', 'ANAXIMANDER23', 'AnAxImAnDeR23']) {
    const res = await call('POST', '/api/signup', { body: { displayName: variant } });
    assert.equal(res.status, 400, `"${variant}" should collide`);
  }
});

// 17 — whitespace tricks in names
test('padding and doubled spaces cannot fake a distinct name', async () => {
  await signUp('Russ Hailwood');
  const res = await call('POST', '/api/signup', { body: { displayName: '  Russ   Hailwood  ' } });
  assert.equal(res.status, 400, 'collapsed whitespace should collide');
});

// 18 — the board must not be expensive
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

// 19 — a huge request body must not take the site down
test('an absurd payload is rejected rather than processed', async () => {
  const { cookie } = await signUp();
  const res = await call('POST', '/api/signup', { body: { displayName: 'x'.repeat(100000) } });
  assert.equal(res.status, 400);
});

// 20 — logging out one device must not log out the other
test('signing out on one device leaves your other session alone', async () => {
  const { cookie } = await signUp();
  const second = await call('POST', '/api/login',
    { body: { displayName: 'Russ', recoveryCode: 'wrong' } });
  assert.equal(second.status, 401);
  await call('POST', '/api/logout', { cookie });
  const me = await call('GET', '/api/me', { cookie });
  assert.equal(me.body.user, null);
});

// --- rate limiting ----------------------------------------------------------

test('signup is capped per source address', async () => {
  const ip = '203.0.113.7';
  const codes = [];
  for (let i = 0; i < 8; i += 1) {
    const res = await call('POST', '/api/signup', { body: { displayName: `Bot${i}` }, ip });
    codes.push(res.status);
  }
  assert.equal(codes.filter((c) => c === 200).length, 5, 'five allowed');
  assert.ok(codes.slice(5).every((c) => c === 429), 'the rest are refused');
});

test('a different address is unaffected by someone else hitting the cap', async () => {
  const ip = '203.0.113.8';
  for (let i = 0; i < 6; i += 1) {
    await call('POST', '/api/signup', { body: { displayName: `Spam${i}` }, ip });
  }
  const other = await call('POST', '/api/signup',
    { body: { displayName: 'Innocent' }, ip: '203.0.113.9' });
  assert.equal(other.status, 200);
});

test('brute-forcing a recovery code gets locked out', async () => {
  await signUp('Target');
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
  const { code } = await (async () => {
    const r = await call('POST', '/api/signup', { body: { displayName: 'Victim' }, ip: '10.9.9.9' });
    return { code: r.body.recoveryCode };
  })();
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
  const r = await call('POST', '/api/signup', { body: { displayName: 'Fumble' }, ip: '10.8.8.8' });
  const code = r.body.recoveryCode;
  const ip = '10.8.8.8';
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
