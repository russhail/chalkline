import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../lib/store.js';
import { sync, openGames, gameDays, getMeta } from '../lib/sync.js';
import { placeBet } from '../lib/betting.js';

let store;
beforeEach(async () => {
  store = createStore({ backend: 'sqlite' });
  await store.migrate();
});

const TEAMS = [
  { id: 1131, name: 'Colony', abbreviation: 'COL', division: 'Open', country: 'Australia', seed: 1 },
  { id: 1109, name: 'Aethers Warsaw', abbreviation: 'AEW', division: 'Open', country: 'Poland', seed: 44 },
  { id: 1200, name: 'Fusion', abbreviation: 'FUS', division: "Women's", country: 'Australia', seed: 2 },
];
const FIELD_SIZES = { Open: 48, "Women's": 40 };

const game = (over) => ({
  id: 1, homeTeamId: 1131, awayTeamId: 1109, homeLabel: null, awayLabel: null,
  division: 'Open', poolName: 'Pool A', startsAt: '2026-08-16T14:00:00Z',
  status: 'scheduled', homeScore: null, awayScore: null, valid: true, ...over,
});

const feed = (games, version = 'v1') => async () => ({
  heartbeat: { cacheVersion: version }, teams: TEAMS, fieldSizes: FIELD_SIZES, games,
});

test('first sync loads teams and games and seeds ratings from the WFDF seed', async () => {
  const res = await sync(store, { force: true, fetcher: feed([game()]) });
  assert.equal(res.teams.created, 3);
  assert.equal(res.games.created, 1);

  const [top] = await store.query('SELECT * FROM teams WHERE id = 1131');
  const [bottom] = await store.query('SELECT * FROM teams WHERE id = 1109');
  assert.ok(top.rating > bottom.rating, 'seed 1 must start rated above seed 44');
  assert.equal(top.played, 0);
});

test('a second sync with the same data creates nothing new', async () => {
  await sync(store, { force: true, fetcher: feed([game()]) });
  const res = await sync(store, { force: true, fetcher: feed([game()]) });
  assert.equal(res.teams.created, 0);
  assert.equal(res.games.created, 0);
  const rows = await store.query('SELECT COUNT(*) AS n FROM games');
  assert.equal(Number(rows[0].n), 1);
});

test('an unchanged heartbeat short-circuits the whole sync', async () => {
  await sync(store, { force: true, fetcher: feed([game()], 'abc') });
  assert.equal(await getMeta(store, 'cache_version'), 'abc');
});

test('re-syncing never resets a rating the model has learned', async () => {
  await sync(store, { force: true, fetcher: feed([game()]) });
  await store.query('UPDATE teams SET rating = 1888, rd = 90, played = 4 WHERE id = 1131');
  await sync(store, { force: true, fetcher: feed([game()], 'v2') });
  const [t] = await store.query('SELECT rating, rd, played FROM teams WHERE id = 1131');
  assert.equal(t.rating, 1888);
  assert.equal(t.played, 4);
});

test('a final score in the feed settles the game and pays out', async () => {
  await sync(store, { force: true, fetcher: feed([game()]) });
  await store.query(
    `INSERT INTO users (display_name,recovery_hash,created_at)
     VALUES ('Russ','x','2026-08-15T00:00:00Z')`
  );
  const bet = await placeBet(store, {
    userId: 1, gameId: 1, side: 'home', stake: 1000,
    clock: () => Date.parse('2026-08-16T10:00:00Z'),
  });

  const res = await sync(store, {
    force: true,
    fetcher: feed([game({ status: 'final', homeScore: 15, awayScore: 8 })], 'v2'),
  });
  assert.equal(res.settled, 1);

  const [u] = await store.query('SELECT bankroll FROM users WHERE id = 1');
  assert.equal(u.bankroll, Math.round((9000 + 1000 * bet.odds) * 100) / 100);
  const [g] = await store.query('SELECT settled, home_score FROM games WHERE id = 1');
  assert.equal(Boolean(g.settled), true);
  assert.equal(g.home_score, 15);
});

test('a level score is flagged for the admin, never auto-settled', async () => {
  await sync(store, { force: true, fetcher: feed([game()]) });
  const res = await sync(store, {
    force: true,
    fetcher: feed([game({ status: 'final', homeScore: 14, awayScore: 14 })], 'v2'),
  });
  assert.equal(res.settled, 0);
  assert.equal(res.needsAttention.length, 1);
  assert.match(res.needsAttention[0].reason, /level score/);
});

