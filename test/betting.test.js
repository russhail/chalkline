import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../lib/store.js';
import { newTeam } from '../lib/model.js';
import {
  placeBet, settleGame, voidGame, quote, topUpStuck, leaderboards, isLocked,
  BetError, MIN_STAKE,
} from '../lib/betting.js';

const START = Date.parse('2026-08-16T10:00:00Z');
const KICKOFF = '2026-08-16T14:00:00Z';
let store;

async function seed() {
  store = createStore({ backend: 'sqlite' });
  await store.migrate();
  for (const [seedNo, name] of [[3, 'Colony'], [26, 'Pelicanos']]) {
    const t = newTeam({ id: 1000 + seedNo, name, division: 'Open', seed: seedNo, fieldSize: 48 });
    await store.query(
      'INSERT INTO teams (id,name,division,seed,rating,rd,played) VALUES ($1,$2,$3,$4,$5,$6,0)',
      [t.id, t.name, t.division, t.seed, t.rating, t.rd]
    );
  }
  await store.query(
    `INSERT INTO games (id,home_team_id,away_team_id,division,pool_name,starts_at,status)
     VALUES (1,1003,1026,'Open','Pool A',$1,'scheduled')`,
    [KICKOFF]
  );
  for (const name of ['Russ', 'Sam', 'Nell']) {
    await store.query(
      `INSERT INTO users (display_name,recovery_hash,created_at) VALUES ($1,'x',$2)`,
      [name, '2026-08-15T00:00:00Z']
    );
  }
}

beforeEach(seed);
const clock = () => START;

test('a bet debits the bankroll and locks in the shown price', async () => {
  const q = await quote(store, 1);
  const bet = await placeBet(store, { userId: 1, gameId: 1, side: 'home', stake: 1000, clock });
  assert.equal(bet.odds, q.home.decimal);
  assert.equal(bet.bankroll, 9000);
  assert.equal(bet.toReturn, Math.round(1000 * q.home.decimal * 100) / 100);
});

test('you cannot stake more than you have', async () => {
  await assert.rejects(
    () => placeBet(store, { userId: 1, gameId: 1, side: 'home', stake: 99999, clock }),
    (e) => e instanceof BetError && e.code === 'insufficient'
  );
  const [u] = await store.query('SELECT bankroll FROM users WHERE id=1');
  assert.equal(u.bankroll, 10000, 'a rejected bet must not move the bankroll');
});

test('stake below the minimum is refused', async () => {
  await assert.rejects(
    () => placeBet(store, { userId: 1, gameId: 1, side: 'home', stake: MIN_STAKE - 1, clock }),
    (e) => e.code === 'bad_stake'
  );
});

test('betting closes at the scheduled start, no exceptions', async () => {
  const atKickoff = () => Date.parse(KICKOFF);
  await assert.rejects(
    () => placeBet(store, { userId: 1, gameId: 1, side: 'home', stake: 100, clock: atKickoff }),
    (e) => e.code === 'locked'
  );
  const oneSecondBefore = () => Date.parse(KICKOFF) - 1000;
  const ok = await placeBet(store, { userId: 1, gameId: 1, side: 'home', stake: 100, clock: oneSecondBefore });
  assert.ok(ok.betId);
});

test('the line moves as money arrives', async () => {
  const before = await quote(store, 1);
  await placeBet(store, { userId: 1, gameId: 1, side: 'home', stake: 9000, clock });
  const after = await quote(store, 1);
  assert.ok(after.home.decimal < before.home.decimal, 'backed side should shorten');
  assert.ok(after.away.decimal > before.away.decimal, 'other side should drift');
});

test('an earlier bettor keeps the better price', async () => {
  const first = await placeBet(store, { userId: 1, gameId: 1, side: 'away', stake: 500, clock });
  await placeBet(store, { userId: 2, gameId: 1, side: 'away', stake: 9000, clock });
  const third = await placeBet(store, { userId: 3, gameId: 1, side: 'away', stake: 500, clock });
  assert.ok(first.odds > third.odds, `early price ${first.odds} should beat late ${third.odds}`);
});

