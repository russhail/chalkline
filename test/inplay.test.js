import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newTeam, winProbability } from '../lib/model.js';
import {
  raceWinProbability, calibratePointProbability, effectiveTarget,
  inPlayProbability, isSuspended, suspensionRemaining, SUSPEND_MS,
} from '../lib/inplay.js';

const mk = (seed, rd) => ({ ...newTeam({ id: seed, name: `S${seed}`, division: 'Open', seed, fieldSize: 48 }),
                            ...(rd ? { rd } : {}) });

test('a coin-flip race from level is a coin flip', () => {
  assert.equal(Math.round(raceWinProbability(0, 0, 15, 0.5) * 1e6) / 1e6, 0.5);
  assert.equal(Math.round(raceWinProbability(7, 7, 15, 0.5) * 1e6) / 1e6, 0.5);
  assert.equal(Math.round(raceWinProbability(14, 14, 15, 0.5) * 1e6) / 1e6, 0.5);
});

test('reaching the target ends it', () => {
  assert.equal(raceWinProbability(15, 9, 15, 0.5), 1);
  assert.equal(raceWinProbability(9, 15, 15, 0.5), 0);
});

test('a lead is always worth more than the same score level', () => {
  for (const p of [0.35, 0.5, 0.65]) {
    assert.ok(raceWinProbability(10, 5, 15, p) > raceWinProbability(5, 5, 15, p));
    assert.ok(raceWinProbability(5, 10, 15, p) < raceWinProbability(5, 5, 15, p));
  }
});

test('win probability rises monotonically with the per-point edge', () => {
  let prev = 0;
  for (const p of [0.3, 0.4, 0.5, 0.6, 0.7]) {
    const w = raceWinProbability(6, 6, 15, p);
    assert.ok(w > prev, `p=${p} should beat the previous`);
    prev = w;
  }
});

test('match point is close to certain, but never certain', () => {
  const w = raceWinProbability(14, 3, 15, 0.5);
  assert.ok(w > 0.99 && w < 1, `got ${w}`);
});

test('a small per-point edge compounds into a large game edge', () => {
  // This is why in-play odds move so much faster than people expect.
  const perPoint = 0.55;
  const game = raceWinProbability(0, 0, 15, perPoint);
  assert.ok(game > 0.68, `55% per point should be ~70% per game, got ${game}`);
});

test('calibration reproduces the pre-game price exactly at 0-0', () => {
  for (const [a, b] of [[1, 44], [3, 26], [10, 12], [20, 21], [1, 8]]) {
    const home = mk(a), away = mk(b);
    const pre = winProbability(home, away);
    const live = inPlayProbability(home, away, { homeScore: 0, awayScore: 0 });
    assert.ok(Math.abs(live.prob - pre) < 1e-3,
      `${a} v ${b}: live ${live.prob} should match pre-game ${pre}`);
  }
});

test('the calibrated per-point edge is far smaller than the game edge', () => {
  const p = calibratePointProbability(0.75);
  assert.ok(p > 0.5 && p < 0.62, `a 75% favourite is only ~${p} per point`);
});

test('going behind swings the price hard', () => {
  const home = mk(10), away = mk(12);
  const level = inPlayProbability(home, away, { homeScore: 0, awayScore: 0 }).prob;
  const behind = inPlayProbability(home, away, { homeScore: 3, awayScore: 8 }).prob;
  const ahead = inPlayProbability(home, away, { homeScore: 8, awayScore: 3 }).prob;
  assert.ok(behind < level - 0.25, `3-8 down should collapse the price (${behind} vs ${level})`);
  assert.ok(ahead > level + 0.25, `8-3 up should surge it (${ahead} vs ${level})`);
});

test('a big favourite trailing late is genuinely in trouble', () => {
  const p = inPlayProbability(mk(1), mk(44), { homeScore: 8, awayScore: 13 }).prob;
  assert.ok(p < 0.55, `a top seed at 8-13 down should not still be favourite (${p})`);
});

test('the time cap shortens the race to leader plus one', () => {
  const uncapped = effectiveTarget({ homeScore: 11, awayScore: 9, elapsedMinutes: 50, timeCapMinutes: 100 });
  assert.deepEqual(uncapped, { target: 15, capped: false });
  const capped = effectiveTarget({ homeScore: 11, awayScore: 9, elapsedMinutes: 101, timeCapMinutes: 100 });
  assert.equal(capped.target, 12);
  assert.equal(capped.capped, true);
  assert.equal(capped.fresh, true, 'first sighting of the cap derives the target');
});

