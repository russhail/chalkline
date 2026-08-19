import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../lib/store.js';
import { handle } from '../lib/router.js';
import { sync, syncGameDetail } from '../lib/sync.js';
import { teamStats, playerLeaders, coverage, concentrationFor,
         relianceFor, comboLeaders, teamProfile, median, dShapeFor,
         playerTallies } from '../lib/dashboard.js';

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
  // This used to assert the game was NOT settled, which quietly encoded a bug:
  // a game already final the first time it is seen skipped the settlement check
  // on the insert path, so it stayed unrated and the model never learned from
  // it. It settles now. What this test is actually about is unchanged — the
  // ingest must not care whether anyone had money on the game.
  const [{ n: betsOn } = {}] = await store.query(
    'SELECT COUNT(*) AS n FROM bets WHERE game_id = 1279');
  assert.equal(Number(betsOn), 0, 'nobody backed it');

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

// --- D point length, split by outcome ---------------------------------------
//
// The single dSecsPerPoint average was the mean of two opposite virtues, so a
// ruthless defence and a leaky one could land on the same number by opposite
// routes. These pin the two halves apart.

test('time to break and time to be held are separated, and still sum to D time', async () => {
  const rows = await teamStats(store);
  const yaka = rows.find((r) => r.teamId === 1047);
  // Yaka broke on P1 (130s) and P2 (305s): mean 217.5, rounded 218.
  assert.equal(yaka.secondsPerBreak, 218);
  // Yaka were held on P3 (220s), P5 (145s) and P7 (675s): mean 346.7 -> 347.
  assert.equal(yaka.secondsPerConcededHold, 347);
  // Nothing is lost or double-counted in the split.
  assert.equal(yaka.breakTime + yaka.concededTime, yaka.dTime);
  assert.equal(yaka.breakClockN + yaka.concededClockN, yaka.dClockN);
});

test('a team that never broke reports no time-to-break rather than a zero', async () => {
  const rows = await teamStats(store);
  const blue = rows.find((r) => r.teamId === 1104);
  assert.equal(blue.breaks, 0);
  // Zero would sort as the fastest break in the tournament. Null is the truth.
  assert.equal(blue.secondsPerBreak, null);
  assert.equal(blue.breakClockN, 0);
});

test('one side taking time to hold is the other side taking time to be held', async () => {
  const rows = await teamStats(store);
  const yaka = rows.find((r) => r.teamId === 1047);
  const blue = rows.find((r) => r.teamId === 1104);
  // The same three points seen from both ends of the field: Yaka held P0, P4
  // and P6, which are exactly the points Blueberries failed to break.
  assert.equal(yaka.secondsPerHold, blue.secondsPerConcededHold);
  assert.equal(yaka.holdTime, blue.concededTime);
});

// --- star reliance, split three ways ----------------------------------------

test('goal reliance and assist reliance are different numbers about different risks', () => {
  // One handler throwing nearly everything, six people finishing it. Pooled
  // into goals-plus-assists this looks like an ordinary spread-out side.
  const squad = [
    { name: 'Handler', goals: 1, assists: 11, total: 12 },
    { name: 'Cutter A', goals: 5, assists: 1, total: 6 },
    { name: 'Cutter B', goals: 4, assists: 0, total: 4 },
    { name: 'Cutter C', goals: 3, assists: 0, total: 3 },
    { name: 'Cutter D', goals: 2, assists: 0, total: 2 },
    { name: 'Cutter E', goals: 1, assists: 0, total: 1 },
  ];
  const r = relianceFor(squad);
  assert.equal(r.goals.rate, 75);      // top three of 16 goals
  assert.equal(r.assists.rate, 100);   // every assist came from two people
  assert.equal(r.total.rate, 78.6);
  // The combined figure sits between the two and hides the thing worth knowing.
  assert.ok(r.assists.rate > r.total.rate && r.total.rate > r.goals.rate,
    'the combined number conceals a side whose throwing is entirely two players');
});

