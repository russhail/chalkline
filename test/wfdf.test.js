import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseGame, isBettable, SERIES } from '../lib/wfdf.js';

// Fixtures copied verbatim from the live feed on 2026-08-15.
const POOLS = new Map([
  [1016, { pool_id: 1016, poolname: 'Pool A', series_id: 1002, type: 1 }],
]);

const SCHEDULED = {
  game_id: 1000, hometeam: 1131, visitorteam: 1109, reservation: 1042,
  time: '2026-08-16 15:00:00', valid: 1, pool: 1016, pools: '1016',
  status: 'scheduled', time_utc: '2026-08-16 14:00:00',
};

test('normalises a scheduled game from the real feed shape', () => {
  const g = normaliseGame(SCHEDULED, POOLS);
  assert.equal(g.id, 1000);
  assert.equal(g.homeTeamId, 1131);
  assert.equal(g.awayTeamId, 1109);
  assert.equal(g.status, 'scheduled');
  assert.equal(g.division, 'Open');
  assert.equal(g.poolName, 'Pool A');
  assert.equal(g.homeScore, null);
});

test('kickoff is parsed as UTC, not local', () => {
  const g = normaliseGame(SCHEDULED, POOLS);
  assert.equal(g.startsAt, '2026-08-16T14:00:00Z');
  assert.equal(new Date(g.startsAt).toISOString(), '2026-08-16T14:00:00.000Z');
  // Irish local time is an hour ahead; we must not have used it by mistake.
  assert.equal(g.localTime, '2026-08-16 15:00:00');
});

test('series ids map to the right divisions', () => {
  assert.equal(SERIES[1000], "Women's");
  assert.equal(SERIES[1001], 'Mixed');
  assert.equal(SERIES[1002], 'Open');
});

test('accepts whichever score field names the feed turns out to use', () => {
  for (const [h, a] of [
    ['homescore', 'visitorscore'],
    ['home_score', 'away_score'],
    ['scorehome', 'scorevisitor'],
    ['hometeamscore', 'visitorteamscore'],
  ]) {
    const g = normaliseGame({ ...SCHEDULED, status: 'final', [h]: 15, [a]: 11 }, POOLS);
    assert.equal(g.homeScore, 15, `failed to read ${h}`);
    assert.equal(g.awayScore, 11, `failed to read ${a}`);
    assert.equal(g.status, 'final');
  }
});

test('recognises final status under several spellings', () => {
  for (const s of ['final', 'Final', 'finished', 'complete', 'completed', 'played']) {
    const g = normaliseGame({ ...SCHEDULED, status: s, homescore: 15, visitorscore: 9 }, POOLS);
    assert.equal(g.status, 'final', `status "${s}" should be final`);
  }
});

test('a game carrying scores is never treated as still bettable', () => {
  const g = normaliseGame({ ...SCHEDULED, homescore: 7, visitorscore: 5 }, POOLS);
  assert.notEqual(g.status, 'scheduled');
  assert.equal(isBettable(g), false);
});

test('scheduled games with two real teams are bettable', () => {
  assert.equal(isBettable(normaliseGame(SCHEDULED, POOLS)), true);
});

test('bracket placeholders are not bettable', () => {
  const placeholder = normaliseGame(
    { ...SCHEDULED, hometeam: 0, visitorteam: 0,
      scheduling_name_home: 'Winner Pool A', scheduling_name_visitor: 'Runner-up Pool B' },
    POOLS
  );
  assert.equal(placeholder.homeLabel, 'Winner Pool A');
  assert.equal(isBettable(placeholder), false);
});

test('invalid games are excluded and missing kickoff blocks betting', () => {
  const noTime = normaliseGame({ ...SCHEDULED, time_utc: null }, POOLS);
  assert.equal(isBettable(noTime), false);
});

test('unknown pool does not throw', () => {
  const g = normaliseGame({ ...SCHEDULED, pool: 9999 }, new Map());
  assert.equal(g.poolName, null);
  assert.equal(g.division, null);
});

// --- scores come from the standings files, not the games file ---------------

