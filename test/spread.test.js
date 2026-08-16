import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../lib/store.js';
import { newTeam, spreadLadder, coversSpread, coverProbability } from '../lib/model.js';
import { placeBet, settleGame, quote, BetError } from '../lib/betting.js';

const KICKOFF = '2026-08-16T14:00:00Z';
const clock = () => Date.parse('2026-08-16T10:00:00Z');
let store;

beforeEach(async () => {
  store = createStore({ backend: 'sqlite' });
  await store.migrate();
  for (const [seed, name] of [[3, 'Colony'], [26, 'Pelicanos']]) {
    const t = newTeam({ id: seed, name, division: 'Open', seed, fieldSize: 48 });
    await store.query(
      'INSERT INTO teams (id,name,division,seed,rating,rd,played) VALUES ($1,$2,$3,$4,$5,$6,0)',
      [t.id, t.name, t.division, t.seed, t.rating, t.rd]
    );
  }
  await store.query(
    `INSERT INTO games (id,home_team_id,away_team_id,division,pool_name,starts_at,status)
     VALUES (1,3,26,'Open','Pool A',$1,'scheduled')`, [KICKOFF]);
  for (const name of ['Russ', 'Sam']) {
    await store.query(
      `INSERT INTO users (display_name,recovery_hash,created_at) VALUES ($1,'x',$2)`,
      [name, '2026-08-15T00:00:00Z']);
  }
});

const mk = (seed) => newTeam({ id: seed, name: `S${seed}`, division: 'Open', seed, fieldSize: 48 });

test('every line in every matchup sits on a half point', () => {
  // Checking one pairing is how a whole-number line slipped through: most
  // matchups happen to land on a half, and the ones that don't are exactly
  // the ones that would silently resolve a tied margin against the backer.
  let checked = 0;
  for (let a = 1; a <= 48; a += 1) {
    for (let b = 1; b <= 48; b += 1) {
      if (a === b) continue;
      for (const rd of [350, 200, 90]) {
        const rungs = spreadLadder({ ...mk(a), rd }, { ...mk(b), rd });
        assert.equal(rungs.length, 3);
        for (const r of rungs) {
          assert.notEqual(r.line % 1, 0, `${a} v ${b} (rd ${rd}) gave a pushable line ${r.line}`);
          assert.equal(Math.abs(r.line % 1), 0.5, `line ${r.line} is not a half point`);
        }
        assert.ok(rungs[0].line < rungs[1].line && rungs[1].line < rungs[2].line);
        checked += rungs.length;
      }
    }
  }
  assert.ok(checked > 20000, `only checked ${checked} lines`);
});

test('an exactly-level game is impossible to tie against any line', () => {
  for (let margin = 0; margin <= 15; margin += 1) {
    for (const rungs of [spreadLadder(mk(1), mk(44)), spreadLadder(mk(20), mk(21))]) {
      for (const r of rungs) {
        assert.notEqual(margin, r.line, 'a margin can never equal a line');
      }
    }
  }
});

test('the middle rung prices close to even money', () => {
  const [, mid] = spreadLadder(mk(10), mk(12));
  assert.ok(Math.abs(mid.home.decimal - 2) < 0.35, `middle rung was ${mid.home.decimal}`);
});

test('giving more points shortens the underdog and lengthens the favourite', () => {
  const [easy, , hard] = spreadLadder(mk(1), mk(44));
  assert.ok(hard.home.decimal > easy.home.decimal, 'harder line pays the favourite more');
  assert.ok(hard.away.decimal < easy.away.decimal, 'and the dog less');
});

test('every rung is true odds — the two sides sum to one', () => {
  for (const r of spreadLadder(mk(5), mk(30))) {
    assert.ok(Math.abs(r.home.prob + r.away.prob - 1) < 1e-6);
  }
});

test('an uncertain model offers looser prices than a confident one', () => {
  const wide = coverProbability(mk(1), mk(44), 6);
  const tight = coverProbability({ ...mk(1), rd: 80 }, { ...mk(44), rd: 80 }, 6);
  assert.ok(tight > wide, 'confidence should make covering a modest line more likely');
});