test('settlement pays winners at their locked odds and zeroes losers', async () => {
  const win = await placeBet(store, { userId: 1, gameId: 1, side: 'home', stake: 1000, clock });
  await placeBet(store, { userId: 2, gameId: 1, side: 'away', stake: 1000, clock });
  await settleGame(store, { gameId: 1, homeScore: 15, awayScore: 12, clock });

  const [a] = await store.query('SELECT bankroll FROM users WHERE id=1');
  const [b] = await store.query('SELECT bankroll FROM users WHERE id=2');
  assert.equal(a.bankroll, Math.round((9000 + 1000 * win.odds) * 100) / 100);
  assert.equal(b.bankroll, 9000, 'loser stays down their stake');
});

test('settling twice does not pay out twice', async () => {
  await placeBet(store, { userId: 1, gameId: 1, side: 'home', stake: 1000, clock });
  await settleGame(store, { gameId: 1, homeScore: 15, awayScore: 12, clock });
  const [after] = await store.query('SELECT bankroll FROM users WHERE id=1');
  const again = await settleGame(store, { gameId: 1, homeScore: 15, awayScore: 12, clock });
  assert.equal(again.alreadySettled, true);
  const [same] = await store.query('SELECT bankroll FROM users WHERE id=1');
  assert.equal(same.bankroll, after.bankroll);
});

test('settlement feeds the result back into the ratings', async () => {
  const [before] = await store.query('SELECT rating,rd FROM teams WHERE id=1026');
  await settleGame(store, { gameId: 1, homeScore: 6, awayScore: 15, clock });
  const [after] = await store.query('SELECT rating,rd,played FROM teams WHERE id=1026');
  assert.ok(after.rating > before.rating, 'the upset winner should gain rating');
  assert.ok(after.rd < before.rd, 'and become less uncertain');
  assert.equal(after.played, 1);
});

test('a level score is rejected rather than silently settled', async () => {
  await assert.rejects(
    () => settleGame(store, { gameId: 1, homeScore: 14, awayScore: 14, clock }),
    (e) => e.code === 'draw'
  );
});

test('voiding refunds every open stake in full', async () => {
  await placeBet(store, { userId: 1, gameId: 1, side: 'home', stake: 2500, clock });
  await placeBet(store, { userId: 2, gameId: 1, side: 'away', stake: 4000, clock });
  const res = await voidGame(store, { gameId: 1, reason: 'Waterlogged pitch', clock });
  assert.equal(res.refunded, 2);
  for (const id of [1, 2]) {
    const [u] = await store.query('SELECT bankroll FROM users WHERE id=$1', [id]);
    assert.equal(u.bankroll, 10000, `user ${id} should be made whole`);
  }
});

test('a voided game cannot then be settled', async () => {
  await voidGame(store, { gameId: 1, reason: 'Forfeit', clock });
  await assert.rejects(
    () => settleGame(store, { gameId: 1, homeScore: 15, awayScore: 0, clock }),
    (e) => e.code === 'settled'
  );
});

test('a settled game is no longer bettable', async () => {
  await settleGame(store, { gameId: 1, homeScore: 15, awayScore: 10, clock });
  await assert.rejects(
    () => placeBet(store, { userId: 3, gameId: 1, side: 'home', stake: 100, clock }),
    (e) => e.code === 'locked'
  );
});

test('a player with nothing left and nothing riding is topped up at once', async () => {
  await store.query('UPDATE users SET bankroll = 0 WHERE id = 1');
  const first = await topUpStuck(store, { clock });
  assert.equal(first.toppedUp, 1);
  const [u] = await store.query('SELECT bankroll, granted, topups FROM users WHERE id=1');
  assert.equal(u.bankroll, 2000);
  assert.equal(u.granted, 12000, 'the house has now handed over 12,000 in total');
  assert.equal(u.topups, 1);
});

test('a top-up buys playing time, not a better rank', async () => {
  // The whole point: busting and re-upping must leave you further behind, or
  // the optimal play is to shove the lot on the longest price every time.
  await store.query('UPDATE users SET bankroll = 0 WHERE id = 1');
  await topUpStuck(store, { clock });
  await store.query('UPDATE users SET bankroll = 0 WHERE id = 1');
  await topUpStuck(store, { clock });

  const lb = await leaderboards(store);
  const busted = lb.bankroll.find((r) => r.id === 1);
  // Lost the 10,000 opener, then lost a 2,000 top-up: 12,000 down, and the
  // second top-up is sitting in the account uncounted.
  assert.equal(busted.net, -12000);
  assert.equal(busted.topups, 2);

  const untouched = lb.bankroll.find((r) => r.id === 2);
  assert.equal(untouched.net, 0, 'someone who has not bet is level, and ranks above');
  assert.ok(lb.bankroll.indexOf(untouched) < lb.bankroll.indexOf(busted));
});

