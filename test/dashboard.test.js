import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../lib/store.js';
import { handle } from '../lib/router.js';
import { sync, syncGameDetail } from '../lib/sync.js';
import { teamStats, playerLeaders, coverage, concentrationFor } from '../lib/dashboard.js';

const NOW = Date.parse('2026-08-16T18:00:00Z');
let store;

const TEAMS = [
  { id: 1047, name: 'NLSU Yaka', abbreviation: 'YAK', division: "Women's", country: 'France', seed: 16 },
  { id: 1104, name: 'Blueberries', abbreviation: 'BLU', division: "Women's", country: 'New Zealand', seed: 17 },
];

const GAME = {
  id: 1276, homeTeamId: 1047, awayTeamId: 1104, homeLabel: null, awayLabel: null,
  division: "Women's", poolName: 'Pool D', poolId: 4, startsAt: '2026-08-15T14:00:00Z',
  status: 'final', ongoing: false, homeScore: 5, awayScore: 3, valid: true,
};

// The opening of the real game, as the feed serves it.
const goal = (num, time, isHome, scorer, assist, cal = 0) => ({
  num, time, ishomegoal: isHome, scorer, assist, iscallahan: cal,
  scorerfirstname: `S${scorer}`, scorerlastname: 'X',
  assistfirstname: assist ? `A${assist}` : null, assistlastname: assist ? 'Y' : null,
});

const DETAIL = {
  game_result: { game_id: 1276, hometeam: 1047, visitorteam: 1104, halftime: null },
  gameevents: [
    { time: 0, ishome: 1, type: 'offence' },
    { time: 900, ishome: 0, type: 'timeout' },
  ],
  // The real 8-point opening, which finished 5-3. Traced:
  //   P0 Yaka hold   P1 Yaka BREAK   P2 Yaka BREAK   P3 Blue hold
  //   P4 Yaka hold   P5 Blue hold    P6 Yaka hold    P7 Blue hold
  // The Callahan sits on P1 — a Callahan is a block caught in the endzone, so
  // it is necessarily a break, and putting one on a hold would be nonsense.
  goals: [
    goal(0, 200, 1, 2160, 2144),      // Yaka hold
    goal(1, 330, 1, 2160, null, 1),   // Yaka BREAK, a Callahan (no assist by definition)
    goal(2, 635, 1, 2149, 2160),      // Yaka BREAK
    goal(3, 855, 0, 3478, 3482),      // Blue hold
    goal(4, 1105, 1, 2149, 2160),     // Yaka hold
    goal(5, 1250, 0, 3472, 3474),     // Blue hold
    goal(6, 1425, 1, 2144, 2149),     // Yaka hold
    goal(7, 2100, 0, 3481, 3474),     // Blue hold
  ],
};

const call = (method, url) =>
  handle({ method, url, headers: {} }, { store, now: NOW, autoSync: false });

beforeEach(async () => {
  store = createStore({ backend: 'sqlite' });
  await store.migrate();
  await sync(store, {
    force: true, now: NOW,
    fetcher: async () => ({
      heartbeat: { cacheVersion: 'v1' }, teams: TEAMS,
      fieldSizes: { "Women's": 40 }, games: [GAME],
    }),
  });
  await store.query('UPDATE games SET settled = TRUE WHERE id = 1276');
  await syncGameDetail(store, { fetcher: async () => DETAIL });
});

test('ingest writes one row per point and marks the game done', async () => {
  const rows = await store.query('SELECT * FROM points ORDER BY num');
  assert.equal(rows.length, 8);
  const [g] = await store.query('SELECT detail_synced, start_offence FROM games WHERE id = 1276');
  assert.ok(g.detail_synced);
  assert.equal(g.start_offence, 'home');
});

test('a second run does not re-ingest or double-count', async () => {
  const again = await syncGameDetail(store, { fetcher: async () => DETAIL });
  assert.equal(again.pending, 0, 'the game is already marked done');
  const rows = await store.query('SELECT COUNT(*) AS n FROM points');
  assert.equal(Number(rows[0].n), 8);
});

test('breaks and holds come out of the possession chain', async () => {
  const rows = await teamStats(store);
  const yaka = rows.find((r) => r.teamId === 1047);
  const blue = rows.find((r) => r.teamId === 1104);

  assert.equal(yaka.breaks, 2);
  assert.equal(blue.breaks, 0, 'Blueberries never took a point off Yaka offence');
  // Every point is somebody's offence and somebody's defence.
  assert.equal(yaka.oPoints + yaka.dPoints, 8);
  assert.equal(blue.oPoints + blue.dPoints, 8);
  assert.equal(yaka.oPoints, blue.dPoints);
  // Holds plus breaks equals the final score, for both sides.
  assert.equal(yaka.holds + yaka.breaks, 5);
  assert.equal(blue.holds + blue.breaks, 3);
});