test('covering is decided strictly, with no ties possible', () => {
  assert.equal(coversSpread(15, 10, 4.5), true);
  assert.equal(coversSpread(15, 10, 5.5), false);
  assert.equal(coversSpread(10, 15, -4.5), false);
  assert.equal(coversSpread(10, 15, -5.5), true);
});

test('a spread bet takes the price of the rung it asked for', async () => {
  const q = await quote(store, 1, { clock });
  const rung = q.spreads[2];
  const bet = await placeBet(store, {
    userId: 1, gameId: 1, side: 'home', market: 'spread', line: rung.line, stake: 1000, clock });
  assert.equal(bet.market, 'spread');
  assert.equal(bet.line, rung.line);
  assert.equal(bet.odds, rung.home.decimal);
});

test('you cannot invent your own handicap', async () => {
  for (const line of [0, 99, -99, 1.7, null, undefined, 'nice try']) {
    await assert.rejects(
      () => placeBet(store, { userId: 1, gameId: 1, side: 'home', market: 'spread', line, stake: 100, clock }),
      (e) => e instanceof BetError && e.code === 'bad_line', `line ${line} should be refused`);
  }
});

test('a client-supplied price is ignored', async () => {
  const q = await quote(store, 1, { clock });
  const rung = q.spreads[0];
  const bet = await placeBet(store, {
    userId: 1, gameId: 1, side: 'away', market: 'spread', line: rung.line,
    stake: 100, odds: 999, clock });
  assert.equal(bet.odds, rung.away.decimal, 'the server prices it, not the caller');
});

test('a spread bet settles on the margin, not the winner', async () => {
  const q = await quote(store, 1, { clock });
  const rung = q.spreads.find((s) => s.line > 0) || q.spreads[2];
  // Back the favourite to cover, then have them win by less than the line.
  const bet = await placeBet(store, {
    userId: 1, gameId: 1, side: 'home', market: 'spread', line: rung.line, stake: 1000, clock });
  const margin = Math.floor(rung.line) - 1;
  await settleGame(store, { gameId: 1, homeScore: 15, awayScore: 15 - Math.max(1, margin), clock });

  const [row] = await store.query('SELECT status FROM bets WHERE id = $1', [bet.betId]);
  assert.equal(row.status, 'lost', 'won the game but failed to cover');
});

test('the underdog side wins when the favourite wins narrowly', async () => {
  const q = await quote(store, 1, { clock });
  const rung = q.spreads[2];
  const bet = await placeBet(store, {
    userId: 2, gameId: 1, side: 'away', market: 'spread', line: rung.line, stake: 1000, clock });
  await settleGame(store, { gameId: 1, homeScore: 15, awayScore: 14, clock });
  const [row] = await store.query('SELECT status, payout FROM bets WHERE id = $1', [bet.betId]);
  assert.equal(row.status, 'won');
  assert.ok(row.payout > 1000);
});

test('spread money does not move the moneyline', async () => {
  const before = await quote(store, 1, { clock });
  await placeBet(store, {
    userId: 1, gameId: 1, side: 'home', market: 'spread',
    line: before.spreads[1].line, stake: 9000, clock });
  const after = await quote(store, 1, { clock });
  assert.equal(after.home.decimal, before.home.decimal,
    'a handicap bet must not drift the win market');
  const [g] = await store.query('SELECT stake_home FROM games WHERE id = 1');
  assert.equal(g.stake_home, 0);
});

test('moneyline and spread bets on one game settle independently', async () => {
  const q = await quote(store, 1, { clock });
  const rung = q.spreads[2];
  const ml = await placeBet(store, { userId: 1, gameId: 1, side: 'home', stake: 1000, clock });
  const sp = await placeBet(store, {
    userId: 1, gameId: 1, side: 'home', market: 'spread', line: rung.line, stake: 1000, clock });
  await settleGame(store, { gameId: 1, homeScore: 15, awayScore: 14, clock });

  const rows = await store.query('SELECT id, market, status FROM bets ORDER BY id');
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(byId[ml.betId].status, 'won', 'they won the game');
  assert.equal(byId[sp.betId].status, 'lost', 'but did not cover a big handicap');
});

test('an unknown market is refused', async () => {
  await assert.rejects(
    () => placeBet(store, { userId: 1, gameId: 1, side: 'home', market: 'parlay', stake: 100, clock }),
    (e) => e.code === 'bad_market');
});
