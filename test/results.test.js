import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../lib/store.js';
import { handle } from '../lib/router.js';
import { sync } from '../lib/sync.js';
import { voidGame } from '../lib/betting.js';

const NOW = Date.parse('2026-08-16T18:00:00Z');
let store;

const TEAMS = [
  { id: 1122, name: 'Clapham', abbreviation: 'CLP', division: 'Open', country: 'Great Britain', seed: 4 },
  { id: 1131, name: 'Colony', abbreviation: 'COL', division: 'Open', country: 'Australia', seed: 1 },
  { id: 1109, name: 'Aethers', abbreviation: 'AEW', division: 'Open', country: 'Poland', seed: 12 },
  { id: 1104, name: 'Blueberries', abbreviation: 'BLU', division: "Women's", country: 'New Zealand', seed: 2 },
  { id: 1047, name: 'NLSU Yaka', abbreviation: 'YAK', division: "Women's", country: 'France', seed: 16 },
];

const game = (over) => ({
  homeLabel: null, awayLabel: null, poolId: 1, poolName: 'Pool A',
  status: 'final', ongoing: false, valid: true, ...over,
});

// Two days of results, both divisions, and the three states a finished game can
// be in: played out, abandoned, and forfeited. The fixture on the 16th has no
// score at all, which is how we can tell the results page from the board.
const GAMES = [
  game({ id: 1, homeTeamId: 1131, awayTeamId: 1109, division: 'Open',
         startsAt: '2026-08-15T14:00:00Z', homeScore: 15, awayScore: 9 }),
  game({ id: 2, homeTeamId: 1122, awayTeamId: 1131, division: 'Open',
         startsAt: '2026-08-15T16:00:00Z', homeScore: 15, awayScore: 13 }),
  // Abandoned with the score standing at 9-7, and voided in the fixture below.
  // It never reached 'final', so the sync leaves it alone and the void is the
  // only thing that ever happens to it.
  game({ id: 3, homeTeamId: 1104, awayTeamId: 1047, division: "Women's", poolName: 'Pool D',
         startsAt: '2026-08-15T09:00:00Z', status: 'live', homeScore: 9, awayScore: 7 }),
  game({ id: 4, homeTeamId: 1047, awayTeamId: 1104, division: "Women's", poolName: 'Pool D',
         startsAt: '2026-08-14T10:00:00Z', homeScore: 12, awayScore: 15 }),
  // A forfeit is deliberately never settled automatically — Russell rules on
  // those by hand — but the score is on the record and has to be shown.
  game({ id: 5, homeTeamId: 1109, awayTeamId: 1122, division: 'Open', poolName: 'Pool B',
         startsAt: '2026-08-14T12:00:00Z', homeScore: 15, awayScore: 0, forfeit: true }),
  game({ id: 6, homeTeamId: 1131, awayTeamId: 1122, division: 'Open',
         startsAt: '2026-08-16T20:00:00Z', status: 'scheduled', homeScore: null, awayScore: null }),
];

// Ratings are set by hand rather than played out. Letting Glicko produce them
// would make the order these tests expect a function of the rating maths, so a
// change there would fail here for reasons that have nothing to do with the
// endpoint. Each one is chosen to disagree with the seeding in a stated way.
const RATINGS = [
  [1122, 1900, 3],  // Open, seeded 4th  -> ranked 1st: the model's big disagreement
  [1131, 1700, 2],  // Open, seeded 1st  -> ranked 2nd, and exactly on the sample gate
  [1109, 1500, 1],  // Open, seeded 12th -> ranked 3rd, on a single game
  [1104, 1600, 4],  // Women's, seeded 2nd  -> ranked 1st, third on rating overall
  [1047, 1550, 0],  // Women's, seeded 16th -> ranked 2nd, never played
];

const call = (method, url) =>
  handle({ method, url, headers: {} }, { store, now: NOW, autoSync: false });

// Read a page that is supposed to work. Going through this rather than
// reaching straight into res.body means a broken endpoint fails with the
// server's own error message instead of "cannot read property of undefined".
const read = async (url) => {
  const res = await call('GET', url);
  assert.equal(res.status, 200, `GET ${url} — ${res.body.error}`);
  return res.body;
};