test('a player with money still riding is not topped up', async () => {
  await placeBet(store, { userId: 1, gameId: 1, side: 'home', stake: 9000, clock });
  await store.query('UPDATE users SET bankroll = 0 WHERE id = 1');
  const res = await topUpStuck(store, { clock });
  assert.equal(res.toppedUp, 0, 'an open bet might still pay; free money on top of it is a gift');
  const [u] = await store.query('SELECT bankroll FROM users WHERE id=1');
  assert.equal(u.bankroll, 0);
});

test('a player too poor to meet the minimum stake counts as stuck', async () => {
  await store.query('UPDATE users SET bankroll = 3 WHERE id = 1');
  const res = await topUpStuck(store, { clock });
  assert.equal(res.toppedUp, 1, '3 bucks with a minimum stake of 10 is not playable');
});

test('top-up leaves solvent players alone', async () => {
  await topUpStuck(store, { clock });
  const [u] = await store.query('SELECT bankroll, granted FROM users WHERE id=2');
  assert.equal(u.bankroll, 10000);
  assert.equal(u.granted, 10000);
});

test('leaderboards rank by bankroll and compute ROI on settled bets only', async () => {
  await placeBet(store, { userId: 1, gameId: 1, side: 'home', stake: 1000, clock });
  await placeBet(store, { userId: 2, gameId: 1, side: 'away', stake: 1000, clock });
  await settleGame(store, { gameId: 1, homeScore: 15, awayScore: 12, clock });

  const lb = await leaderboards(store);
  assert.equal(lb.bankroll[0].display_name, 'Russ', 'winner should top the bankroll board');
  assert.equal(lb.roi[0].display_name, 'Russ');
  assert.ok(lb.roi[0].roi > 0);
  assert.equal(lb.biggest[0].display_name, 'Russ');
});

test('a bettable game reports itself unlocked before kickoff', async () => {
  const [g] = await store.query('SELECT * FROM games WHERE id=1');
  assert.equal(isLocked(g, clock), false);
  assert.equal(isLocked(g, () => Date.parse(KICKOFF) + 1), true);
});

test('a game whose teams are not decided yet cannot be quoted', async () => {
  await store.query(
    `INSERT INTO games (id,home_team_id,away_team_id,home_label,away_label,starts_at,status)
     VALUES (2,0,0,'Winner Pool A','Winner Pool B',$1,'scheduled')`,
    ['2026-08-20T10:00:00Z']
  );
  await assert.rejects(() => quote(store, 2), (e) => e.code === 'not_ready');
});

test('a Postgres-shaped kickoff still locks at the right moment', async () => {
  // Postgres hands back '2026-08-16 14:00:00+00', not an ISO string. Comparing
  // that with a naive Date parse is exactly how a game would stay bettable
  // after it had started.
  await store.query("UPDATE games SET starts_at = '2026-08-16 14:00:00+00' WHERE id = 1");
  const [g] = await store.query('SELECT * FROM games WHERE id = 1');
  assert.equal(isLocked(g, () => Date.parse('2026-08-16T13:59:59Z')), false);
  assert.equal(isLocked(g, () => Date.parse('2026-08-16T14:00:00Z')), true);
});

test('a kickoff we cannot parse fails closed', async () => {
  await store.query("UPDATE games SET starts_at = 'whenever' WHERE id = 1");
  const [g] = await store.query('SELECT * FROM games WHERE id = 1');
  assert.equal(isLocked(g, () => Date.parse('2026-08-16T10:00:00Z')), true);
});

test('today counts settled bets only, not money tied up in open ones', async () => {
  // Reading this off the ledger showed a loss the moment a bet was placed, so
  // anyone holding an open position looked down all day on bets that hadn't
  // been decided.
  await placeBet(store, { userId: 1, gameId: 1, side: 'home', stake: 4000, clock });
  const held = await leaderboards(store, { day: '2026-08-16' });
  assert.deepEqual(held.daily, [], 'an open bet is not a result');

  await settleGame(store, { gameId: 1, homeScore: 15, awayScore: 11, clock });
  const done = await leaderboards(store, { day: '2026-08-16' });
  assert.equal(done.daily.length, 1);
  assert.equal(done.daily[0].display_name, 'Russ');
  assert.ok(done.daily[0].net > 0, 'a winning bet shows a profit');
  assert.equal(done.daily[0].settled, 1);
  assert.equal(done.daily[0].wins, 1);
});