test('a bracket placeholder becomes bettable once its teams resolve', async () => {
  const placeholder = game({
    id: 900, homeTeamId: 0, awayTeamId: 0,
    homeLabel: 'Winner Pool A', awayLabel: 'Winner Pool B',
    startsAt: '2026-08-20T10:00:00Z', poolName: 'Quarterfinal',
  });
  // A wide horizon here: this test is about placeholders resolving, not about
  // how far ahead the board looks.
  const wide = { now: Date.parse('2026-08-16T00:00:00Z'), day: '2026-08-20' };
  await sync(store, { force: true, fetcher: feed([placeholder]) });
  let open = await openGames(store, wide);
  assert.equal(open.length, 0, 'placeholders must not be bettable');

  await sync(store, {
    force: true,
    fetcher: feed([{ ...placeholder, homeTeamId: 1131, awayTeamId: 1109 }], 'v2'),
  });
  open = await openGames(store, wide);
  assert.equal(open.length, 1);
  assert.equal(open[0].home_name, 'Colony');
});

test('a settled game is never overwritten by a later sync', async () => {
  await sync(store, { force: true, fetcher: feed([game()]) });
  await sync(store, {
    force: true,
    fetcher: feed([game({ status: 'final', homeScore: 15, awayScore: 8 })], 'v2'),
  });
  await sync(store, {
    force: true,
    fetcher: feed([game({ status: 'scheduled', homeScore: null, awayScore: null })], 'v3'),
  });
  const [g] = await store.query('SELECT status, home_score, settled FROM games WHERE id = 1');
  assert.equal(g.status, 'final');
  assert.equal(g.home_score, 15);
});

test('open games are ordered by kickoff and exclude anything already started', async () => {
  const games = [
    game({ id: 1, startsAt: '2026-08-16T18:00:00Z' }),
    game({ id: 2, startsAt: '2026-08-16T09:00:00Z' }),
    game({ id: 3, startsAt: '2026-08-16T13:00:00Z' }),
  ];
  await sync(store, { force: true, fetcher: feed(games) });
  const open = await openGames(store, { now: Date.parse('2026-08-16T12:00:00Z') });
  assert.deepEqual(open.map((g) => g.id), [3, 1]);
});

// --- pool score checking and forfeits ---------------------------------------

import { poolsNeedingScores } from '../lib/sync.js';

const poolFeed = (games, version = 'v1') => async () => ({
  heartbeat: { cacheVersion: version }, teams: TEAMS, fieldSizes: FIELD_SIZES, games,
});

test('only pools with kicked-off, unsettled games are checked for scores', async () => {
  const games = [
    { ...game({ id: 10, startsAt: '2026-08-16T09:00:00Z' }), poolId: 100 },
    { ...game({ id: 11, startsAt: '2026-08-16T20:00:00Z' }), poolId: 200 },
  ];
  await sync(store, { force: true, fetcher: poolFeed(games), now: Date.parse('2026-08-16T00:00:00Z') });

  const midday = await poolsNeedingScores(store, { now: Date.parse('2026-08-16T12:00:00Z') });
  assert.deepEqual(midday, [100], 'the evening pool has not kicked off yet');

  const evening = await poolsNeedingScores(store, { now: Date.parse('2026-08-16T21:00:00Z') });
  assert.deepEqual(evening.sort(), [100, 200]);
});

test('a settled pool stops being polled', async () => {
  const games = [{ ...game({ id: 10, startsAt: '2026-08-16T09:00:00Z' }), poolId: 100 }];
  await sync(store, { force: true, fetcher: poolFeed(games), now: Date.parse('2026-08-16T00:00:00Z') });
  await sync(store, {
    force: true, now: Date.parse('2026-08-16T12:00:00Z'),
    fetcher: poolFeed([{ ...games[0], status: 'final', homeScore: 15, awayScore: 6 }], 'v2'),
  });
  const after = await poolsNeedingScores(store, { now: Date.parse('2026-08-16T12:00:00Z') });
  assert.deepEqual(after, []);
});