test('contributors counts the people who did that particular thing', () => {
  const squad = [
    { name: 'Handler', goals: 1, assists: 11, total: 12 },
    { name: 'Cutter A', goals: 5, assists: 1, total: 6 },
    { name: 'Cutter B', goals: 4, assists: 0, total: 4 },
    { name: 'Cutter C', goals: 3, assists: 0, total: 3 },
    { name: 'Cutter D', goals: 2, assists: 0, total: 2 },
    { name: 'Cutter E', goals: 1, assists: 0, total: 1 },
  ];
  const r = relianceFor(squad);
  assert.equal(r.goals.contributors, 6);
  // Not 6. Only two people in this squad have ever thrown an assist, and
  // reporting six would make the tail look three times deeper than it is.
  assert.equal(r.assists.contributors, 2);
  assert.equal(r.assists.names.length, 2, 'no padding with players on zero');
});

test('each key is gated on its own volume, so half the sample earns half the confidence', () => {
  // Eleven goals and eleven assists: 22 contributions, so the combined view
  // clears the 12 gate while neither single-key view does.
  const squad = [
    { name: 'A', goals: 6, assists: 6, total: 12 },
    { name: 'B', goals: 5, assists: 5, total: 10 },
  ];
  const r = relianceFor(squad);
  assert.equal(r.total.rate, 100);
  assert.equal(r.goals.rate, null, 'eleven goals is not yet twelve');
  assert.equal(r.assists.rate, null);
});

test('the flat concentration fields still describe the combined view', async () => {
  const rows = await teamStats(store);
  const yaka = rows.find((r) => r.teamId === 1047);
  assert.equal(yaka.concentration, yaka.reliance.total.rate);
  assert.equal(yaka.topThree, yaka.reliance.total.part);
  assert.equal(yaka.contributions, yaka.reliance.total.whole);
  assert.equal(yaka.contributors, yaka.reliance.total.contributors);
  // Yaka's five goals and four assists come from three players.
  assert.equal(yaka.reliance.goals.whole, 5);
  assert.equal(yaka.reliance.assists.whole, 4);
  assert.equal(yaka.reliance.total.whole, 9);
});

// --- thrower to scorer ------------------------------------------------------

test('combinations pair the assister with the scorer, not with the team', async () => {
  const combos = await comboLeaders(store, { minGoals: 2 });
  // Only one pair connected twice: 2160 threw to 2149 on P2 and again on P4.
  assert.equal(combos.length, 1);
  assert.equal(combos[0].goals, 2);
  assert.equal(combos[0].assistName, 'A2160 Y');
  assert.equal(combos[0].scorerName, 'S2149 X');
  assert.equal(combos[0].teamId, 1047);
  assert.equal(combos[0].team, 'NLSU Yaka');
});

test('a Callahan produces no combination, having no thrower', async () => {
  const all = await comboLeaders(store, { minGoals: 1, limit: 50 });
  // Eight goals, but P1 was a Callahan and carries no assist.
  assert.equal(all.reduce((n, c) => n + c.goals, 0), 7);
  assert.ok(all.every((c) => c.assistId && c.scorerId));
});

test('combinations can be scoped to one club', async () => {
  const yaka = await comboLeaders(store, { teamId: 1047, minGoals: 1, limit: 50 });
  const blue = await comboLeaders(store, { teamId: 1104, minGoals: 1, limit: 50 });
  assert.ok(yaka.every((c) => c.teamId === 1047));
  assert.ok(blue.every((c) => c.teamId === 1104));
  assert.equal(yaka.reduce((n, c) => n + c.goals, 0), 4, 'five goals less the Callahan');
  assert.equal(blue.reduce((n, c) => n + c.goals, 0), 3);
});

test('combinations come back in a stable order', async () => {
  const a = await comboLeaders(store, { minGoals: 1, limit: 50 });
  const b = await comboLeaders(store, { minGoals: 1, limit: 50 });
  assert.deepEqual(a.map((c) => `${c.assistId}>${c.scorerId}`),
                   b.map((c) => `${c.assistId}>${c.scorerId}`));
  // Sorted by goals, most first.
  const counts = a.map((c) => c.goals);
  assert.deepEqual(counts, counts.slice().sort((x, y) => y - x));
});

// --- club profile -----------------------------------------------------------

