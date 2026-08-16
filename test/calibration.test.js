import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../lib/store.js';
import { sync } from '../lib/sync.js';
import { settleGame } from '../lib/betting.js';
import { priceGame } from '../lib/model.js';
import { calibration } from '../lib/dashboard.js';

const NOW = Date.parse('2026-08-16T18:00:00Z');
let store;

const TEAMS = [
  { id: 1, name: 'Strong', abbreviation: 'STR', division: 'Open', country: 'USA', seed: 1 },
  { id: 2, name: 'Weak', abbreviation: 'WEA', division: 'Open', country: 'IRL', seed: 20 },
];

const game = (id, extra = {}) => ({
  id, homeTeamId: 1, awayTeamId: 2, homeLabel: null, awayLabel: null,
  division: 'Open', poolName: 'Pool A', poolId: 1,
  startsAt: '2026-08-16T10:00:00Z', status: 'scheduled', ongoing: false,
  homeScore: null, awayScore: null, valid: true, ...extra,
});

const seed = async (games) => sync(store, {
  force: true, now: NOW,
  fetcher: async () => ({
    heartbeat: { cacheVersion: `v${games.length}${games[0].id}` }, teams: TEAMS,
    fieldSizes: { Open: 40 }, games,
  }),
});

const ratings = async () => {
  const rows = await store.query('SELECT * FROM teams ORDER BY id');
  return { home: rows[0], away: rows[1] };
};

beforeEach(async () => {
  store = createStore({ backend: 'sqlite' });
  await store.migrate();
  await seed([game(500)]);
});

test('the prediction is written at settlement, from the ratings as they stood', async () => {
  const before = await ratings();
  const expected = priceGame(before.home, before.away).modelProb;

  await settleGame(store, { gameId: 500, homeScore: 15, awayScore: 9, clock: () => NOW });

  const [g] = await store.query('SELECT pred_home_prob FROM games WHERE id = 500');
  assert.ok(g.pred_home_prob !== null, 'a settled game must carry what was predicted');
  assert.equal(Math.round(Number(g.pred_home_prob) * 1e4), Math.round(expected * 1e4));
});

test('the stored prediction is NOT what you would compute afterwards', async () => {
  // This is the whole point of storing it. Once applyResult runs, both ratings
  // have moved towards the result, so recomputing the "prediction" would be
  // scoring the model on an answer sheet it has already read.
  await settleGame(store, { gameId: 500, homeScore: 15, awayScore: 9, clock: () => NOW });

  const [g] = await store.query('SELECT pred_home_prob FROM games WHERE id = 500');
  const after = await ratings();
  const recomputed = priceGame(after.home, after.away).modelProb;

  assert.notEqual(Math.round(Number(g.pred_home_prob) * 1e4), Math.round(recomputed * 1e4),
    'if these matched, the snapshot would be doing nothing');
  assert.ok(recomputed > Number(g.pred_home_prob),
    'having watched Strong win by six, the model now rates them higher than it did');
});

test('a game with no recorded prediction is absent, not counted as wrong', async () => {
  // Every game settled before this shipped is in exactly this state, and there
  // is no honest way to fill them in.
  await store.query('UPDATE games SET settled = TRUE, home_score = 15, away_score = 9 WHERE id = 500');
  const c = await calibration(store);
  assert.equal(c.games, 0);
  assert.equal(c.brier, null, 'an empty record must not score as perfect');
  assert.equal(c.favouriteAccuracy, null);
});

test('predictions are folded onto the favourite so both ends share a bucket', async () => {
  // A 78% home prediction and a 22% one are the same claim seen from opposite
  // ends of the fixture, so they belong in one bucket rather than two.
  //
  // Written directly rather than settled, deliberately: settling two games in
  // sequence moves the ratings between them, so the second prediction would
  // not be the mirror of the first. What is under test here is the folding,
  // not the snapshot — the two tests above cover that.
  await seed([game(501), game(502)]);
  await store.query(
    `UPDATE games SET settled = TRUE, home_score = 15, away_score = 9, pred_home_prob = 0.78
     WHERE id = 501`);
  await store.query(
    `UPDATE games SET settled = TRUE, home_score = 9, away_score = 15, pred_home_prob = 0.22
     WHERE id = 502`);

  const c = await calibration(store);
  assert.equal(c.games, 2, 'game 500 is still unsettled and contributes nothing');
  const used = c.buckets.filter((b) => b.games > 0);
  assert.equal(used.length, 1, 'both land in the same bucket');
  assert.equal(used[0].label, '70\u201380%');
  assert.equal(used[0].predicted, 78);
  assert.equal(used[0].actual, 100, 'the favourite won both, from opposite ends');
});

test('the Brier score rewards being right and confident', async () => {
  await settleGame(store, { gameId: 500, homeScore: 15, awayScore: 9, clock: () => NOW });
  const good = (await calibration(store)).brier;

  // Same fixture, opposite result: the model was confident and wrong.
  const other = createStore({ backend: 'sqlite' });
  await other.migrate();
  const keep = store; store = other;
  await seed([game(500)]);
  await settleGame(store, { gameId: 500, homeScore: 9, awayScore: 15, clock: () => NOW });
  const bad = (await calibration(store)).brier;
  store = keep;

  assert.ok(good < bad, 'a confident correct call must score better than a confident wrong one');
  assert.ok(good >= 0 && bad <= 1);
  other.close();
});

test('a voided game never reaches the record', async () => {
  await settleGame(store, { gameId: 500, homeScore: 15, awayScore: 9, clock: () => NOW });
  assert.equal((await calibration(store)).games, 1);
  await store.query('UPDATE games SET voided = TRUE WHERE id = 500');
  assert.equal((await calibration(store)).games, 0,
    'an abandoned game tells you nothing about the model');
});

test('calibration can be read for one division', async () => {
  await settleGame(store, { gameId: 500, homeScore: 15, awayScore: 9, clock: () => NOW });
  assert.equal((await calibration(store, { division: 'Open' })).games, 1);
  assert.equal((await calibration(store, { division: "Women's" })).games, 0);
});
