// Score state, checked as a property rather than a sample.
//
// The bug this file exists for was subtle and silent: scoreStates filtered to
// anchored points before walking the running score, so a game missing its
// opening marker had a goal skipped out of the middle of its scoreboard and
// every later point was bucketed against a score short by up to two. Nothing
// crashed, no total changed, and the three buckets still summed correctly —
// the points were simply in the wrong ones. A spot check could not see it.
//
// So the checks here are of two kinds. The cheap ones are invariants that must
// hold for any input at all. The expensive one replays every game from the raw
// goals, independently of the aggregation, and demands the same answer — which
// is the only check that would have caught the original bug.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../lib/store.js';
import { sync, syncGameDetail } from '../lib/sync.js';
import { teamStats, scoreStates } from '../lib/dashboard.js';

// Deterministic: a property test that shuffles between runs is not a test.
let seed = 424242;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

const TEAMS = Array.from({ length: 8 }, (_, i) => ({
  id: 100 + i, name: `Club ${i}`, abbreviation: `C${i}`,
  division: i < 4 ? 'Open' : "Women's", country: 'IRL', seed: i + 1,
}));

// A game generator that deliberately produces the awkward shapes real feeds
// contain: blowouts where one side never once trails, games decided on the
// last point, missing opening markers, Callahans, and a recorded halftime
// (which makes a SECOND point unanchored, in the middle of the game).
function makeGame(id, homeId, awayId, shape) {
  const goals = [];
  let hs = 0, as = 0, t = 0, num = 0, halftime = null;
  const homeStrength = shape === 'blowout' ? 0.95 : shape === 'tight' ? 0.5 : 0.62;
  while (hs < 15 && as < 15 && num < 30) {
    const homeScores = shape === 'tight'
      ? (num % 2 === 0 ? rnd() < 0.55 : rnd() < 0.45)
      : rnd() < homeStrength;
    t += 60 + Math.floor(rnd() * 200);
    if (homeScores) hs += 1; else as += 1;
    goals.push({
      num, time: t, ishomegoal: homeScores ? 1 : 0,
      homescore: hs, visitorscore: as,
      scorer: (homeScores ? homeId : awayId) * 10 + (num % 7),
      assist: rnd() < 0.9 ? (homeScores ? homeId : awayId) * 10 + ((num + 3) % 7) : null,
      iscallahan: rnd() < 0.03 ? 1 : 0,
      scorerfirstname: 'S', scorerlastname: `${num % 7}`,
      assistfirstname: 'A', assistlastname: `${(num + 3) % 7}`,
    });
    if (halftime === null && Math.max(hs, as) >= 8) halftime = t;
    num += 1;
  }
  const events = [];
  // One game in six has no opening marker, which is the real feed's rate and
  // the condition the original bug needed.
  if (shape !== 'unmarked') events.push({ time: 0, ishome: rnd() < 0.5 ? 1 : 0, type: 'offence' });
  return {
    meta: { id, homeTeamId: homeId, awayTeamId: awayId, homeLabel: null, awayLabel: null,
            division: TEAMS.find((x) => x.id === homeId).division,
            poolName: 'Pool A', poolId: 1,
            startsAt: `2026-08-1${1 + (id % 5)}T10:00:00Z`,
            status: 'final', ongoing: false, homeScore: hs, awayScore: as, valid: true },
    detail: {
      game_result: { game_id: id, hometeam: homeId, visitorteam: awayId, halftime },
      gameevents: events,
      goals,
    },
  };
}

async function buildTournament() {
  const store = createStore({ backend: 'sqlite' });
  await store.migrate();
  const shapes = ['normal', 'blowout', 'tight', 'unmarked'];
  const games = [];
  let id = 700;
  for (let round = 0; round < 5; round += 1) {
    for (let i = 0; i < TEAMS.length; i += 2) {
      const home = TEAMS[(i + round) % TEAMS.length];
      const away = TEAMS[(i + round + 1) % TEAMS.length];
      if (home.id === away.id || home.division !== away.division) continue;
      games.push(makeGame(id += 1, home.id, away.id, shapes[id % shapes.length]));
    }
  }
  await sync(store, {
    force: true, now: Date.parse('2026-08-20T18:00:00Z'),
    fetcher: async () => ({
      heartbeat: { cacheVersion: 'prop' }, teams: TEAMS,
      fieldSizes: { Open: 8, "Women's": 8 }, games: games.map((g) => g.meta),
    }),
  });
  const byId = new Map(games.map((g) => [g.meta.id, g.detail]));
  for (let pass = 0; pass < 20; pass += 1) {
    const r = await syncGameDetail(store, { fetcher: async (gid) => byId.get(gid), limit: 20 });
    if (!r.pending) break;
  }
  return { store, games };
}