test('under the cap, a lead is worth far more than it was', () => {
  const home = mk(10), away = mk(12);
  const open = inPlayProbability(home, away, { homeScore: 11, awayScore: 9 }).prob;
  const capped = inPlayProbability(home, away, {
    homeScore: 11, awayScore: 9, elapsedMinutes: 101, timeCapMinutes: 100 });
  assert.ok(capped.prob > open, 'the cap converts a lead into a near-win');
  assert.equal(capped.capped, true);
  assert.equal(capped.target, 12);
});

test('a tie under the cap is next point wins', () => {
  const { target, capped } = effectiveTarget({
    homeScore: 12, awayScore: 12, elapsedMinutes: 105, timeCapMinutes: 100 });
  assert.equal(capped, true);
  assert.equal(target, 13);
  const p = inPlayProbability(mk(20), mk(20), {
    homeScore: 12, awayScore: 12, elapsedMinutes: 105, timeCapMinutes: 100 }).prob;
  assert.ok(Math.abs(p - 0.5) < 0.02, 'evenly matched, next point decides');
});

test('betting is suspended for twenty seconds after a point', () => {
  const scored = Date.parse('2026-08-15T14:00:00Z');
  assert.equal(isSuspended(scored, scored + 1000), true);
  assert.equal(isSuspended(scored, scored + SUSPEND_MS - 1), true);
  assert.equal(isSuspended(scored, scored + SUSPEND_MS), false);
  assert.equal(suspensionRemaining(scored, scored + 5000), 15);
  assert.equal(suspensionRemaining(scored, scored + SUSPEND_MS + 5000), 0);
});

test('a game with no recorded point is not suspended', () => {
  assert.equal(isSuspended(null), false);
  assert.equal(isSuspended(undefined), false);
  assert.equal(isSuspended('not a date'), false);
});

test('suspension accepts the Postgres timestamp format', () => {
  const now = Date.parse('2026-08-15T14:00:10Z');
  assert.equal(isSuspended('2026-08-15T14:00:00.000Z', now), true);
});

test('pricing every state of a full game stays inside [0,1] and is finite', () => {
  const home = mk(4), away = mk(30);
  for (let a = 0; a <= 15; a += 1) {
    for (let b = 0; b <= 15; b += 1) {
      if (a === 15 && b === 15) continue;
      const { prob } = inPlayProbability(home, away, { homeScore: a, awayScore: b });
      assert.ok(Number.isFinite(prob) && prob >= 0 && prob <= 1, `${a}-${b} gave ${prob}`);
    }
  }
});

test('a recorded cap target is fixed and does not chase the score', () => {
  // The bug this guards: deriving leader-plus-one on every call. The cap lands
  // at 11-9 so the game is to 12. Home then scores. Recomputing would say the
  // target is now 13, then 14 — the game could never be won and the live price
  // could never reach certainty.
  const capTarget = 12;
  const atCap = effectiveTarget({ homeScore: 11, awayScore: 9, capTarget });
  assert.equal(atCap.target, 12);

  const afterThePoint = effectiveTarget({ homeScore: 12, awayScore: 9, capTarget });
  assert.equal(afterThePoint.target, 12, 'the target must not move once the cap has landed');
  assert.equal(afterThePoint.capped, true);
});

test('reaching a frozen cap target is certainty, not another point to play', () => {
  const home = mk(10), away = mk(12);
  const won = inPlayProbability(home, away, { homeScore: 12, awayScore: 9, capTarget: 12 });
  assert.equal(won.prob, 1, 'the game is over; the price must say so');
  const lost = inPlayProbability(home, away, { homeScore: 9, awayScore: 12, capTarget: 12 });
  assert.equal(lost.prob, 0);
});

test('a stored cap target beats the elapsed-time derivation', () => {
  // Once recorded, the stored value wins even if the clock would derive another.
  const { target } = effectiveTarget({
    homeScore: 13, awayScore: 11, elapsedMinutes: 130, timeCapMinutes: 100, capTarget: 12 });
  assert.equal(target, 12);
});