test('median is the middle value, not the mean', () => {
  assert.equal(median([1, 2, 3]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  // One blowout must not drag the benchmark the way a mean would.
  assert.equal(median([10, 11, 12, 13, 100]), 12);
  assert.equal(median([]), null);
  assert.equal(median([null, undefined, NaN]), null);
});

test('a profile gathers one club and places it in its own division', async () => {
  const p = await teamProfile(store, 1047);
  assert.equal(p.team.name, 'NLSU Yaka');
  assert.equal(p.team.division, "Women's");
  assert.equal(p.divisionClubs, 2, 'both clubs in this division have traceable points');
  assert.equal(p.stats.teamId, 1047);
  // The squad is this club's players only, best first.
  assert.ok(p.squad.length === 3);
  assert.ok(p.squad.every((s) => s.teamId === 1047));
  assert.deepEqual(p.squad.map((s) => s.total), [4, 3, 2]);
});

test('a club under the sample gate is marked thin rather than given a rank', async () => {
  const p = await teamProfile(store, 1047);
  // Three offensive points and five defensive ones clears no gate on the page.
  const hold = p.context.find((c) => c.key === 'holdPct');
  assert.equal(hold.thin, true);
  assert.equal(hold.value, null);
  assert.equal(hold.rank, null, 'a rank off four points would be a fiction');
  assert.equal(hold.of, 0, 'nobody in the division qualifies yet either');
  assert.equal(hold.median, null);
  // Every stat carries which way is up, so the page cannot colour it backwards.
  const broken = p.context.find((c) => c.key === 'brokenPct');
  assert.equal(broken.lowerIsBetter, true);
  const breaks = p.context.find((c) => c.key === 'breakPct');
  assert.equal(breaks.lowerIsBetter, false);
  // Reliance has no good end, and must never be coloured as if it did.
  assert.equal(p.context.find((c) => c.key === 'reliance.total.rate').neutral, true);
});

test('a profile carries the club combinations with it', async () => {
  const p = await teamProfile(store, 1047);
  assert.ok(p.combos.every((c) => c.teamId === 1047));
  assert.equal(p.combos.length, 1, 'one pair connected twice');
});

test('an unknown club is absent, not empty', async () => {
  assert.equal(await teamProfile(store, 999999), null);
});

test('the profile endpoint answers, and refuses nonsense', async () => {
  const good = await call('GET', '/api/team?id=1047');
  assert.equal(good.status, 200);
  assert.equal(good.body.team.name, 'NLSU Yaka');
  assert.equal((await call('GET', '/api/team?id=999999')).status, 404);
  assert.equal((await call('GET', '/api/team?id=nonsense')).status, 400);
  assert.equal((await call('GET', '/api/team')).status, 400);
});

test('the stats payload carries combinations alongside the tables', async () => {
  const res = await call('GET', '/api/stats');
  assert.equal(res.status, 200);
  const body = res.body;
  assert.ok(Array.isArray(body.combos));
  assert.equal(body.combos.length, 1);
  assert.equal(body.combos[0].goals, 2);
});

test('timeout conversion separates the break it won from the hold it kept', async () => {
  // A second copy of the game carrying three timeouts on a known chain:
  //   500s  Yaka on defence -> P2 at 635s, Yaka score: a BREAK
  //   700s  Blue on offence -> P3 at 855s, Blue score: a HOLD
  //   1000s Blue            -> P4 at 1105s, Yaka score: nothing
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
    fetcher: async () => ({
      ...DETAIL,
      game_result: { ...DETAIL.game_result, game_id: 1277 },
      gameevents: [
        { time: 0, ishome: 1, type: 'offence' },
        { time: 500, ishome: 1, type: 'timeout' },
        { time: 700, ishome: 0, type: 'timeout' },
        { time: 1000, ishome: 0, type: 'timeout' },
      ],
    }),
  });

  const rows = await teamStats(store);
  const yaka = rows.find((r) => r.teamId === 1047);
  const blue = rows.find((r) => r.teamId === 1104);

  // Yaka called one and turned it into a break.
  assert.equal(yaka.timeouts, 1);
  assert.equal(yaka.timeoutsBreak, 1);
  assert.equal(yaka.timeoutsHold, 0);
  assert.equal(yaka.timeoutBreakRate, 100);

  // Blueberries called three across the two games and won one, on offence.
  // Same 33.3% conversion as a side that had broken instead — which is the
  // whole reason the single number was not enough.
  assert.equal(blue.timeouts, 3);
  assert.equal(blue.timeoutsConverted, 1);
  assert.equal(blue.timeoutsBreak, 0);
  assert.equal(blue.timeoutsHold, 1);
  assert.equal(blue.timeoutConversion, 33.3);
  assert.equal(blue.timeoutHoldRate, 33.3);
  assert.equal(blue.timeoutBreakRate, 0);

  // The splits are allowed not to sum to the conversions, and the gap is
  // reported rather than silently folded into one side.
  assert.equal(yaka.timeoutsUnattributed, 0);
  assert.equal(blue.timeoutsUnattributed, 0);
});

