import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  startingOffence, orderedGoals, derivePoints, deriveTimeouts, timeoutOutcomes,
} from '../lib/gamestats.js';

// The opening of the real game 1276, NLSU Yaka 15-11 Blueberries, taken from
// the WFDF feed. Yaka (home, 1047) received the opening pull, so their first
// three goals are holds and Blueberries' first goal at 855s is a break.
const REAL = {
  game_result: {
    game_id: 1276, hometeam: 1047, visitorteam: 1104,
    hometeamname: 'NLSU Yaka', visitorteamname: 'Blueberries',
    homescore: 5, visitorscore: 3, halftime: 3700,
  },
  gameevents: [{ time: 0, ishome: 1, type: 'offence' }],
  goals: [
    { num: 0, time: 200, ishomegoal: 1, scorer: 2160, assist: 2144, iscallahan: 0,
      scorerfirstname: 'Lyla', scorerlastname: 'Petitbon',
      assistfirstname: 'Chloé', assistlastname: 'Ollivier' },
    { num: 1, time: 330, ishomegoal: 1, scorer: 2158, assist: 2139, iscallahan: 0,
      scorerfirstname: 'Emma', scorerlastname: 'Delaunay',
      assistfirstname: 'Aina', assistlastname: 'Perez' },
    { num: 2, time: 635, ishomegoal: 1, scorer: 2149, assist: 2161, iscallahan: 0,
      scorerfirstname: 'Julia', scorerlastname: 'Mas',
      assistfirstname: 'Perrine', assistlastname: 'Leproux' },
    { num: 3, time: 855, ishomegoal: 0, scorer: 3478, assist: 3482, iscallahan: 0,
      scorerfirstname: 'Samantha', scorerlastname: 'Ruhlman',
      assistfirstname: 'Tara', assistlastname: "O'connor" },
    { num: 4, time: 1105, ishomegoal: 1, scorer: 2149, assist: 2160, iscallahan: 0,
      scorerfirstname: 'Julia', scorerlastname: 'Mas',
      assistfirstname: 'Lyla', assistlastname: 'Petitbon' },
    { num: 5, time: 1250, ishomegoal: 0, scorer: 3472, assist: 3474, iscallahan: 0,
      scorerfirstname: 'Jessica', scorerlastname: 'Chambers',
      assistfirstname: 'Kelly', assistlastname: 'Carter' },
    { num: 6, time: 1425, ishomegoal: 1, scorer: 2144, assist: 2156, iscallahan: 0,
      scorerfirstname: 'Chloé', scorerlastname: 'Ollivier',
      assistfirstname: 'Swann', assistlastname: 'Lacoste' },
    { num: 7, time: 2100, ishomegoal: 0, scorer: 3481, assist: 4240, iscallahan: 0,
      scorerfirstname: 'Shi Min', scorerlastname: 'Lee',
      assistfirstname: 'Izzy', assistlastname: 'Retout' },
  ],
};

const YAKA = 1047;
const BLUE = 1104;

test('the opening pull anchors the chain', () => {
  assert.equal(startingOffence(REAL), 'home');
  assert.equal(startingOffence({ gameevents: [{ time: 0, ishome: 0, type: 'offence' }] }), 'away');
  assert.equal(startingOffence({ gameevents: [{ time: 9, ishome: 1, type: 'timeout' }] }), null);
  assert.equal(startingOffence({}), null);
});

test('possession alternates: score, then pull', () => {
  const { points } = derivePoints(REAL);
  // Yaka received, so they are on offence for point 0 and hold it.
  assert.equal(points[0].oTeam, YAKA);
  assert.equal(points[0].isBreak, false);
  // Having scored, Yaka now pulls — Blueberries receive point 1.
  assert.equal(points[1].oTeam, BLUE);
  // ...and Yaka score it anyway. That is a break.
  assert.equal(points[1].scoreTeam, YAKA);
  assert.equal(points[1].isBreak, true);
});

test('the real 8-point opening decomposes into 2 breaks and 6 holds', () => {
  // Traced by hand against the feed:
  //   P0 Yaka hold (they received)   P4 Yaka hold
  //   P1 Yaka BREAK                  P5 Blue hold
  //   P2 Yaka BREAK                  P6 Yaka hold
  //   P3 Blue hold                   P7 Blue hold
  const { points } = derivePoints(REAL);
  const breaks = points.filter((p) => p.isBreak);
  assert.equal(breaks.length, 2);
  assert.equal(breaks.filter((p) => p.scoreTeam === YAKA).length, 2);
  assert.equal(breaks.filter((p) => p.scoreTeam === BLUE).length, 0);

  // This is the whole point of the exercise. The scoreline says 5-3, a
  // reasonably close game. The chain says Blueberries never once took a point
  // off Yaka's offence — every goal they got was their own hold. Yaka were two
  // breaks up and cruising, which 5-3 does not tell you.
  assert.equal(points.filter((p) => p.scoreTeam === YAKA).length, 5);
  assert.equal(points.filter((p) => p.scoreTeam === BLUE).length, 3);
  assert.deepEqual(points.map((p) => p.isBreak),
    [false, true, true, false, false, false, false, false]);
});

test('every point has exactly one offence and one defence, and they differ', () => {
  const { points } = derivePoints(REAL);
  for (const p of points) {
    assert.ok(p.oTeam && p.dTeam, 'both sides must be assigned');
    assert.notEqual(p.oTeam, p.dTeam);
    assert.ok(p.scoreTeam === p.oTeam || p.scoreTeam === p.dTeam);
  }
});