test('today shows a real loss once a bet actually loses', async () => {
  await placeBet(store, { userId: 2, gameId: 1, side: 'away', stake: 2000, clock });
  await settleGame(store, { gameId: 1, homeScore: 15, awayScore: 9, clock });
  const lb = await leaderboards(store, { day: '2026-08-16' });
  const sam = lb.daily.find((r) => r.display_name === 'Sam');
  assert.equal(sam.net, -2000);
  assert.equal(sam.wins, 0);
});

test('a daily top-up never appears as winnings', async () => {
  await store.query('UPDATE users SET bankroll = 100 WHERE id = 1');
  await topUpStuck(store, { clock });
  const lb = await leaderboards(store, { day: '2026-08-16' });
  assert.deepEqual(lb.daily, [], 'being topped up is not a day’s trading');
});

test('a voided bet nets to zero on the day', async () => {
  await placeBet(store, { userId: 1, gameId: 1, side: 'home', stake: 1000, clock });
  await voidGame(store, { gameId: 1, reason: 'Abandoned', clock });
  const lb = await leaderboards(store, { day: '2026-08-16' });
  assert.deepEqual(lb.daily, [], 'a refund is not a result either');
});

test('an open bet does not read as a loss it has not taken', async () => {
  // The stake has left the account, so measuring profit straight off the
  // balance would show anyone with bets running as losing all afternoon.
  const before = (await leaderboards(store)).bankroll.find((r) => r.id === 1);
  assert.equal(before.net, 0);

  await placeBet(store, { userId: 1, gameId: 1, side: 'home', stake: 4000, clock });
  const after = (await leaderboards(store)).bankroll.find((r) => r.id === 1);
  assert.equal(after.net, 0, 'placing a bet decides nothing, so profit must not move');
  assert.equal(after.atRisk, 4000);
  assert.ok(after.bankroll < before.bankroll, 'the balance did move');
});

test('profit moves only when the bet settles', async () => {
  await placeBet(store, { userId: 1, gameId: 1, side: 'home', stake: 1000, clock });
  await settleGame(store, { gameId: 1, homeScore: 15, awayScore: 9, clock });
  const won = (await leaderboards(store)).bankroll.find((r) => r.id === 1);
  assert.ok(won.net > 0, `a winning bet should show a profit, got ${won.net}`);
  assert.equal(won.atRisk, 0);
});

test('biggest win ranks on profit, not on money returned', async () => {
  // A huge stake at a short price returns the most and wins almost nothing.
  // A small stake at a long price is the bet worth putting on a leaderboard.
  await store.query('UPDATE users SET bankroll = 100000 WHERE id = 1');
  await placeBet(store, { userId: 1, gameId: 1, side: 'home', stake: 50000, clock });
  await placeBet(store, { userId: 2, gameId: 1, side: 'home', stake: 100, clock });
  await settleGame(store, { gameId: 1, homeScore: 15, awayScore: 9, clock });

  const { biggest } = await leaderboards(store);
  const heavy = biggest.find((b) => b.stake === 50000);
  const light = biggest.find((b) => b.stake === 100);
  assert.ok(heavy && light);
  assert.ok(heavy.payout > light.payout, 'the big stake did get more back');
  assert.ok(biggest[0].profit >= biggest[biggest.length - 1].profit, 'sorted by profit');
  for (let i = 1; i < biggest.length; i += 1) {
    assert.ok(biggest[i - 1].profit >= biggest[i].profit, 'strictly ordered by profit');
  }
});

test('biggest win says what the bet actually was', async () => {
  await placeBet(store, { userId: 1, gameId: 1, side: 'away', stake: 300, clock });
  await settleGame(store, { gameId: 1, homeScore: 9, awayScore: 15, clock });
  const { biggest } = await leaderboards(store);
  const b = biggest[0];
  assert.ok(b.pick, 'the club backed, not just the money');
  assert.ok(b.against, 'and who they beat');
  assert.ok(Number(b.odds) > 1, 'at what price');
  assert.equal(b.score, '9-15', 'and how it finished');
});