// --- the shape of a defensive point, with tempo taken out --------------------
//
// The reason this exists rather than a raw side-by-side: across the whole
// tournament both halves are dominated by how long a club's points run in
// general, so raw seconds mostly rank clubs by tempo.

test('two clubs with the same shape at different tempos come out identical', () => {
  const fast = { dSecsPerPoint: 150, secondsPerBreak: 120, secondsPerConcededHold: 180,
                 breakClockN: 8, concededClockN: 8 };
  const slow = { dSecsPerPoint: 250, secondsPerBreak: 220, secondsPerConcededHold: 280,
                 breakClockN: 8, concededClockN: 8 };
  assert.equal(dShapeFor(fast, [fast]).gap, dShapeFor(slow, [slow]).gap);
  // Their raw numbers are a hundred seconds apart, which is exactly what the
  // uncentred columns would have sorted them on.
  assert.equal(slow.secondsPerBreak - fast.secondsPerBreak, 100);
});

test('the shape carries its division median so the gap has a scale', () => {
  const me = { dSecsPerPoint: 200, secondsPerBreak: 160, secondsPerConcededHold: 230,
               breakClockN: 8, concededClockN: 9 };
  const peers = [me,
    { dSecsPerPoint: 300, secondsPerBreak: 290, secondsPerConcededHold: 310,
      breakClockN: 8, concededClockN: 8 },
    { dSecsPerPoint: 150, secondsPerBreak: 170, secondsPerConcededHold: 140,
      breakClockN: 6, concededClockN: 7 }];
  const d = dShapeFor(me, peers);
  assert.equal(d.own, 200);
  assert.equal(d.gap, 70);
  assert.equal(d.thin, false);
  // Gaps across the pool: +70, +20, -30. Median +20.
  assert.equal(d.divisionMedianGap, 20);
  assert.equal(d.divisionClubsCompared, 3);
});

test('peers short of the sample are left out of the benchmark, not counted as zero', () => {
  const me = { dSecsPerPoint: 200, secondsPerBreak: 160, secondsPerConcededHold: 230,
               breakClockN: 8, concededClockN: 9 };
  const thinPeer = { dSecsPerPoint: 200, secondsPerBreak: 100, secondsPerConcededHold: 300,
                     breakClockN: 1, concededClockN: 1 };
  const d = dShapeFor(me, [me, thinPeer]);
  assert.equal(d.divisionClubsCompared, 1, 'the one-point club contributes nothing');
  assert.equal(d.divisionMedianGap, 70);
});

test('a club short of either half reports thin, and says which half', () => {
  const me = { dSecsPerPoint: 200, secondsPerBreak: 160, secondsPerConcededHold: 230,
               breakClockN: 2, concededClockN: 9 };
  const d = dShapeFor(me, [me]);
  assert.equal(d.thin, true);
  assert.equal(d.gap, null);
  assert.equal(d.own, null);
  // The counts still travel, so the page can say what is missing rather than
  // just refusing to draw.
  assert.equal(d.breakN, 2);
  assert.equal(d.concedeN, 9);
});

test('a club with nothing traceable has no shape at all', () => {
  assert.equal(dShapeFor(null, []), null);
});