beforeEach(async () => {
  store = createStore({ backend: 'sqlite' });
  await store.migrate();
  await sync(store, {
    force: true, now: NOW,
    fetcher: async () => ({
      heartbeat: { cacheVersion: 'v1' }, teams: TEAMS,
      fieldSizes: { Open: 48, "Women's": 40 }, games: GAMES,
    }),
  });
  await voidGame(store, { gameId: 3, reason: 'Storm cell over the fields', clock: () => NOW });
  for (const [id, rating, played] of RATINGS) {
    await store.query('UPDATE teams SET rating = $1, played = $2 WHERE id = $3',
      [rating, played, id]);
  }
});

// --- /api/results -----------------------------------------------------------

test('the results page opens on the most recent day and leads with the last game played', async () => {
  const body = await read('/api/results');
  assert.equal(body.day, '2026-08-15');
  // 16:00, then 14:00, then the 09:00 abandonment. On a results page the thing
  // you came for is the game that just ended, so newest first is the only order.
  assert.deepEqual(body.games.map((g) => g.id), [2, 1, 3]);
});

test('the day index runs newest first and lists only days that have a result', async () => {
  const { days } = await read('/api/results');
  assert.deepEqual(days, [
    { day: '2026-08-15', games: 3 },
    { day: '2026-08-14', games: 2 },
  ]);
});

test('an earlier day can be asked for, and asking does not shrink the day index', async () => {
  const body = await read('/api/results?day=2026-08-14');
  assert.equal(body.day, '2026-08-14');
  assert.deepEqual(body.games.map((g) => g.id), [5, 4]);
  assert.equal(body.days.length, 2, 'the picker must still offer every other day');
});

test('a division filter narrows the games without narrowing the day index', async () => {
  const open = await read('/api/results?division=Open');
  assert.deepEqual(open.games.map((g) => g.id), [2, 1]);
  assert.ok(open.games.every((g) => g.division === 'Open'));
  assert.equal(open.days.length, 2, 'the days belong to the tournament, not to the filter');

  const womens = await read("/api/results?day=2026-08-14&division=Women's");
  assert.deepEqual(womens.games.map((g) => g.id), [4]);
});

test('a result carries the score and both clubs, country and seed included', async () => {
  const g = (await read('/api/results')).games.find((x) => x.id === 1);
  assert.deepEqual(g.score, { home: 15, away: 9 });
  assert.deepEqual(g.home, { id: 1131, name: 'Colony', country: 'Australia', seed: 1 });
  assert.deepEqual(g.away, { id: 1109, name: 'Aethers', country: 'Poland', seed: 12 });
  assert.equal(g.division, 'Open');
  assert.equal(g.pool, 'Pool A');
  // Normalised on the way out, because Postgres hands back '2026-08-15 14:00:00+00'
  // and Safari reads that as Invalid Date.
  assert.equal(g.startsAt, '2026-08-15T14:00:00.000Z');
  assert.equal(g.voided, false);
  assert.equal(g.forfeit, false);
  assert.equal(g.voidReason, null);
});

test('an abandoned game keeps its place in the results, marked void and with the reason', async () => {
  const g = (await read('/api/results')).games.find((x) => x.id === 3);
  assert.ok(g, 'a game that was abandoned is still something that happened');
  assert.equal(g.voided, true);
  assert.equal(g.voidReason, 'Storm cell over the fields');
  assert.deepEqual(g.score, { home: 9, away: 7 }, 'the score it stood at when it stopped');
});

test('a forfeit is flagged rather than passed off as a game that was played', async () => {
  const g = (await read('/api/results?day=2026-08-14')).games.find((x) => x.id === 5);
  assert.equal(g.forfeit, true);
  assert.equal(g.voided, false);
  assert.deepEqual(g.score, { home: 15, away: 0 });
});

test('a fixture with no score yet belongs to the board, not to the results', async () => {
  const results = await read('/api/results?day=2026-08-16');
  assert.equal(results.day, '2026-08-16');
  assert.deepEqual(results.games, []);
  const board = await read('/api/games?day=2026-08-16');
  assert.ok(board.games.some((g) => g.id === 6), 'it is still to come');
});