test('rates are reported next to counts, because counts flatter the loser', async () => {
  const rows = await teamStats(store);
  const yaka = rows.find((r) => r.teamId === 1047);
  assert.equal(yaka.breakPct, Math.round((yaka.breaks / yaka.dPoints) * 1000) / 10);
  assert.equal(yaka.holdPct, Math.round((yaka.holds / yaka.oPoints) * 1000) / 10);
  assert.ok(yaka.breakPct >= 0 && yaka.breakPct <= 100);
});

test('time on offence and defence covers the whole game between the two sides', async () => {
  const rows = await teamStats(store);
  const yaka = rows.find((r) => r.teamId === 1047);
  const blue = rows.find((r) => r.teamId === 1104);
  // Each point's clock is charged to exactly one offence and one defence.
  assert.equal(yaka.oTime + yaka.dTime, blue.oTime + blue.dTime);
  assert.equal(yaka.oTime, blue.dTime);
  assert.equal(yaka.dTime, blue.oTime);
  assert.equal(yaka.oTime + yaka.dTime, 2100, 'the full elapsed game');
  // Yaka received only 3 of 8 points, so they spent most of the game on D.
  assert.equal(yaka.oPoints, 3);
  assert.equal(yaka.dPoints, 5);
  assert.equal(yaka.oTime, 625);
});

test('seconds per hold measures only the points a team actually held', async () => {
  const rows = await teamStats(store);
  const yaka = rows.find((r) => r.teamId === 1047);
  // Yaka held P0 (200s), P4 (250s) and P6 (175s): mean 208.
  assert.equal(yaka.secondsPerHold, 208);
});

test('a Callahan is credited to the team that scored it', async () => {
  const rows = await teamStats(store);
  assert.equal(rows.find((r) => r.teamId === 1047).callahans, 1);
  assert.equal(rows.find((r) => r.teamId === 1104).callahans, 0);
});

test('timeout conversion records whether the caller won the next point', async () => {
  const rows = await teamStats(store);
  const blue = rows.find((r) => r.teamId === 1104);
  assert.equal(blue.timeouts, 1);
  // Blueberries called at 900s; the next goal, at 1105s, was Yaka's.
  assert.equal(blue.timeoutConversion, 0);
});

test('scoring concentration is null until there is enough of it to mean anything', () => {
  assert.equal(concentrationFor([{ total: 3 }, { total: 2 }]), null);
  const spread = [4, 4, 4, 4, 4, 4].map((total) => ({ total }));
  const starry = [10, 8, 6, 1, 1].map((total) => ({ total }));
  assert.ok(concentrationFor(starry) > concentrationFor(spread),
    'a team leaning on three players must score higher than one spreading it around');
});

test('player leaders separate goals from assists', async () => {
  const { goals, assists, combined } = await playerLeaders(store);
  assert.equal(goals[0].goals, 2);
  assert.ok(assists[0].assists >= 2);
  assert.ok(combined[0].total >= combined[1].total, 'sorted');
  assert.ok(combined[0].team, 'a leader without a club is useless on a page');
});

test('coverage is reported so nobody reads a partial table as the whole truth', async () => {
  const c = await coverage(store);
  assert.equal(c.playedGames, 1);
  assert.equal(c.ingestedGames, 1);
  assert.equal(c.pendingGames, 0);
  assert.equal(c.points, 8);
  assert.equal(c.anchoredPct, 100);
});

test('a game with no opening marker loses only the points that depend on it', async () => {
  const other = { ...GAME, id: 1277 };
  await sync(store, {
    force: true, now: NOW,
    fetcher: async () => ({
      heartbeat: { cacheVersion: 'v2' }, teams: TEAMS,
      fieldSizes: { "Women's": 40 }, games: [other],
    }),
  });
  await store.query('UPDATE games SET settled = TRUE WHERE id = 1277');
  await syncGameDetail(store, {
    fetcher: async () => ({ ...DETAIL, game_result: { ...DETAIL.game_result, game_id: 1277 },
                            gameevents: [] }),
  });

  // Only the first point of each half needs the opening pull; the rest of the
  // game follows from who scored the point before.
  const [anch] = await store.query(
    'SELECT COUNT(*) AS n FROM points WHERE game_id = 1277 AND anchored = TRUE');
  const [tot] = await store.query('SELECT COUNT(*) AS n FROM points WHERE game_id = 1277');
  assert.ok(Number(anch.n) > 0, 'most of an unmarked game is still usable');
  assert.ok(Number(anch.n) < Number(tot.n), 'but not all of it');

  // So the unmarked game does now contribute breaks, unlike before.
  const rows = await teamStats(store);
  assert.ok(rows.find((r) => r.teamId === 1047).breaks >= 2);
  // But its goals still count toward the player leaderboard.
  const { goals } = await playerLeaders(store);
  assert.equal(goals[0].goals, 4, 'two games worth of scoring');

  const c = await coverage(store);
  assert.ok(c.anchoredPct > 50 && c.anchoredPct < 100,
    'coverage sits between: most points usable, a couple not');
});