test('a forfeit is flagged for the admin rather than auto-settled', async () => {
  const g = { ...game({ id: 10, startsAt: '2026-08-16T09:00:00Z' }), poolId: 100 };
  await sync(store, { force: true, fetcher: poolFeed([g]), now: Date.parse('2026-08-16T00:00:00Z') });
  await store.query(
    `INSERT INTO users (display_name,recovery_hash,created_at)
     VALUES ('Russ','x','2026-08-15T00:00:00Z')`
  );
  await placeBet(store, { userId: 1, gameId: 10, side: 'home', stake: 1000,
    clock: () => Date.parse('2026-08-16T08:00:00Z') });

  const res = await sync(store, {
    force: true, now: Date.parse('2026-08-16T12:00:00Z'),
    fetcher: poolFeed([{ ...g, status: 'final', homeScore: 15, awayScore: 0, forfeit: true }], 'v2'),
  });

  assert.equal(res.settled, 0, 'a forfeit must not settle itself');
  assert.match(res.needsAttention[0].reason, /forfeit/);

  const [row] = await store.query('SELECT settled, needs_review FROM games WHERE id = 10');
  assert.equal(Boolean(row.settled), false);
  assert.match(row.needs_review, /forfeit/);

  const [u] = await store.query('SELECT bankroll FROM users WHERE id = 1');
  assert.equal(u.bankroll, 9000, 'the stake stays held until the admin rules on it');
});

test('an unchanged heartbeat is ignored while a kicked-off game is unsettled', async () => {
  // Trusting the heartbeat here would mean never settling if WFDF's global
  // cache version doesn't tick when a pool score is entered — a silent
  // failure where the site looks healthy and simply never pays out.
  const g = { ...game({ id: 10, startsAt: '2026-08-16T09:00:00Z' }), poolId: 100 };
  await sync(store, { force: true, fetcher: poolFeed([g]), now: Date.parse('2026-08-16T00:00:00Z') });

  let fetched = 0;
  const fetcher = async (opts) => {
    fetched += 1;
    return {
      heartbeat: { cacheVersion: 'v1' }, teams: TEAMS, fieldSizes: FIELD_SIZES,
      games: [{ ...g, status: 'final', homeScore: 15, awayScore: 9 }],
      requestedPools: opts?.poolsNeedingScores,
    };
  };
  const res = await sync(store, { fetcher, now: Date.parse('2026-08-16T12:00:00Z') });

  assert.equal(res.skipped, false, 'must not short-circuit with a game outstanding');
  assert.equal(fetched, 1, 'the feed should have been pulled');
  assert.equal(res.settled, 1);
});

test('with nothing outstanding, an unchanged heartbeat still short-circuits', async () => {
  const g = { ...game({ id: 10, startsAt: '2026-08-20T09:00:00Z' }), poolId: 100 };
  await sync(store, { force: true, fetcher: poolFeed([g], 'v9'), now: Date.parse('2026-08-16T00:00:00Z') });

  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ cache_version: 'v9' }) });
  try {
    const res = await sync(store, {
      fetcher: poolFeed([g], 'v9'), now: Date.parse('2026-08-16T12:00:00Z'),
    });
    assert.equal(res.skipped, true, 'nothing has kicked off, so the cheap path applies');
  } finally { globalThis.fetch = original; }
});

test('the pools passed to the feed are exactly the ones awaiting a result', async () => {
  const games = [
    { ...game({ id: 10, startsAt: '2026-08-16T09:00:00Z' }), poolId: 100 },
    { ...game({ id: 11, startsAt: '2026-08-16T22:00:00Z' }), poolId: 200 },
  ];
  await sync(store, { force: true, fetcher: poolFeed(games), now: Date.parse('2026-08-16T00:00:00Z') });

  let requested = null;
  const fetcher = async (opts) => {
    requested = opts?.poolsNeedingScores;
    return { heartbeat: { cacheVersion: 'v2' }, teams: TEAMS, fieldSizes: FIELD_SIZES, games };
  };
  await sync(store, { force: true, fetcher, now: Date.parse('2026-08-16T12:00:00Z') });
  assert.deepEqual(requested, [100], 'only the pool that has started should be polled');
});

