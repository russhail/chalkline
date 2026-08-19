// A real game, transcribed from WFDF's own published timeline, used as ground
// truth for the score-state buckets.
//
// Fury 15-0 Heidees is the most useful game at this tournament for testing
// this, because the answer is not a matter of interpretation. WFDF label every
// point themselves: one Offensive Hold, then fourteen Break Scores. Fury
// received the opening pull, held it, and never trailed or drew level again —
// so every one of those fourteen breaks was played from in front, and the
// single offensive point was played at 0-0.
//
// That makes the expected numbers exact rather than approximate: ahead must be
// fourteen defensive points and fourteen breaks, level must be one offensive
// point and one hold, and behind must be empty. A score walk that mislaid a
// goal would move points out of `ahead` and into `level`, and nothing else in
// the aggregation would notice.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../lib/store.js';
import { sync, syncGameDetail } from '../lib/sync.js';
import { teamStats } from '../lib/dashboard.js';

const NOW = Date.parse('2026-08-20T18:00:00Z');
let store;

const TEAMS = [
  { id: 2001, name: 'Fury', abbreviation: 'FUR', division: "Women's", country: 'USA', seed: 1 },
  { id: 2002, name: 'Heidees', abbreviation: 'HEI', division: "Women's", country: 'GER', seed: 20 },
];

const GAME = {
  id: 2100, homeTeamId: 2001, awayTeamId: 2002, homeLabel: null, awayLabel: null,
  division: "Women's", poolName: 'Pool A', poolId: 1,
  startsAt: '2026-08-18T09:00:00Z', status: 'final', ongoing: false,
  homeScore: 15, awayScore: 0, valid: true,
};

// Every goal as WFDF published it. Times converted from mm:ss; the Callahan at
// 19:45 carries no assist, which is definitional — a Callahan is caught in the
// endzone off a block, so there is no thrower on the scoring side.
const G = (num, mmss, scorer, assist, cal = 0) => {
  const [m, s] = mmss.split(':').map(Number);
  return {
    num, time: m * 60 + s, ishomegoal: 1, homescore: num + 1, visitorscore: 0,
    scorer, assist, iscallahan: cal,
    scorerfirstname: `S${scorer}`, scorerlastname: 'x',
    assistfirstname: assist ? `A${assist}` : null, assistlastname: assist ? 'y' : null,
  };
};

const DETAIL = {
  game_result: { game_id: 2100, hometeam: 2001, visitorteam: 2002, halftime: null },
  gameevents: [
    { time: 0, ishome: 1, type: 'offence' },      // "Fury begins on offense"
    { time: 740, ishome: 1, type: 'timeout' },    // 12:20 Fury
    { time: 2050, ishome: 0, type: 'timeout' },   // 34:10 Heidees
  ],
  goals: [
    G(0, '1:25', 9, 5),        // Offensive Hold
    G(1, '3:10', 15, 29),      // Break
    G(2, '5:10', 16, 9),       // Break
    G(3, '7:50', 25, 19),      // Break
    G(4, '9:45', 9, 5),        // Break
    G(5, '13:35', 55, 21),     // Break
    G(6, '18:05', 18, 1),      // Break
    G(7, '19:45', 33, null, 1),// Break — Callahan
    G(8, '28:40', 51, 9),      // Break
    G(9, '31:15', 19, 1),      // Break
    G(10, '33:35', 31, 34),    // Break
    G(11, '37:10', 2, 46),     // Break
    G(12, '39:15', 6, 9),      // Break
    G(13, '41:40', 15, 33),    // Break
    G(14, '43:50', 6, 9),      // Break
  ],
};

beforeEach(async () => {
  store = createStore({ backend: 'sqlite' });
  await store.migrate();
  await sync(store, {
    force: true, now: NOW,
    fetcher: async () => ({
      heartbeat: { cacheVersion: 'fury' }, teams: TEAMS,
      fieldSizes: { "Women's": 40 }, games: [GAME],
    }),
  });
  await syncGameDetail(store, { fetcher: async () => DETAIL });
});

test('the derivation reproduces WFDF\'s own labels: one hold, fourteen breaks', async () => {
  const fury = (await teamStats(store)).find((t) => t.teamId === 2001);
  assert.equal(fury.holds, 1);
  assert.equal(fury.breaks, 14);
  assert.equal(fury.oPoints, 1, 'a 15-0 gives you the disc once');
  assert.equal(fury.dPoints, 14);
  assert.equal(fury.callahans, 1);
});

test('all fourteen of those breaks were played from in front', async () => {
  const fury = (await teamStats(store)).find((t) => t.teamId === 2001);
  const s = fury.scoreState;

  // The one offensive point was the first of the game, at 0-0.
  assert.equal(s.level.oPoints, 1);
  assert.equal(s.level.holds, 1);

  // Everything after it was played with Fury in front. This is the assertion
  // the score-walk bug would break: drop a goal and points slide into `level`.
  assert.equal(s.ahead.dPoints, 14);
  assert.equal(s.ahead.breaks, 14);
  assert.equal(s.ahead.breakPct, 100);

  // Fury never trailed for a single point of this game.
  assert.equal(s.behind.dPoints, 0);
  assert.equal(s.behind.oPoints, 0);
  assert.equal(s.behind.breakPct, null, 'never behind means no rate, not zero');
});

test('the same points, seen from the losing side', async () => {
  const heidees = (await teamStats(store)).find((t) => t.teamId === 2002);
  const s = heidees.scoreState;
  // Heidees received fourteen times and were broken every time, all while
  // behind; their single defensive point was the opening pull at 0-0.
  assert.equal(s.behind.oPoints, 14);
  assert.equal(s.behind.holds, 0);
  assert.equal(s.level.dPoints, 1);
  assert.equal(s.ahead.oPoints + s.ahead.dPoints, 0, 'they were never in front');
});

test('a 15-0 is a fine break sample and a worthless hold sample', async () => {
  // The case the top of dashboard.js is written around: one flag per club
  // cannot describe both, which is why the gate belongs to the stat.
  const fury = (await teamStats(store)).find((t) => t.teamId === 2001);
  assert.equal(fury.breakPct, 100, 'fourteen from fourteen');
  assert.equal(fury.holdPct, 100, 'and one from one, which means nothing');
  assert.ok(fury.dPoints >= 10, 'the break rate clears any sensible gate');
  assert.ok(fury.oPoints < 10, 'the hold rate clears none of them');
});