test('a profile carries the shape, and neither D time is ranked', async () => {
  const p = await teamProfile(store, 1047);
  assert.ok(p.dShape, 'the block is always present, even when thin');
  assert.equal(p.dShape.thin, true, 'two breaks is not a sample');
  // Neither time predicts break rate, so ranking them would imply a virtue
  // the data does not support.
  for (const key of ['secondsPerBreak', 'secondsPerConcededHold']) {
    const c = p.context.find((x) => x.key === key);
    assert.equal(c.neutral, true, `${key} must not be graded`);
    assert.equal(c.rank, null, `${key} must not be ranked`);
  }
});

// --- what the scoreboard said before the point -------------------------------
//
// Yaka led from the first point, so every one of their defensive points came
// while ahead and every one of Blueberries' offensive points came while behind.
// That makes this fixture a clean check that the walk buckets both sides of the
// same point independently.

test('every point is bucketed for both sides, from each side of the scoreboard', async () => {
  const rows = await teamStats(store);
  const yaka = rows.find((r) => r.teamId === 1047);
  const blue = rows.find((r) => r.teamId === 1104);

  // P0 is the only point played level: 0-0 before anyone scored.
  assert.equal(yaka.scoreState.level.oPoints, 1);
  assert.equal(yaka.scoreState.level.holds, 1);
  assert.equal(blue.scoreState.level.dPoints, 1);

  // Yaka were ahead for everything after it.
  assert.equal(yaka.scoreState.ahead.dPoints, 5);
  assert.equal(yaka.scoreState.ahead.breaks, 2);
  assert.equal(yaka.scoreState.ahead.breakPct, 40);
  assert.equal(yaka.scoreState.ahead.oPoints, 2);
  assert.equal(yaka.scoreState.ahead.holdPct, 100);
  assert.equal(yaka.scoreState.behind.oPoints, 0);

  // The same points, seen from the other end.
  assert.equal(blue.scoreState.behind.oPoints, 5);
  assert.equal(blue.scoreState.behind.holds, 3);
  assert.equal(blue.scoreState.behind.holdPct, 60);
  assert.equal(blue.scoreState.behind.dPoints, 2);
  assert.equal(blue.scoreState.ahead.dPoints, 0);
});

test('the three states account for every point and nothing twice', async () => {
  const rows = await teamStats(store);
  for (const t of rows) {
    const st = t.scoreState;
    assert.equal(st.behind.oPoints + st.level.oPoints + st.ahead.oPoints, t.oPoints,
      `${t.name}: offensive points must partition across the three states`);
    assert.equal(st.behind.dPoints + st.level.dPoints + st.ahead.dPoints, t.dPoints,
      `${t.name}: defensive points must partition across the three states`);
    assert.equal(st.behind.breaks + st.level.breaks + st.ahead.breaks, t.breaks);
    assert.equal(st.behind.holds + st.level.holds + st.ahead.holds, t.holds);
  }
});

test('a game that never reaches 12-12 contributes no tight points', async () => {
  const rows = await teamStats(store);
  // The fixture finishes 5-3, so nothing here is close-and-late.
  assert.equal(rows.find((r) => r.teamId === 1047).tight.points, 0);
  assert.equal(rows.find((r) => r.teamId === 1104).tight.pct, null,
    'no tight points means no record, not a 0% record');
});

// --- connection depth --------------------------------------------------------

test('connection depth counts distinct pairings, not goals', async () => {
  const rows = await teamStats(store);
  const yaka = rows.find((r) => r.teamId === 1047);
  // Four assisted goals from three pairings — 2160 threw to 2149 twice.
  assert.equal(yaka.assistedGoals, 4);
  assert.equal(yaka.connections, 3);
  assert.equal(yaka.connectionSpread, 75);

  // Blueberries' three assisted goals came through three different pairings.
  const blue = rows.find((r) => r.teamId === 1104);
  assert.equal(blue.connections, 3);
  assert.equal(blue.assistedGoals, 3);
  assert.equal(blue.connectionSpread, 100);
});

test('the Callahan is absent from connection depth, having no thrower', async () => {
  const rows = await teamStats(store);
  const yaka = rows.find((r) => r.teamId === 1047);
  // Five goals, four of them assisted.
  assert.equal(yaka.reliance.goals.whole, 5);
  assert.equal(yaka.assistedGoals, 4);
});

