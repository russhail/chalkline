import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../lib/store.js';
import { sync } from '../lib/sync.js';
import { PRIORS, MAX_SEED_SHIFT, priorFor, effectiveSeed } from '../lib/priors.js';
import { seedToRating } from '../lib/model.js';

let store;
beforeEach(async () => {
  store = createStore({ backend: 'sqlite' });
  await store.migrate();
});

const teamRow = (id, name, division, seed) => ({
  id, name, abbreviation: name.slice(0, 3).toUpperCase(), division, country: 'X', seed });

const feed = (teams, version = 'v1') => async () => ({
  heartbeat: { cacheVersion: version }, teams,
  fieldSizes: { Open: 48, "Women's": 40, Mixed: 48 }, games: [],
});

test('every prior names a real division and a sane shift', () => {
  for (const p of PRIORS) {
    assert.ok(['Open', "Women's", 'Mixed'].includes(p.division), `bad division on ${p.name}`);
    assert.ok(p.seed >= 1 && p.effectiveSeed >= 1, `bad seeds on ${p.name}`);
    assert.ok(Math.abs(p.effectiveSeed - p.seed) <= MAX_SEED_SHIFT,
      `${p.name} moves further than the cap allows`);
    assert.ok(p.note && p.note.length > 10, `${p.name} has no stated reason`);
  }
});

test('no prior is listed twice for one club and division', () => {
  const keys = PRIORS.map((p) => `${p.division}:${p.name.toLowerCase()}`);
  assert.equal(new Set(keys).size, keys.length, 'duplicate prior');
});

test('a club name shared across divisions is matched by division', () => {
  // GRUT field both an Open and a Women's team; adjusting the wrong one would
  // be invisible and wrong.
  const womens = priorFor('GRUT', "Women's");
  assert.ok(womens, 'the Women\'s entry should match');
  assert.equal(priorFor('GRUT', 'Open'), null, 'the Open team must be left alone');
});

test('matching is case and whitespace insensitive', () => {
  assert.ok(priorFor('  tchac ', 'Open'));
  assert.ok(priorFor('BFD LA FOTTA', 'Open'));
});

test('an unlisted club keeps its raw seed', () => {
  assert.deepEqual(effectiveSeed('Some Club', 'Open', 22), { seed: 22, prior: null });
});

test('the shift is capped however extreme the entry', () => {
  const { seed } = effectiveSeed('Tchac', 'Open', 24);
  assert.ok(Math.abs(seed - 24) <= MAX_SEED_SHIFT);
  assert.ok(seed < 24, 'and it moves in the direction the source implies');
});

test('a promoted club is rated above its raw seed, a demoted one below', async () => {
  const teams = [
    teamRow(1, 'Tchac', 'Open', 24),
    teamRow(2, 'Nobody', 'Open', 24),
    teamRow(3, 'Fury', "Women's", 3),
    teamRow(4, 'Anybody', "Women's", 3),
  ];
  await sync(store, { force: true, fetcher: feed(teams) });
  const rows = await store.query('SELECT name, rating FROM teams ORDER BY id');
  const by = Object.fromEntries(rows.map((r) => [r.name, r.rating]));
  assert.ok(by.Tchac > by.Nobody, 'the dark horse should outrate its seed-mate');
  assert.ok(by.Fury < by.Anybody, 'the flagged underperformer should sit below');
});

test('a prior never claims extra certainty', async () => {
  await sync(store, { force: true, fetcher: feed([teamRow(1, 'Tchac', 'Open', 24)]) });
  const [t] = await store.query('SELECT rd FROM teams WHERE id = 1');
  assert.equal(t.rd, 350, 'a subjective adjustment must not also reduce uncertainty');
});

test('a team that has played is never re-primed', async () => {
  await sync(store, { force: true, fetcher: feed([teamRow(1, 'Tchac', 'Open', 24)]) });
  // Simulate the model learning something quite different.
  await store.query('UPDATE teams SET rating = 1400, played = 3 WHERE id = 1');
  await sync(store, { force: true, fetcher: feed([teamRow(1, 'Tchac', 'Open', 24)], 'v2') });
  const [t] = await store.query('SELECT rating, played FROM teams WHERE id = 1');
  assert.equal(t.rating, 1400, 'evidence beats opinion once there is evidence');
});

test('a team that has not played picks up a changed prior on the next sync', async () => {
  await sync(store, { force: true, fetcher: feed([teamRow(1, 'Nobody', 'Open', 24)]) });
  const [before] = await store.query('SELECT rating FROM teams WHERE id = 1');
  // Rename it to a club that carries a prior — same id, so it's an update.
  const res = await sync(store, { force: true, fetcher: feed([teamRow(1, 'Tchac', 'Open', 24)], 'v2') });
  const [after] = await store.query('SELECT rating FROM teams WHERE id = 1');
  assert.ok(after.rating > before.rating, 'the prior should now apply');
  assert.equal(res.teams.reprimed, 1);
});

test('the rating bonus stacks on top of the seed adjustment', () => {
  const hybrid = priorFor('Hybrid', 'Mixed');
  assert.equal(hybrid.ratingBonus, 60);
  assert.equal(hybrid.effectiveSeed, 1, 'already top seed, so the bonus does the work');
});

test('priors move prices in the direction a reader would expect', async () => {
  const teams = [
    teamRow(1, 'Scandal', "Women's", 7),
    teamRow(2, 'Placeholder', "Women's", 7),
  ];
  await sync(store, { force: true, fetcher: feed(teams) });
  const rows = await store.query('SELECT name, rating FROM teams ORDER BY id');
  const scandal = rows.find((r) => r.name === 'Scandal').rating;
  assert.ok(scandal > seedToRating(7, 40),
    'a club ranked first domestically should not be priced as a 7 seed');
});
