import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../lib/store.js';
import { handle, COOKIE, parseCookies } from '../lib/router.js';
import { sync } from '../lib/sync.js';
import * as auth from '../lib/auth.js';
import { placeBet, quote } from '../lib/betting.js';

const NOW = Date.parse('2026-08-16T14:30:00Z');
let store;

const TEAMS = [
  { id: 1, name: 'Colony', abbreviation: 'COL', division: 'Open', country: 'Australia', seed: 3 },
  { id: 2, name: 'Aethers', abbreviation: 'AEW', division: 'Open', country: 'Poland', seed: 26 },
];
const GAME = {
  id: 1, homeTeamId: 1, awayTeamId: 2, homeLabel: null, awayLabel: null,
  division: 'Open', poolName: 'Pool A', poolId: 10, startsAt: '2026-08-16T14:00:00Z',
  status: 'scheduled', homeScore: null, awayScore: null, valid: true,
};

const call = (method, url, { body, cookie, now = NOW, ip = '10.0.0.1' } = {}) =>
  handle({ method, url, body, headers: { ...(cookie ? { cookie } : {}), 'x-forwarded-for': ip } },
         { store, now, autoSync: false });
const cookieFrom = (r) => {
  const raw = r.headers?.['Set-Cookie'];
  return raw ? `${COOKIE}=${parseCookies(raw.split(';')[0])[COOKIE]}` : null;
};
// Nobody can open an account through the API any more, so the few tests that
// still need a punter — a position to show on a game page, a stake for the
// admin to settle — make one directly and place the bet through the engine.
const punter = async (displayName = 'Russ') => {
  const made = await auth.createUser(store, { displayName, now: NOW });
  const res = await call('POST', '/api/login',
    { body: { displayName, recoveryCode: made.recoveryCode } });
  return { userId: made.userId, cookie: cookieFrom(res) };
};

const feed = (over = {}, version = 'v1') => async () => ({
  heartbeat: { cacheVersion: version }, teams: TEAMS, fieldSizes: { Open: 48 },
  games: [{ ...GAME, ...over }],
});

// Put the game in play at a given score, with the last point N seconds ago.
async function goLive({ home, away, secondsAgo = 60, eventNum = 5, version = 'v2',
                        capMinutes = 100, minutesIn = 30 }) {
  await sync(store, {
    force: true, now: NOW,
    fetcher: feed({
      status: 'live', ongoing: true, homeScore: home, awayScore: away,
      lastEventNum: eventNum,
      lastEventAt: new Date(NOW - secondsAgo * 1000).toISOString(),
      timerStart: Math.floor((NOW - minutesIn * 60000) / 1000),
      timeCap: capMinutes,
    }, version),
  });
}

beforeEach(async () => {
  store = createStore({ backend: 'sqlite' });
  await store.migrate();
  await sync(store, { force: true, fetcher: feed() });
});

test('a game in progress appears on the live board with a price from the score', async () => {
  await goLive({ home: 10, away: 4 });
  const res = await call('GET', '/api/live');
  assert.equal(res.status, 200);
  assert.equal(res.body.games.length, 1);
  const g = res.body.games[0];
  assert.deepEqual(g.score, { home: 10, away: 4 });
  assert.ok(g.home.prob > 0.9, `10-4 up should be a strong favourite, got ${g.home.prob}`);
  assert.ok(Math.abs(g.home.prob + g.away.prob - 1) < 1e-6);
});

test('the live price tracks the score, not the seeding', async () => {
  await goLive({ home: 2, away: 11, version: 'v3' });
  const behind = (await call('GET', '/api/live')).body.games[0];
  assert.ok(behind.home.prob < 0.1,
    `the better-seeded side at 2-11 down should be nearly gone, got ${behind.home.prob}`);
});

test('the live board says how long until betting reopens', async () => {
  await goLive({ home: 6, away: 6, secondsAgo: 8 });
  const g = (await call('GET', '/api/live')).body.games[0];
  assert.ok(g.suspendedFor > 0 && g.suspendedFor <= 12, `got ${g.suspendedFor}`);
});

test('an in-play bet settles on the final result like any other', async () => {
  await goLive({ home: 3, away: 9 });
  const { userId, cookie } = await punter();
  // 3-9 down, so the engine prices this in play and the price is a long one.
  const bet = await placeBet(store,
    { userId, gameId: 1, side: 'home', stake: 1000, clock: () => NOW });
  assert.equal(bet.inPlay, true);
  await store.query('UPDATE users SET is_admin = TRUE WHERE display_name = $1', ['Russ']);
  await call('POST', '/api/admin/settle',
    { body: { gameId: 1, homeScore: 15, awayScore: 13 }, cookie });

  const [row] = await store.query('SELECT status, payout FROM bets WHERE id = $1', [bet.betId]);
  assert.equal(row.status, 'won', 'the comeback paid');
  assert.ok(row.payout > 3000, `a long live price should pay well, got ${row.payout}`);
});