test('a tournament with nothing played yet answers with an empty page rather than an error', async () => {
  const fresh = createStore({ backend: 'sqlite' });
  await fresh.migrate();
  const res = await handle({ method: 'GET', url: '/api/results', headers: {} },
    { store: fresh, now: NOW, autoSync: false });
  assert.equal(res.status, 200);
  assert.equal(res.body.day, null, 'there is no day to open on');
  assert.deepEqual(res.body.days, []);
  assert.deepEqual(res.body.games, []);
  fresh.close();
});

// --- /api/rankings ----------------------------------------------------------

test('a division is ordered by what the model has learned, not by the seeding', async () => {
  const { teams } = await read('/api/rankings?division=Open');
  assert.deepEqual(teams.map((t) => t.name), ['Clapham', 'Colony', 'Aethers']);
  assert.deepEqual(teams.map((t) => t.rating), [1900, 1700, 1500]);
  assert.deepEqual(teams.map((t) => t.seed), [4, 1, 12], 'the seeding would have led with Colony');
});

test('position is numbered from one inside each division, never across the tournament', async () => {
  const { teams } = await read('/api/rankings');
  const open = teams.filter((t) => t.division === 'Open');
  const womens = teams.filter((t) => t.division === "Women's");
  assert.deepEqual(open.map((t) => t.position), [1, 2, 3]);
  assert.deepEqual(womens.map((t) => t.position), [1, 2]);

  // Blueberries are third on rating across the whole field, behind two Open
  // clubs. Numbering the divisions together would print them as third in their
  // own — which is the bug this test exists for.
  const blue = teams.find((t) => t.name === 'Blueberries');
  assert.equal(blue.position, 1);
  assert.equal(teams.filter((t) => t.rating > blue.rating).length, 2);
});

test('seedDelta is positive when the model rates a club above where it was seeded', async () => {
  const { teams } = await read('/api/rankings');
  const by = Object.fromEntries(teams.map((t) => [t.name, t]));
  assert.equal(by.Clapham.seedDelta, 3, 'seeded 4th, ranked 1st');
  assert.equal(by['NLSU Yaka'].seedDelta, 14, 'seeded 16th, ranked 2nd of two');
  assert.equal(by.Colony.seedDelta, -1, 'seeded 1st, ranked 2nd — the model disagrees downwards');
  for (const t of teams) {
    assert.equal(t.seedDelta, t.seed - t.position, `${t.name} must be seed minus position`);
  }
});

test('a club with fewer than two games is provisional, however high it ranks', async () => {
  const { teams } = await read('/api/rankings');
  const by = Object.fromEntries(teams.map((t) => [t.name, t]));
  assert.equal(by.Aethers.provisional, true, 'one game is not yet the model talking');
  assert.equal(by['NLSU Yaka'].provisional, true, 'and none at all is only the seeding');
  // Two is the gate and it is inclusive, so a club sitting exactly on it is
  // ranked without the caveat.
  assert.equal(by.Colony.played, 2);
  assert.equal(by.Colony.provisional, false);
  assert.equal(by.Clapham.provisional, false);
});

test('a division filter answers with that division alone, numbered as it always was', async () => {
  const { teams } = await read("/api/rankings?division=Women's");
  assert.deepEqual(teams.map((t) => t.name), ['Blueberries', 'NLSU Yaka']);
  assert.deepEqual(teams.map((t) => t.position), [1, 2],
    'a filter is a view of the table, not a different table');
});

test('a ranked club carries the identity and the uncertainty behind its rating', async () => {
  const [top] = (await read('/api/rankings?division=Open')).teams;
  assert.equal(top.teamId, 1122);
  assert.equal(top.abbreviation, 'CLP');
  assert.equal(top.country, 'Great Britain');
  assert.equal(top.division, 'Open');
  assert.equal(top.played, 3);
  // rd travels with every row because a club the model has barely seen is not
  // really ranked, and a position without that caveat invites an argument the
  // number cannot support.
  assert.ok(top.rd > 0, 'the uncertainty must be on the row');
});