import { fetchPoolStandings, fetchScores } from '../lib/wfdf.js';

// Verbatim shape from WUCC2026_standings_1020.json on 2026-08-15.
const STANDINGS = {
  standings: {
    pool_id: 1020, name: 'Pool E', series: 1001, winningscore: 15, scorecap: 15,
    timecap: 100, drawsallowed: 0, forfeitscore: 0,
    games: [
      { hometeamname: 'PELT', visitorteamname: 'Chilli Heat', hometeam: 1078,
        visitorteam: 1111, time: '2026-08-15 13:00:00', game_id: 1074,
        homescore: null, visitorscore: null, forfeit: 0 },
      { hometeamname: 'A', visitorteamname: 'B', hometeam: 1, visitorteam: 2,
        time: '2026-08-15 15:00:00', game_id: 1075, homescore: 15, visitorscore: 11, forfeit: 0 },
      { hometeamname: 'C', visitorteamname: 'D', hometeam: 3, visitorteam: 4,
        time: '2026-08-15 15:00:00', game_id: 1076, homescore: 15, visitorscore: 0, forfeit: 1 },
    ],
  },
};

function stubFetch(payload) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => payload });
  return () => { globalThis.fetch = original; };
}

test('a pool standings file yields scores and the pool rules', async () => {
  const restore = stubFetch(STANDINGS);
  try {
    const pool = await fetchPoolStandings(1020);
    assert.equal(pool.poolId, 1020);
    assert.equal(pool.scoreCap, 15);
    assert.equal(pool.drawsAllowed, false, 'ultimate pools do not allow draws');
    assert.equal(pool.games.length, 3);
    const unplayed = pool.games.find((g) => g.id === 1074);
    assert.equal(unplayed.homeScore, null, 'an unplayed game has null, not 0');
  } finally { restore(); }
});

test('fetchScores skips unplayed games and keeps the forfeit flag', async () => {
  const restore = stubFetch(STANDINGS);
  try {
    const { scores, failures } = await fetchScores([1020]);
    assert.equal(failures.length, 0);
    assert.equal(scores.has(1074), false, 'null scores must not be treated as 0-0');
    assert.deepEqual(
      { ...scores.get(1075) },
      { homeScore: 15, awayScore: 11, forfeit: false, drawsAllowed: false,
        timeCap: 100, winningScore: 15 }
    );
    assert.equal(scores.get(1076).forfeit, true);
  } finally { restore(); }
});

test('a failing pool is reported, not thrown, so one bad file cannot stall a sync', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  try {
    const { scores, failures } = await fetchScores([1020, 1021]);
    assert.equal(scores.size, 0);
    assert.equal(failures.length, 2);
  } finally { globalThis.fetch = original; }
});

// --- a running game must never be mistaken for a finished one ---------------

test('a game the active feed calls ongoing is live, never final', () => {
  // Verbatim from WUCC2026_games_active.json while game 1074 was being played.
  const g = normaliseGame({
    game_id: 1074, hometeam: 1078, visitorteam: 1111, homescore: 9, visitorscore: 12,
    time: '2026-08-15 13:00:00', time_utc: '2026-08-15 12:00:00', valid: 1,
    pool: 1020, status: 'ongoing', isongoing: 1, hasstarted: 1,
  }, POOLS);
  assert.equal(g.status, 'live', 'a running game must not be final');
  assert.equal(g.ongoing, true);
  assert.equal(g.homeScore, 9);
  assert.equal(isBettable(g), false, 'and it is certainly not bettable');
});

test('a mid-game score does not make a game final', () => {
  const g = normaliseGame({
    ...SCHEDULED, homescore: 5, visitorscore: 7, isongoing: 1, status: 'ongoing',
  }, POOLS);
  assert.notEqual(g.status, 'final');
});

test('once the active feed lets go of a game, it can be final', () => {
  const g = normaliseGame({
    ...SCHEDULED, status: 'final', homescore: 15, visitorscore: 12, isongoing: 0,
  }, POOLS);
  assert.equal(g.status, 'final');
  assert.equal(g.ongoing, false);
});