test('a finished game leaves the live board', async () => {
  await goLive({ home: 14, away: 12 });
  assert.equal((await call('GET', '/api/live')).body.games.length, 1);
  await sync(store, {
    force: true, now: NOW,
    fetcher: feed({ status: 'final', ongoing: false, homeScore: 15, awayScore: 12 }, 'v9'),
  });
  assert.equal((await call('GET', '/api/live')).body.games.length, 0);
});

test('a poll that finds no new point does not re-suspend the market', async () => {
  await goLive({ home: 5, away: 5, secondsAgo: 60 });
  const [before] = await store.query('SELECT last_point_at FROM games WHERE id = 1');
  // Same score arriving again — a routine poll.
  await goLive({ home: 5, away: 5, secondsAgo: 0, version: 'v7' });
  const [after] = await store.query('SELECT last_point_at FROM games WHERE id = 1');
  assert.equal(after.last_point_at, before.last_point_at,
    'the suspension clock must only restart on an actual point');
});

test('the live board is cached only briefly', async () => {
  await goLive({ home: 2, away: 2 });
  const res = await call('GET', '/api/live');
  assert.match(res.headers['Cache-Control'], /s-maxage=5\b/,
    'a stale live price is a wrong price, not merely an old one');
});

test('a game already in progress the first time we see it still shows its score', async () => {
  // Cold database, or a bracket fixture whose teams resolved mid-round: the
  // insert path used to skip the live state entirely and show 0-0.
  const fresh = createStore({ backend: 'sqlite' });
  await fresh.migrate();
  await sync(fresh, {
    force: true, now: NOW,
    fetcher: async () => ({
      heartbeat: { cacheVersion: 'v1' }, teams: TEAMS, fieldSizes: { Open: 48 },
      games: [{ ...GAME, status: 'live', ongoing: true, homeScore: 9, awayScore: 6,
                lastEventNum: 15, lastEventAt: new Date(NOW - 60000).toISOString(),
                timerStart: Math.floor(Date.parse('2026-08-16T14:00:00Z') / 1000), timeCap: 100 }],
    }),
  });
  const [row] = await fresh.query('SELECT live_home_score, live_away_score, last_point_at FROM games WHERE id = 1');
  assert.equal(row.live_home_score, 9);
  assert.equal(row.live_away_score, 6);
  assert.ok(row.last_point_at, 'the suspension clock must be set too');
  fresh.close();
});

test('the live refresh touches only the active feed, not the whole tournament', async () => {
  const { syncLive } = await import('../lib/sync.js');
  await goLive({ home: 5, away: 5, secondsAgo: 60 });

  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    return [{
      id: 1, homeTeamId: 1, awayTeamId: 2, ongoing: true, status: 'live',
      homeScore: 7, awayScore: 5, lastEventNum: 12,
      lastEventAt: new Date(NOW).toISOString(),
      startsAt: '2026-08-16T14:00:00Z', timerStart: null, timeCap: 100, valid: true,
    }];
  };
  const res = await syncLive(store, { fetcher });
  assert.equal(calls, 1, 'exactly one small request');
  assert.equal(res.live, 1);
  assert.equal(res.points, 1);

  const [row] = await store.query('SELECT live_home_score, live_away_score FROM games WHERE id = 1');
  assert.equal(row.live_home_score, 7, 'the score moved without a full sync');
});

test('the live refresh promotes a game the bulk sync still calls scheduled', async () => {
  const fetcher = async () => ([{
    id: 1, homeTeamId: 1, awayTeamId: 2, ongoing: true, status: 'live',
    homeScore: 2, awayScore: 1, lastEventNum: 3,
    lastEventAt: new Date(NOW).toISOString(),
    startsAt: '2026-08-16T14:00:00Z', timerStart: null, timeCap: 100, valid: true,
  }]);
  const { syncLive } = await import('../lib/sync.js');
  await syncLive(store, { fetcher });
  const [row] = await store.query('SELECT status, live_home_score FROM games WHERE id = 1');
  assert.equal(row.status, 'live');
  assert.equal(row.live_home_score, 2);
});