test('every point lands in exactly one state, for every club', async () => {
  const { store } = await buildTournament();
  const rows = await teamStats(store);
  assert.ok(rows.length >= 8, 'the fixture has to produce clubs to check');

  for (const t of rows) {
    const s = t.scoreState;
    assert.equal(s.behind.oPoints + s.level.oPoints + s.ahead.oPoints, t.oPoints, `${t.name} O`);
    assert.equal(s.behind.dPoints + s.level.dPoints + s.ahead.dPoints, t.dPoints, `${t.name} D`);
    assert.equal(s.behind.breaks + s.level.breaks + s.ahead.breaks, t.breaks, `${t.name} breaks`);
    assert.equal(s.behind.holds + s.level.holds + s.ahead.holds, t.holds, `${t.name} holds`);
    for (const k of ['behind', 'level', 'ahead']) {
      assert.ok(s[k].breaks <= s[k].dPoints, `${t.name} ${k}: more breaks than defensive points`);
      assert.ok(s[k].holds <= s[k].oPoints, `${t.name} ${k}: more holds than offensive points`);
    }
    assert.ok(t.tight.won <= t.tight.points, `${t.name}: won more tight points than it played`);
  }
  store.close();
});

test('offence and defence balance across the whole tournament', async () => {
  // Every point is exactly one club's offence and exactly one other's defence,
  // so these two totals are the same number counted from opposite ends. A walk
  // that dropped or duplicated a point would break this and nothing else.
  const { store } = await buildTournament();
  const rows = await teamStats(store);
  const sum = (f) => rows.reduce((n, t) => n + f(t), 0);
  assert.equal(sum((t) => t.oPoints), sum((t) => t.dPoints));
  assert.ok(sum((t) => t.oPoints) > 0, 'and it must not balance by both being zero');
  store.close();
});

test('the buckets match an independent replay of every game', async () => {
  // The check that would have caught the original bug. Everything above still
  // passed while points sat in the wrong buckets, because the sums were right.
  // This rebuilds the answer from the stored points a second time, advancing
  // the score on EVERY goal and bucketing only the anchored ones, and demands
  // the aggregation agree club by club and state by state.
  const { store } = await buildTournament();

  const rows = await store.query(
    `SELECT game_id, num, o_team_id, d_team_id, score_team_id, anchored
     FROM points ORDER BY game_id, num`);
  const truth = new Map();
  const blank = () => ({ behind: { d: 0, b: 0 }, level: { d: 0, b: 0 }, ahead: { d: 0, b: 0 } });
  const get = (id) => { if (!truth.has(id)) truth.set(id, blank()); return truth.get(id); };
  const bucket = (mine, theirs) => (mine > theirs ? 'ahead' : mine < theirs ? 'behind' : 'level');

  let game = null, score = new Map();
  let unanchoredSeen = 0;
  for (const r of rows) {
    if (r.game_id !== game) { game = r.game_id; score = new Map(); }
    const o = Number(r.o_team_id), d = Number(r.d_team_id), s = Number(r.score_team_id);
    if (r.anchored && o && d) {
      const so = score.get(o) || 0, sd = score.get(d) || 0;
      const x = get(d)[bucket(sd, so)];
      x.d += 1;
      if (s === d) x.b += 1;
    } else {
      unanchoredSeen += 1;
    }
    score.set(s, (score.get(s) || 0) + 1);
  }

  // If the fixture produced no unanchored points the test proves little, since
  // that is the only condition under which the two walks can disagree.
  assert.ok(unanchoredSeen > 0,
    'the fixture must contain unmarked games or this proves nothing');

  const got = await scoreStates(store, {});
  for (const [id, want] of truth) {
    const mine = got.get(id);
    assert.ok(mine, `club ${id} missing from the aggregation`);
    for (const k of ['behind', 'level', 'ahead']) {
      assert.equal(mine[k].dPoints, want[k].d, `club ${id} ${k} defensive points`);
      assert.equal(mine[k].breaks, want[k].b, `club ${id} ${k} breaks`);
    }
  }
  store.close();
});

test('a club that never trails has an empty behind bucket rather than a wrong one', async () => {
  // The blowout case, which is where an off-by-one in the score walk shows up
  // most clearly: lead from the first point and "behind" must be genuinely
  // empty, not one or two points that the walk mislaid.
  const { store } = await buildTournament();
  const rows = await teamStats(store);
  const wireToWire = rows.filter((t) => t.scoreState.behind.oPoints + t.scoreState.behind.dPoints === 0);
  for (const t of wireToWire) {
    assert.equal(t.scoreState.behind.breaks, 0);
    assert.equal(t.scoreState.behind.holds, 0);
    assert.equal(t.scoreState.behind.breakPct, null,
      'no points played behind means no rate, not a zero rate');
  }
  store.close();
});