test('point duration is the gap since the previous goal', () => {
  const { points } = derivePoints(REAL);
  assert.equal(points[0].durationS, 200);   // from the pull
  assert.equal(points[1].durationS, 130);   // 330 - 200
  assert.equal(points[7].durationS, 675);   // 2100 - 1425, a long grind
});

test('a game with no opening event loses two points, not the game', () => {
  // The opening pull decides the offence for the first point of each half and
  // nothing else: every other point follows from who scored the one before.
  const { points, startKnown, secondHalfIndex: h2 } = derivePoints({ ...REAL, gameevents: [] });
  assert.equal(startKnown, false);
  const lost = points.filter((p) => !p.anchored);
  const kept = points.filter((p) => p.anchored);
  assert.ok(kept.length > lost.length, 'most of the game survives');
  assert.deepEqual(lost.map((p) => p.num).sort((a, b) => a - b),
    [0, h2].filter((i) => i >= 0 && i < points.length).sort((a, b) => a - b));
  for (const p of lost) {
    assert.equal(p.isBreak, null);
    assert.equal(p.oTeam, null);
  }
  for (const p of kept) {
    assert.ok(p.oTeam && p.dTeam, 'these need no anchor at all');
    assert.equal(typeof p.isBreak, 'boolean');
  }
  for (const p of points) assert.ok(p.scorerId, 'scorers survive regardless');
});

test('the second half restarts with whoever began the game on defence', () => {
  // Not with whoever conceded the last point of the first half — that has no
  // bearing on it. Half falls after a side reaches 8 when the feed omits the
  // clock reading, so build a game that gets there.
  const goals = [];
  for (let n = 0; n < 16; n += 1) {
    goals.push({ num: n, time: 100 + n * 100, ishomegoal: 1, scorer: 900 + n, assist: null,
                 iscallahan: 0, homescore: n + 1, visitorscore: 0,
                 scorerfirstname: 'S', scorerlastname: String(n) });
  }
  const detail = {
    game_result: { hometeam: 1, visitorteam: 2, halftime: null },
    gameevents: [{ time: 0, ishome: 1, type: 'offence' }],
    goals,
  };
  const { points, secondHalfIndex: h2 } = derivePoints(detail);
  assert.ok(h2 > 0, 'half is found from the score when the clock reading is missing');

  // Home received the opening pull and has scored every point, so by the plain
  // chain they would be on defence forever. At half they must be on defence
  // once more only if they started on offence — the away side receives.
  assert.equal(points[h2].oTeam, 2, 'the side that started on D receives after half');
  assert.equal(points[h2].isBreak, true, 'home scoring it is therefore a break');

  // And the point before half follows the ordinary rule.
  assert.equal(points[h2 - 1].oTeam, 2);
});

test('the point straddling half time has its clock discarded', () => {
  const detail = {
    ...REAL,
    game_result: { ...REAL.game_result, halftime: 1300 },
  };
  const { points } = derivePoints(detail);
  const straddling = points.find((p) => p.spansHalftime);
  assert.ok(straddling, 'one point must span the interval');
  assert.equal(straddling.usableClock, false, 'it carries ten minutes of standing about');
  // Every other point keeps its clock.
  assert.ok(points.filter((p) => p.usableClock).length >= points.length - 2);
});

test('goals are ordered by sequence, not by a corrected clock', () => {
  const scrambled = {
    ...REAL,
    goals: [REAL.goals[2], REAL.goals[0], REAL.goals[1]].map((g, i) => ({ ...g })),
  };
  const ordered = orderedGoals(scrambled).map((g) => g.num);
  assert.deepEqual(ordered, [0, 1, 2]);
});

test('a backwards timestamp cannot produce negative time on offence', () => {
  const detail = {
    ...REAL,
    goals: [
      { ...REAL.goals[0], time: 400 },
      { ...REAL.goals[1], time: 200 },  // scorekeeper correction
    ],
  };
  const { points } = derivePoints(detail);
  for (const p of points) assert.ok(p.durationS >= 0, `got ${p.durationS}`);
});

test('an absurdly long point is kept but its clock is not trusted', () => {
  const detail = {
    ...REAL,
    game_result: { ...REAL.game_result, halftime: null },
    goals: [{ ...REAL.goals[0], time: 4000 }],
  };
  const { points } = derivePoints(detail);
  assert.equal(points.length, 1);
  assert.equal(points[0].usableClock, false, '66 minutes is bad data, not a point');
});

test('timeouts carry the team that called them', () => {
  const detail = {
    ...REAL,
    gameevents: [
      { time: 0, ishome: 1, type: 'offence' },
      { time: 900, ishome: 0, type: 'timeout' },
      { time: 1200, ishome: 1, type: 'timeout' },
    ],
  };
  const tos = deriveTimeouts(detail);
  assert.equal(tos.length, 2);
  assert.equal(tos[0].teamId, BLUE);
  assert.equal(tos[1].teamId, YAKA);
});

test('a timeout converts when the caller scores the next point', () => {
  const detail = {
    ...REAL,
    gameevents: [
      { time: 0, ishome: 1, type: 'offence' },
      { time: 900, ishome: 0, type: 'timeout' },   // Blueberries, next goal at 1105 is Yaka
      { time: 1200, ishome: 0, type: 'timeout' },  // Blueberries, next goal at 1250 is theirs
    ],
  };
  const { points } = derivePoints(detail);
  const out = timeoutOutcomes(points, deriveTimeouts(detail));
  assert.equal(out[0].converted, false);
  assert.equal(out[1].converted, true);
});

test('an empty or malformed game does not throw', () => {
  for (const bad of [{}, { goals: [] }, { game_result: {} }, { goals: null, gameevents: null }]) {
    const out = derivePoints(bad);
    assert.deepEqual(out.points, []);
  }
});