test('the live refresh never touches a settled game', async () => {
  await store.query("UPDATE games SET settled = TRUE, status = 'final' WHERE id = 1");
  const { syncLive } = await import('../lib/sync.js');
  const res = await syncLive(store, { fetcher: async () => ([{
    id: 1, homeTeamId: 1, awayTeamId: 2, ongoing: true, homeScore: 9, awayScore: 9,
    lastEventAt: new Date(NOW).toISOString(), valid: true,
  }]) });
  assert.equal(res.live, 0);
  const [row] = await store.query('SELECT status, live_home_score FROM games WHERE id = 1');
  assert.equal(row.status, 'final');
});

test('the upcoming board reports how many games are in play', async () => {
  const before = await call('GET', '/api/games');
  assert.equal(before.body.liveNow, 0);
  await goLive({ home: 5, away: 3 });
  const after = await call('GET', '/api/games');
  assert.equal(after.body.liveNow, 1, 'so the board can point at them instead of hiding them');
});

test('the live board publishes a probability for both sides, and they sum to one', async () => {
  await goLive({ home: 8, away: 6 });
  const g = (await call('GET', '/api/live')).body.games[0];
  for (const side of ['home', 'away']) {
    assert.equal(typeof g[side].prob, 'number', `${side} must carry a probability`);
  }
  assert.equal(Math.round((g.home.prob + g.away.prob) * 1e4), 1e4,
    'the two sides are the same claim from opposite ends and must not sum to more than one');
  // The decimal price that used to ride alongside is gone with the betting.
  assert.ok(!('decimal' in g.home) && !('decimal' in g.away),
    'a site nobody can bet on has no business quoting a price');
});

test('the live probability stays a probability at every scoreline', async () => {
  // What this replaces: the browser once derived its own odds with no floor,
  // so a side at 96% was shown at 0.96 — a winning bet that lost money. There
  // is no price to get wrong any more, but the number underneath it still has
  // to behave, and a game walked to its extremes is where it would not.
  let version = 100;
  for (const [home, away] of [[14, 0], [14, 2], [14, 13], [10, 4], [7, 7], [2, 11], [0, 14]]) {
    version += 1;
    await goLive({ home, away, version: `v${version}` });
    const g = (await call('GET', '/api/live')).body.games[0];
    for (const side of ['home', 'away']) {
      const p = g[side].prob;
      assert.ok(p >= 0 && p <= 1, `${home}-${away} ${side} probability ${p} is off the scale`);
    }
    assert.equal(Math.round((g.home.prob + g.away.prob) * 1e4), 1e4,
      `${home}-${away} does not sum to one`);
  }
});

test('the live probability follows the score', async () => {
  await goLive({ home: 13, away: 3, version: 'ahead' });
  const ahead = (await call('GET', '/api/live')).body.games[0].home.prob;
  await goLive({ home: 3, away: 13, version: 'behind' });
  const behind = (await call('GET', '/api/live')).body.games[0].home.prob;
  assert.ok(ahead > behind,
    'ten points up must read better than ten points down, whatever the ratings say');
  assert.ok(ahead > 0.9 && behind < 0.1, 'and at 13-3 it should be close to settled');
});

test('the live board marks a game decided the moment the score reaches the target', async () => {
  // 14-8: still live, and the board is still offering it.
  await goLive({ home: 14, away: 8, version: 'd1' });
  const before = (await call('GET', '/api/live')).body.games[0];
  assert.equal(before.decided, false);
  assert.equal(before.target, 15);

  // 15-8: over. The official feed still says the game is in progress, and the
  // winning side is sitting at the 1.02 floor, so a board that keeps showing it
  // as live is showing a certainty as a contest.
  await goLive({ home: 15, away: 8, version: 'd2' });
  const after = (await call('GET', '/api/live')).body.games[0];
  assert.equal(after.decided, true);
});

test('under the time cap a game is not decided until the extra point lands', async () => {
  // Past the cap at 11-9, the target becomes 12: still live, still bettable.
  await goLive({ home: 11, away: 9, version: 'd4', capMinutes: 1, minutesIn: 90 });
  const g = (await call('GET', '/api/live')).body.games[0];
  assert.equal(g.capped, true);
  assert.equal(g.decided, false, `capped to ${g.target}, nobody has reached it`);

  await goLive({ home: 12, away: 9, version: 'd5', capMinutes: 1, minutesIn: 90 });
  const done = (await call('GET', '/api/live')).body.games[0];
  assert.equal(done.decided, true, 'the cap target has now been reached');
});