test('the stats endpoint serves teams, players and coverage together', async () => {
  const res = await call('GET', '/api/stats');
  assert.equal(res.status, 200);
  assert.ok(res.body.teams.length);
  assert.ok(res.body.players.combined.length);
  assert.ok(res.body.coverage.points);
  assert.match(res.headers['Cache-Control'], /s-maxage/,
    'identical for every viewer, so it must be shared-cacheable');
});

test('the endpoint filters by division', async () => {
  const hit = await call('GET', "/api/stats?division=Women's");
  assert.ok(hit.body.teams.length);
  const miss = await call('GET', '/api/stats?division=Open');
  assert.equal(miss.body.teams.length, 0);
});

test('a detail fetch that fails leaves the game to be retried', async () => {
  const other = { ...GAME, id: 1278 };
  await sync(store, {
    force: true, now: NOW,
    fetcher: async () => ({
      heartbeat: { cacheVersion: 'v3' }, teams: TEAMS,
      fieldSizes: { "Women's": 40 }, games: [other],
    }),
  });
  await store.query('UPDATE games SET settled = TRUE WHERE id = 1278');

  const bad = await syncGameDetail(store, {
    fetcher: async () => { throw new Error('502 from the feed'); },
  });
  assert.equal(bad.ingested, 0);
  assert.equal(bad.failures.length, 1);
  const [g] = await store.query('SELECT detail_synced FROM games WHERE id = 1278');
  assert.ok(!g.detail_synced, 'a transient failure must not write the game off forever');
});

test('a game nobody bet on still reaches the dashboard', async () => {
  // The ingest used to require `settled`, which is a fact about the betting
  // engine, not about the game. Most of the tournament has no bets on it.
  const unbet = { ...GAME, id: 1279 };
  await sync(store, {
    force: true, now: NOW,
    fetcher: async () => ({
      heartbeat: { cacheVersion: 'v9' }, teams: TEAMS,
      fieldSizes: { "Women's": 40 }, games: [unbet],
    }),
  });
  const [before] = await store.query('SELECT settled FROM games WHERE id = 1279');
  assert.ok(!before.settled, 'no bets, so never settled');

  const res = await syncGameDetail(store, {
    fetcher: async () => ({ ...DETAIL, game_result: { ...DETAIL.game_result, game_id: 1279 } }),
  });
  assert.equal(res.ingested, 1, 'a result is a result whether or not money was on it');
  const c = await coverage(store);
  assert.equal(c.playedGames, 2);
  assert.equal(c.ingestedGames, 2);
});

test('a fixture with no result yet is not ingested', async () => {
  const future = { ...GAME, id: 1280, status: 'scheduled', homeScore: null, awayScore: null };
  await sync(store, {
    force: true, now: NOW,
    fetcher: async () => ({
      heartbeat: { cacheVersion: 'v10' }, teams: TEAMS,
      fieldSizes: { "Women's": 40 }, games: [future],
    }),
  });
  let asked = 0;
  await syncGameDetail(store, { fetcher: async () => { asked += 1; return DETAIL; } });
  assert.equal(asked, 0, 'nothing to derive from a game that has not been played');
});