test('a point we cannot attribute still moves the scoreboard for the ones we can', async () => {
  // A game with no opening marker has an unanchored point sitting in the
  // MIDDLE of its scoreboard. It cannot be bucketed, because we do not know
  // which side was on offence — but the goal was scored, and every later point
  // has to be read against a score that includes it. Walking only the anchored
  // rows left the rest of the game measured against a score short by one, and
  // silently moved points between the behind/level/ahead buckets.
  const unmarked = { ...GAME, id: 1281 };
  await sync(store, {
    force: true, now: NOW,
    fetcher: async () => ({
      heartbeat: { cacheVersion: 'vsc' }, teams: TEAMS,
      fieldSizes: { "Women's": 40 }, games: [unmarked],
    }),
  });
  await syncGameDetail(store, {
    fetcher: async () => ({
      ...DETAIL, game_result: { ...DETAIL.game_result, game_id: 1281 }, gameevents: [],
    }),
  });

  const [p0] = await store.query('SELECT anchored FROM points WHERE game_id = 1281 AND num = 0');
  assert.ok(!p0.anchored, 'the opening point is the one that cannot be placed');

  const yaka = (await teamStats(store)).find((r) => r.teamId === 1047);
  // Yaka led from the first goal of both games. In 1276 they were the offence
  // for the only level point; in 1281 that point is unanchored and bucketed
  // nowhere. So they have no defensive point at level — which is only true if
  // the unanchored goal advanced the score before point 1 was bucketed. With
  // the bug, point 1 of game 1281 reads 0-0 and lands in `level`.
  assert.equal(yaka.scoreState.level.dPoints, 0);
  assert.equal(yaka.scoreState.level.oPoints, 1, 'just the one, from the marked game');
  assert.equal(yaka.scoreState.behind.dPoints, 0);
});

test('a player whose name is spelt differently in two games keeps both his goals', async () => {
  // The tallies group in SQL by (id, name, team), so one player comes back as
  // two rows the moment a scorekeeper types the name differently — an accent
  // dropped, a surname abbreviated. The accumulator is keyed on the id alone,
  // so the second row used to overwrite the first instead of adding to it, and
  // the earlier game's goals vanished without trace.
  const second = { ...GAME, id: 1290 };
  await sync(store, {
    force: true, now: NOW,
    fetcher: async () => ({
      heartbeat: { cacheVersion: 'vname' }, teams: TEAMS,
      fieldSizes: { "Women's": 40 }, games: [second],
    }),
  });
  // Same player id 2160, spelt differently, scoring twice more.
  await syncGameDetail(store, {
    fetcher: async () => ({
      game_result: { game_id: 1290, hometeam: 1047, visitorteam: 1104, halftime: null },
      gameevents: [{ time: 0, ishome: 1, type: 'offence' }],
      goals: [
        { num: 0, time: 200, ishomegoal: 1, scorer: 2160, assist: 2144, iscallahan: 0,
          scorerfirstname: 'S2160', scorerlastname: 'Ex',
          assistfirstname: 'A2144', assistlastname: 'Wye' },
        { num: 1, time: 400, ishomegoal: 1, scorer: 2160, assist: 2144, iscallahan: 0,
          scorerfirstname: 'S2160', scorerlastname: 'Ex',
          assistfirstname: 'A2144', assistlastname: 'Wye' },
      ],
    }),
  });

  const players = await playerTallies(store);
  const rows = players.filter((p) => p.playerId === 2160);
  assert.equal(rows.length, 1, 'one player, however many ways the feed spells him');
  // Two goals in game 1276 under one spelling, two more here under another.
  assert.equal(rows[0].goals, 4, 'both spellings must be added, not one overwritten');

  // And the club total has to agree with a straight count of its points.
  const [{ n } = {}] = await store.query(
    'SELECT COUNT(*) AS n FROM points WHERE score_team_id = 1047 AND scorer_id IS NOT NULL');
  const yaka = (await teamStats(store)).find((t) => t.teamId === 1047);
  assert.equal(yaka.reliance.goals.whole, Number(n),
    'the club goal total must equal the number of goals actually stored');
});
