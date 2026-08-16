import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newTeam,
  winProbability,
  priceGame,
  applyResult,
  expectedMargin,
  marketProbability,
  INITIAL_RD,
} from '../lib/model.js';

const mk = (seed, fieldSize = 45) =>
  newTeam({ id: `t${seed}`, name: `Seed ${seed}`, division: 'open', seed, fieldSize });

test('top seed is rated above bottom seed', () => {
  assert.ok(mk(1).rating > mk(45).rating);
});

test('day-1 prices are pulled toward even money by uncertainty', () => {
  const p = winProbability(mk(1), mk(45));
  // A ~790 Elo gap would be ~0.99 at full confidence; RD 350 must damp it hard.
  assert.ok(p > 0.7, `expected clear favourite, got ${p}`);
  assert.ok(p < 0.93, `expected damped price on day 1, got ${p}`);
});

test('prices tighten as uncertainty falls', () => {
  const a = mk(1), b = mk(45);
  const day1 = winProbability(a, b);
  const later = winProbability({ ...a, rd: 90 }, { ...b, rd: 90 });
  assert.ok(later > day1, `expected confident price to exceed day-1 (${later} vs ${day1})`);
});

test('evenly matched teams price at even money', () => {
  const p = winProbability(mk(20), mk(20));
  assert.equal(Math.round(p * 100), 50);
});

test('the book prices conservatively: implied probabilities sum above 1', () => {
  const { home, away } = priceGame(mk(3), mk(30));
  // The true probabilities still sum to exactly 1 — the margin lives in the
  // price, not in the model's view of the world.
  assert.equal(Math.round((home.prob + away.prob) * 1e4) / 1e4, 1);
  const impliedSum = 1 / home.decimal + 1 / away.decimal;
  assert.ok(impliedSum > 1.02, `implied sum ${impliedSum} should carry a margin`);
  assert.ok(impliedSum < 1.12, `implied sum ${impliedSum} should not be a rip-off`);
});

test('no price ever pays more than the cap', () => {
  for (let seed = 2; seed <= 48; seed += 1) {
    for (const rd of [350, 200, 90]) {
      const p = priceGame({ ...mk(1), rd }, { ...mk(seed), rd });
      assert.ok(p.away.decimal <= 12, `${seed} at rd ${rd} paid ${p.away.decimal}`);
      assert.ok(p.home.decimal >= 1.02);
    }
  }
});

test('a conservative price still ranks the same way as a true one', () => {
  const favourite = priceGame(mk(1), mk(44));
  const closer = priceGame(mk(10), mk(14));
  assert.ok(favourite.home.decimal < closer.home.decimal,
    'the stronger favourite is still the shorter price');
});

test('money on one side shortens that price', () => {
  const a = mk(10), b = mk(12);
  const flat = priceGame(a, b);
  const backed = priceGame(a, b, 20000, 0);
  assert.ok(backed.home.decimal < flat.home.decimal, 'backing home should shorten home');
  assert.ok(backed.away.decimal > flat.away.decimal, 'and lengthen away');
});

test('market probability stays inside bounds under huge stakes', () => {
  const p = marketProbability(0.5, 10_000_000, 0);
  assert.ok(p <= 0.98 && p >= 0.02, `got ${p}`);
});

test('expected margin is bounded and signed correctly', () => {
  const big = expectedMargin(mk(1), mk(45));
  assert.ok(big > 0 && big <= 13, `got ${big}`);
  assert.equal(expectedMargin(mk(45), mk(1)), -big);
  assert.equal(expectedMargin(mk(20), mk(20)), 0);
});

test('margin lands on a half point so bets cannot push', () => {
  const m = expectedMargin(mk(4), mk(28));
  assert.notEqual(m % 1, 0, `margin ${m} should be a half point`);
});

test('a win raises the winner and lowers the loser', () => {
  const a = mk(30), b = mk(5);
  const { home, away } = applyResult(a, b, 15, 9);
  assert.ok(home.rating > a.rating, 'upset winner should gain');
  assert.ok(away.rating < b.rating, 'upset loser should drop');
});

test('uncertainty falls after playing', () => {
  const a = mk(10), b = mk(11);
  const { home } = applyResult(a, b, 15, 13);
  assert.ok(home.rd < INITIAL_RD, `rd should fall from ${INITIAL_RD}, got ${home.rd}`);
  assert.equal(home.played, 1);
});

test('a blowout moves ratings more than a universe point', () => {
  const a = mk(20), b = mk(20);
  const close = applyResult(a, b, 15, 14).home.rating;
  const blowout = applyResult(a, b, 15, 3).home.rating;
  assert.ok(blowout > close, `blowout (${blowout}) should teach more than close (${close})`);
});

test('ratings converge toward reality over a simulated pool', () => {
  // Seed a team badly (seed 40) but let it play like the best team in the pool.
  let underdog = mk(40);
  const field = [mk(5), mk(8), mk(12), mk(15), mk(18)];
  for (const opp of field) {
    underdog = applyResult(underdog, opp, 15, 7).home;
  }
  assert.ok(
    underdog.rating > mk(15).rating,
    `after 5 dominant wins the model should rate it well above its seed (${underdog.rating})`
  );
});