test('the ingest runs on a tick even when the feed sync is not due', async () => {
  // The bug: ?backfill=1 was wired behind the sync's rate limit, so on any
  // tick that returned "not due" — two in three, with a pinger every minute —
  // it silently did nothing.
  const pending = { ...GAME, id: 1281 };
  await sync(store, {
    force: true, now: NOW,
    fetcher: async () => ({
      heartbeat: { cacheVersion: 'v11' }, teams: TEAMS,
      fieldSizes: { "Women's": 40 }, games: [pending],
    }),
  });

  // Put the sync clock right up to date so the next tick is certainly not due.
  await store.query(
    `INSERT INTO meta (key, value) VALUES ('last_sync_attempt', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1`,
    [new Date(NOW).toISOString()]
  );

  const res = await handle(
    { method: 'GET', url: '/api/tick?backfill=1', headers: {} },
    { store, now: NOW,
      detailFetcher: async () => ({ ...DETAIL,
        game_result: { ...DETAIL.game_result, game_id: 1281 } }) }
  );
  assert.equal(res.body.reason, 'not due', 'the feed sync is correctly held off');
  assert.ok(res.body.detail, 'but the ingest still reports');
  assert.equal(res.body.detail.ingested, 1, 'and still did the work');

  const [g] = await store.query('SELECT detail_synced FROM games WHERE id = 1281');
  assert.ok(g.detail_synced);
});

test('a shutout is a fine break sample and a useless hold sample', async () => {
  // Fury beat their opponent 15-0. Received the first point and held it, then
  // broke fourteen times without ever receiving again. That is 14 defensive
  // points — a real break sample — and exactly 1 offensive point.
  //
  // The old rule gated on total points played, so a 15-0 (15 points) fell
  // below a 20-point threshold while a 15-13 grind (28 points) sailed past.
  // It punished dominance: the more completely you win, the less you play.
  const shutout = { ...GAME, id: 1290, homeScore: 15, awayScore: 0 };
  await sync(store, {
    force: true, now: NOW,
    fetcher: async () => ({
      heartbeat: { cacheVersion: 'v12' }, teams: TEAMS,
      fieldSizes: { "Women's": 40 }, games: [shutout],
    }),
  });

  const goals = [goal(0, 100, 1, 2160, 2144)];
  for (let n = 1; n < 15; n += 1) goals.push(goal(n, 100 + n * 120, 1, 2160, 2144));
  await syncGameDetail(store, {
    fetcher: async () => ({
      game_result: { game_id: 1290, hometeam: 1047, visitorteam: 1104, halftime: null },
      gameevents: [{ time: 0, ishome: 1, type: 'offence' }],
      goals,
    }),
  });

  const rows = await teamStats(store, { division: "Women's" });
  const yaka = rows.find((r) => r.teamId === 1047);

  // Both games are in, so add the shutout's 14 breaks to the opener's 2.
  assert.equal(yaka.breaks, 16);
  assert.equal(yaka.dPoints, 19, '5 from the first game, 14 from the shutout');
  assert.ok(yaka.dPoints >= 10, 'plenty to judge a break rate on');

  // And the whole-team measure that used to gate this is gone entirely: no
  // single flag can call the same club reliable on breaks and unreliable on
  // holds, which is exactly what a shutout demands.
  assert.equal(yaka.reliable, undefined);
});

test('a game with no anchor is reported as untraced, not silently dropped', async () => {
  // Fury played twice: a 15-0 with an opening-offence marker, and a 15-13 with
  // none. The second contributes goals but no breaks. A row reading "1 game"
  // with nothing else said is a wrong statement about the data, not a gap.
  const second = { ...GAME, id: 1295 };
  await sync(store, {
    force: true, now: NOW,
    fetcher: async () => ({
      heartbeat: { cacheVersion: 'v13' }, teams: TEAMS,
      fieldSizes: { "Women's": 40 }, games: [second],
    }),
  });
  await syncGameDetail(store, {
    fetcher: async () => ({ ...DETAIL,
      game_result: { ...DETAIL.game_result, game_id: 1295 }, gameevents: [] }),
  });

  const rows = await teamStats(store, { division: "Women's" });
  const yaka = rows.find((r) => r.teamId === 1047);
  // The unmarked game now contributes most of its points, so it counts as a
  // game played — with the two anchor-dependent points flagged separately.
  assert.equal(yaka.games, 2, 'both games contribute usable points now');
  assert.ok(yaka.gamesUntraced >= 1, 'and the partial one is still declared');
});

test('O and D time are reported per point as well as in total', async () => {
  const rows = await teamStats(store, { division: "Women's" });
  const yaka = rows.find((r) => r.teamId === 1047);
  assert.ok(yaka.oClockN > 0 && yaka.dClockN > 0, 'clocked points are counted separately');
  assert.equal(yaka.oSecsPerPoint, Math.round(yaka.oTime / yaka.oClockN));
  assert.equal(yaka.dSecsPerPoint, Math.round(yaka.dTime / yaka.dClockN));
  // The totals survive — they just stop being the headline, because a total
  // mostly measures how many games a club has played.
  assert.ok(yaka.oTime > 0 && yaka.dTime > 0);
});