test('a live game is never settled, however convincing its score', async () => {
  // This is exactly what happened in production: the standings file published
  // 9-12 for a match still being played, and it was settled at that score.
  const g = { ...game({ id: 1074, startsAt: '2026-08-16T09:00:00Z' }), poolId: 1020 };
  await sync(store, { force: true, fetcher: poolFeed([g]), now: Date.parse('2026-08-16T00:00:00Z') });
  await store.query(
    `INSERT INTO users (display_name,recovery_hash,created_at)
     VALUES ('Russ','x','2026-08-15T00:00:00Z')`
  );
  await placeBet(store, { userId: 1, gameId: 1074, side: 'home', stake: 1000,
    clock: () => Date.parse('2026-08-16T08:00:00Z') });

  const res = await sync(store, {
    force: true, now: Date.parse('2026-08-16T10:00:00Z'),
    fetcher: poolFeed([{ ...g, status: 'live', ongoing: true, homeScore: 9, awayScore: 12 }], 'v2'),
  });

  assert.equal(res.settled, 0, 'a running game must not settle');
  const [row] = await store.query('SELECT settled, status FROM games WHERE id = 1074');
  assert.equal(Boolean(row.settled), false);
  const [bet] = await store.query('SELECT status FROM bets WHERE game_id = 1074');
  assert.equal(bet.status, 'open', 'the bet stays open until the game actually ends');

  // ...and once it really is over, at a different score, it settles properly.
  const done = await sync(store, {
    force: true, now: Date.parse('2026-08-16T11:00:00Z'),
    fetcher: poolFeed([{ ...g, status: 'final', ongoing: false, homeScore: 15, awayScore: 13 }], 'v3'),
  });
  assert.equal(done.settled, 1);
  const [after] = await store.query('SELECT home_score, away_score FROM games WHERE id = 1074');
  assert.equal(after.home_score, 15, 'settled on the final score, not the running one');
});

test('the board serves one day at a time', async () => {
  const games = [
    game({ id: 1, startsAt: '2026-08-16T12:00:00Z' }),
    game({ id: 2, startsAt: '2026-08-16T18:00:00Z' }),
    game({ id: 3, startsAt: '2026-08-17T12:00:00Z' }),
    game({ id: 4, startsAt: '2026-08-22T12:00:00Z' }),
  ];
  await sync(store, { force: true, fetcher: feed(games), now: Date.parse('2026-08-16T00:00:00Z') });
  const now = Date.parse('2026-08-16T06:00:00Z');
  assert.deepEqual((await openGames(store, { now, day: '2026-08-16' })).map((g) => g.id), [1, 2]);
  assert.deepEqual((await openGames(store, { now, day: '2026-08-17' })).map((g) => g.id), [3]);
  assert.deepEqual((await openGames(store, { now, day: '2026-08-22' })).map((g) => g.id), [4],
    'every known day is reachable, however far ahead');
});

test('the day index counts every known fixture without fetching them', async () => {
  const games = [
    game({ id: 1, startsAt: '2026-08-16T12:00:00Z' }),
    game({ id: 2, startsAt: '2026-08-16T18:00:00Z' }),
    game({ id: 3, startsAt: '2026-08-17T12:00:00Z' }),
    game({ id: 4, startsAt: '2026-08-22T12:00:00Z' }),
    // A bracket fixture with no teams yet: not a known game, so not counted.
    game({ id: 5, startsAt: '2026-08-21T12:00:00Z', homeTeamId: 0, awayTeamId: 0 }),
  ];
  await sync(store, { force: true, fetcher: feed(games), now: Date.parse('2026-08-16T00:00:00Z') });
  const days = await gameDays(store, { now: Date.parse('2026-08-16T06:00:00Z') });
  assert.deepEqual(days, [
    { day: '2026-08-16', games: 2 },
    { day: '2026-08-17', games: 1 },
    { day: '2026-08-22', games: 1 },
  ]);
});

test('a day that has already been played drops off the index', async () => {
  const games = [
    game({ id: 1, startsAt: '2026-08-16T12:00:00Z' }),
    game({ id: 2, startsAt: '2026-08-17T12:00:00Z' }),
  ];
  await sync(store, { force: true, fetcher: feed(games), now: Date.parse('2026-08-16T00:00:00Z') });
  const days = await gameDays(store, { now: Date.parse('2026-08-16T18:00:00Z') });
  assert.deepEqual(days.map((d) => d.day), ['2026-08-17']);
});

test('the board query returns only the columns the board needs', async () => {
  await sync(store, { force: true, fetcher: feed([game()]), now: Date.parse('2026-08-16T00:00:00Z') });
  const [row] = await openGames(store, { now: Date.parse('2026-08-16T06:00:00Z') });
  // Egress is metered, so anything not rendered should not be fetched.
  for (const unused of ['void_reason', 'needs_review', 'rated', 'home_label', 'settled']) {
    assert.ok(!(unused in row), `${unused} is not used by the board and should not be selected`);
  }
});
