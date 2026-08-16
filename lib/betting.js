// Chalk Line — betting engine.
//
// House rules, as chosen:
//   * prices carry a small margin, so payouts stay conservative
//   * the line moves with the money; your bet locks the price you were shown
//   * bets lock at the scheduled start time; in-play betting reopens them,
//     and closes again the moment the score decides the game
//   * voids are an admin decision, and refund in full
//   * a player with nothing left and nothing riding is topped up at once

import { priceGame, applyResult, newTeam, spreadLadder, coversSpread, probToDecimal } from './model.js';
import { parseTs, toIso } from './time.js';
import { inPlayProbability, isSuspended, suspensionRemaining, effectiveTarget } from './inplay.js';

const STARTING_BANKROLL = 10000;
const TOPUP_THRESHOLD = 500;
const TOPUP_AMOUNT = 2000;
const MIN_STAKE = 10;

class BetError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const nowIso = (clock) => new Date(clock ? clock() : Date.now()).toISOString();

async function getGame(store, gameId) {
  const [game] = await store.query('SELECT * FROM games WHERE id = $1', [gameId]);
  if (!game) throw new BetError('no_game', 'That game does not exist.');
  return game;
}

async function getTeamPair(store, game) {
  const rows = await store.query('SELECT * FROM teams WHERE id = $1 OR id = $2', [
    game.home_team_id,
    game.away_team_id,
  ]);
  const home = rows.find((t) => t.id === game.home_team_id);
  const away = rows.find((t) => t.id === game.away_team_id);
  return { home, away };
}

// Current price for a game, given the model and the money already on it.
async function quote(store, gameId, { clock } = {}) {
  const game = await getGame(store, gameId);
  const { home, away } = await getTeamPair(store, game);
  if (!home || !away) throw new BetError('not_ready', 'This game does not have both teams yet.');
  const now = clock ? clock() : Date.now();
  const live = livePrice(game, home, away, now);
  const priced = priceGame(home, away, game.stake_home, game.stake_away);
  return {
    inPlay: live
      ? {
          homeScore: game.live_home_score,
          awayScore: game.live_away_score,
          eventNum: game.live_event_num,
          capped: live.capped,
          target: live.target,
          suspendedFor: suspensionRemaining(game.last_point_at, now),
          home: { prob: Math.round(live.prob * 1e4) / 1e4, decimal: probToDecimal(live.prob) },
          away: { prob: Math.round((1 - live.prob) * 1e4) / 1e4,
                  decimal: probToDecimal(1 - live.prob) },
        }
      : null,
    // Alternative margin lines. Unlike the moneyline these are model-priced
    // only and don't drift with money: a thin market on a handicap moves far
    // too violently to be fair to whoever bet first.
    spreads: spreadLadder(home, away),
    gameId: game.id,
    startsAt: toIso(game.starts_at),
    division: game.division,
    poolName: game.pool_name,
    home: { id: home.id, name: home.name, seed: home.seed, country: home.country, ...priced.home },
    away: { id: away.id, name: away.name, seed: away.seed, country: away.country, ...priced.away },
    margin: priced.margin,
    modelProb: priced.modelProb,
    stakeHome: game.stake_home,
    stakeAway: game.stake_away,
    locked: isLocked(game, clock),
  };
}

function isLocked(game, clock) {
  if (game.settled || game.voided) return true;
  const now = clock ? clock() : Date.now();

  // A game in progress is bettable in-play, except in the seconds after a
  // point: we learn about a score a few seconds late, and whoever is standing
  // at the field does not.
  if (game.status === 'live') {
    // A score that has reached the target has decided the game, whatever the
    // official feed still says. That confirmation can lag by many minutes, and
    // in the gap the winning side sits at the 1.02 floor — a guaranteed profit
    // anyone can take, repeatedly, on a game already over. Close it on the
    // score, not on the paperwork.
    if (reachedTarget(game, now)) return true;
    return isSuspended(game.last_point_at, now);
  }

  if (game.status !== 'scheduled') return true;
  const start = parseTs(game.starts_at);
  // An unparseable or missing kickoff must fail closed — betting on a game we
  // can't time is worse than not offering it.
  if (start === null) return true;
  return now >= start;
}

// Has either side reached the score that ends the game? Under the time cap
// the target moves to the leader's score plus one, so this stays false until
// that extra point is actually scored.
function reachedTarget(game, now) {
  const home = Number(game.live_home_score);
  const away = Number(game.live_away_score);
  if (!Number.isFinite(home) || !Number.isFinite(away)) return false;
  const { target } = effectiveTarget({
    homeScore: home,
    awayScore: away,
    target: game.winning_score || 15,
    elapsedMinutes: elapsedMinutes(game, now),
    timeCapMinutes: game.time_cap ?? null,
    capTarget: game.cap_target ?? null,
  });
  return Math.max(home, away) >= target;
}

// Has the game kicked off? Used for revealing everyone's positions, which is
// deliberately not the same question as whether betting is open — an in-play
// game is unlocked most of the time, and positions should not flicker in and
// out of view between points.
function hasStarted(game, now) {
  if (game.settled || game.voided) return true;
  if (game.status === 'live' || game.status === 'final') return true;
  const start = parseTs(game.starts_at);
  if (start === null) return false;
  return now >= start;
}

// Minutes of play elapsed, used only to decide whether the time cap applies.
function elapsedMinutes(game, now) {
  const started = parseTs(game.started_at) ?? parseTs(game.starts_at);
  if (started === null) return null;
  return (now - started) / 60000;
}

// The live price, from the current score. Falls back to the pre-game market
// for anything not in progress.
function livePrice(game, home, away, now) {
  const scored = Number.isFinite(game.live_home_score) && Number.isFinite(game.live_away_score);
  if (game.status !== 'live' || !scored) return null;
  return inPlayProbability(home, away, {
    homeScore: game.live_home_score,
    awayScore: game.live_away_score,
    target: game.winning_score || 15,
    elapsedMinutes: elapsedMinutes(game, now),
    timeCapMinutes: game.time_cap ?? null,
    capTarget: game.cap_target ?? null,
  });
}

// ---------------------------------------------------------------------------
// Placing a bet
// ---------------------------------------------------------------------------

async function placeBet(store, { userId, gameId, side, stake, market = 'moneyline', line, clock }) {
  if (side !== 'home' && side !== 'away') throw new BetError('bad_side', 'Pick a team.');
  if (market !== 'moneyline' && market !== 'spread') {
    throw new BetError('bad_market', 'Unknown market.');
  }
  const amount = Math.round(Number(stake) * 100) / 100;
  if (!Number.isFinite(amount) || amount < MIN_STAKE) {
    throw new BetError('bad_stake', `Minimum stake is ${MIN_STAKE}.`);
  }

  const game = await getGame(store, gameId);
  const nowMs = clock ? clock() : Date.now();
  if (game.status === 'live' && isSuspended(game.last_point_at, nowMs)) {
    const secs = suspensionRemaining(game.last_point_at, nowMs);
    throw new BetError('suspended', `Point just scored — betting reopens in ${secs}s.`);
  }
  if (isLocked(game, clock)) throw new BetError('locked', 'Betting on this game has closed.');

  const q = await quote(store, gameId, { clock });
  const inPlay = Boolean(q.inPlay);
  if (inPlay && market === 'spread') {
    throw new BetError('bad_market', 'Handicaps are closed once a game is under way.');
  }

  // Odds are always re-derived here from the model. A price sent by the
  // client is a suggestion from an adversary, and a line it invented would
  // let someone ask for +40 at even money.
  let odds;
  let acceptedLine = null;
  if (market === 'spread') {
    const wanted = Number(line);
    const rung = q.spreads.find((s) => Math.abs(s.line - wanted) < 1e-9);
    if (!rung) throw new BetError('bad_line', 'That handicap is not on offer.');
    odds = side === 'home' ? rung.home.decimal : rung.away.decimal;
    acceptedLine = rung.line;
  } else if (inPlay) {
    odds = side === 'home' ? q.inPlay.home.decimal : q.inPlay.away.decimal;
  } else {
    odds = side === 'home' ? q.home.decimal : q.away.decimal;
  }

  // The money must come out of the bankroll conditionally — this is the one
  // step that has to be safe against two bets racing on the same account.
  const debited = await store.query(
    'UPDATE users SET bankroll = bankroll - $1 WHERE id = $2 AND bankroll >= $1 RETURNING bankroll',
    [amount, userId]
  );
  if (!debited.length) throw new BetError('insufficient', 'Not enough in your bankroll.');

  const placedAt = nowIso(clock);
  const [bet] = await store.query(
    `INSERT INTO bets (user_id, game_id, side, market, line, in_play, stake, odds, status, placed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open', $9) RETURNING id`,
    [userId, gameId, side, market, acceptedLine, inPlay, amount, odds, placedAt]
  );

  // Only the pre-game moneyline moves with money. An in-play stake must not
  // shift a price that is already being driven by the score.
  if (market === 'moneyline' && !inPlay) {
    const column = side === 'home' ? 'stake_home' : 'stake_away';
    await store.query(`UPDATE games SET ${column} = ${column} + $1 WHERE id = $2`, [amount, gameId]);
  }

  await store.query(
    'INSERT INTO ledger (user_id, amount, reason, ref, created_at) VALUES ($1,$2,$3,$4,$5)',
    [userId, -amount, 'bet', String(bet?.id ?? gameId), placedAt]
  );

  return {
    betId: bet?.id,
    gameId,
    side,
    market,
    line: acceptedLine,
    inPlay,
    stake: amount,
    odds,
    toReturn: Math.round(amount * odds * 100) / 100,
    bankroll: debited[0].bankroll,
  };
}

// ---------------------------------------------------------------------------
// Settling
// ---------------------------------------------------------------------------

async function settleGame(store, { gameId, homeScore, awayScore, clock }) {
  const game = await getGame(store, gameId);
  // A voided game is a deliberate admin decision — settling it afterwards
  // would pay out on a match everyone has already been refunded for.
  if (game.voided) throw new BetError('settled', 'That game was voided and refunded.');
  if (game.settled) return { alreadySettled: true, gameId };
  if (homeScore === awayScore) {
    throw new BetError('draw', 'Ultimate games cannot end level — check the score.');
  }

  const winner = homeScore > awayScore ? 'home' : 'away';
  const settledAt = nowIso(clock);
  const bets = await store.query("SELECT * FROM bets WHERE game_id = $1 AND status = 'open'", [
    gameId,
  ]);

  for (const bet of bets) {
    const won = bet.market === 'spread'
      ? (bet.side === 'home'
          ? coversSpread(homeScore, awayScore, bet.line)
          : !coversSpread(homeScore, awayScore, bet.line))
      : bet.side === winner;
    const payout = won ? Math.round(bet.stake * bet.odds * 100) / 100 : 0;
    await store.query(
      'UPDATE bets SET status = $1, payout = $2, settled_at = $3 WHERE id = $4',
      [won ? 'won' : 'lost', payout, settledAt, bet.id]
    );
    if (payout > 0) {
      await store.query('UPDATE users SET bankroll = bankroll + $1 WHERE id = $2', [
        payout,
        bet.user_id,
      ]);
      await store.query(
        'INSERT INTO ledger (user_id, amount, reason, ref, created_at) VALUES ($1,$2,$3,$4,$5)',
        [bet.user_id, payout, 'win', String(bet.id), settledAt]
      );
    }
  }

  await store.query(
    `UPDATE games SET status = 'final', home_score = $1, away_score = $2, settled = TRUE
     WHERE id = $3`,
    [homeScore, awayScore, gameId]
  );

  await updateRatings(store, game, homeScore, awayScore);

  return { gameId, winner, settledBets: bets.length };
}

// Feed the result back into the model so tomorrow's prices are sharper.
async function updateRatings(store, game, homeScore, awayScore) {
  if (game.rated) return;
  const { home, away } = await getTeamPair(store, game);
  if (!home || !away) return;
  // Snapshot what the model believed BEFORE it learns this result. This is the
  // only moment the honest number is available: a second from now applyResult
  // will have moved both ratings towards the outcome, and any later attempt to
  // reconstruct the prediction would be grading the model on knowledge it did
  // not have. That is also why calibration can only ever run forward from the
  // day this shipped — the games already rated cannot be recovered.
  await store.query('UPDATE games SET pred_home_prob = $1 WHERE id = $2',
    [priceGame(home, away).modelProb, game.id]);
  const updated = applyResult(home, away, homeScore, awayScore);
  for (const t of [updated.home, updated.away]) {
    await store.query('UPDATE teams SET rating = $1, rd = $2, played = $3 WHERE id = $4', [
      t.rating,
      t.rd,
      t.played,
      t.id,
    ]);
  }
  await store.query('UPDATE games SET rated = TRUE WHERE id = $1', [game.id]);
}

// Admin call: rainout, forfeit, withdrawal, abandoned. Everyone gets their
// stake back and the game stops being bettable.
async function voidGame(store, { gameId, reason, clock }) {
  const game = await getGame(store, gameId);
  if (game.settled) throw new BetError('settled', 'That game has already been settled.');
  const at = nowIso(clock);
  const bets = await store.query("SELECT * FROM bets WHERE game_id = $1 AND status = 'open'", [
    gameId,
  ]);
  for (const bet of bets) {
    await store.query(
      "UPDATE bets SET status = 'void', payout = $1, settled_at = $2 WHERE id = $3",
      [bet.stake, at, bet.id]
    );
    await store.query('UPDATE users SET bankroll = bankroll + $1 WHERE id = $2', [
      bet.stake,
      bet.user_id,
    ]);
    await store.query(
      'INSERT INTO ledger (user_id, amount, reason, ref, created_at) VALUES ($1,$2,$3,$4,$5)',
      [bet.user_id, bet.stake, 'void_refund', String(bet.id), at]
    );
  }
  await store.query(
    "UPDATE games SET voided = TRUE, settled = TRUE, status = 'void', void_reason = $1 WHERE id = $2",
    [reason || 'Voided by admin', gameId]
  );
  return { gameId, refunded: bets.length };
}

// ---------------------------------------------------------------------------
// Bankroll upkeep
// ---------------------------------------------------------------------------

// A player is stuck when they cannot place a bet and have nothing riding:
// no cash to stake, no open position that might return some. That is the only
// moment a top-up is free of side effects — topping up someone who still has
// bets running hands them money on top of a live position.
//
// Deliberately immediate and unlimited rather than a daily allowance. Since
// the leaderboard ranks on profit net of everything granted, a top-up buys
// nothing but the ability to keep playing: bust eight times chasing a 12.0 and
// the board shows you eight top-ups deeper in the hole. Generosity is safe
// once it stops being a lottery ticket.
async function topUpStuck(store, { clock, userId = null } = {}) {
  const at = nowIso(clock);
  const params = [MIN_STAKE];
  let where = 'u.bankroll < $1';
  if (userId) { params.push(userId); where += ` AND u.id = $${params.length}`; }

  const stuck = await store.query(
    `SELECT u.id FROM users u
     WHERE ${where}
       AND NOT EXISTS (SELECT 1 FROM bets b WHERE b.user_id = u.id AND b.status = 'open')`,
    params
  );

  for (const u of stuck) {
    await store.query(
      `UPDATE users SET bankroll = bankroll + $1, granted = granted + $1, topups = topups + 1
       WHERE id = $2`,
      [TOPUP_AMOUNT, u.id]
    );
    await store.query(
      'INSERT INTO ledger (user_id, amount, reason, ref, created_at) VALUES ($1,$2,$3,$4,$5)',
      [u.id, TOPUP_AMOUNT, 'topup', at.slice(0, 10), at]
    );
  }
  return { toppedUp: stuck.length };
}

// ---------------------------------------------------------------------------
// Leaderboards
// ---------------------------------------------------------------------------

async function leaderboards(store, { day } = {}) {
  // Open bets are counted alongside the settled ones. Without that a player
  // holding nothing but open positions reads as "0/0 won", which looks like
  // someone who has never bet rather than someone with money still riding.
  // Ranked on profit, not on what's in the account. `granted` is every unit
  // the house has handed over — the opening balance plus each top-up — so a
  // player who busts and re-ups eight times chasing a long shot sits eight
  // top-ups below zero rather than back where they started. Without this the
  // dominant strategy is to shove the lot on the longest price every time:
  // the upside is unbounded and the downside is refunded.
  //
  // An open bet is carried at what it cost. The stake has already left the
  // account, so measuring straight off the balance would show every open
  // position as a loss it hasn't taken yet — the board would say you were
  // losing all afternoon simply for having bets running. Profit moves when a
  // bet settles, and not before.
  const bankroll = await store.query(
    `SELECT u.id, u.display_name, u.bankroll, u.topups, u.granted,
            u.bankroll - u.granted
              + SUM(CASE WHEN b.status = 'open' THEN b.stake ELSE 0 END) AS net,
            SUM(CASE WHEN b.status IN ('won','lost') THEN 1 ELSE 0 END) AS bets,
            SUM(CASE WHEN b.status = 'won' THEN 1 ELSE 0 END) AS wins,
            SUM(CASE WHEN b.status = 'open' THEN 1 ELSE 0 END) AS open_bets,
            SUM(CASE WHEN b.status = 'open' THEN b.stake ELSE 0 END) AS at_risk
     FROM users u LEFT JOIN bets b ON b.user_id = u.id
     GROUP BY u.id, u.display_name, u.bankroll, u.topups, u.granted
     ORDER BY (u.bankroll - u.granted
               + SUM(CASE WHEN b.status = 'open' THEN b.stake ELSE 0 END)) DESC
     LIMIT 100`
  );

  // ROI is measured on settled stakes only, so an open position can't flatter it.
  const roi = await store.query(
    `SELECT u.id, u.display_name,
            SUM(b.stake) AS staked,
            SUM(b.payout) AS returned
     FROM users u JOIN bets b ON b.user_id = u.id
     WHERE b.status IN ('won','lost')
     GROUP BY u.id, u.display_name
     HAVING SUM(b.stake) > 0
     ORDER BY (SUM(b.payout) - SUM(b.stake)) / SUM(b.stake) DESC LIMIT 100`
  );

  // Ranked on profit, not on what came back. Returns include the stake, so
  // ordering by payout just finds whoever staked the most: 9,570 at 1.02 pays
  // back 9,761 and tops the table for a profit of 191. Nobody is impressed by
  // that, and it rewards bankroll size rather than picking well.
  // Carries the actual bet, not just the money. "+2,690" says nothing about
  // whether it was a shrewd call; "Tchac at 3.69 to beat Mooncatchers" does.
  const biggest = await store.query(
    `SELECT u.display_name, b.payout, b.stake, b.odds, b.game_id,
            b.side, b.market, b.line, b.in_play,
            b.payout - b.stake AS profit,
            CASE WHEN b.side = 'home' THEN h.name ELSE a.name END AS pick,
            CASE WHEN b.side = 'home' THEN a.name ELSE h.name END AS against,
            g.home_score, g.away_score, g.division
     FROM bets b
     JOIN users u ON u.id = b.user_id
     JOIN games g ON g.id = b.game_id
     LEFT JOIN teams h ON h.id = g.home_team_id
     LEFT JOIN teams a ON a.id = g.away_team_id
     WHERE b.status = 'won'
     ORDER BY (b.payout - b.stake) DESC LIMIT 20`
  );

  // Today counts settled bets only. Reading it off the ledger counted the
  // stake the moment a bet was placed, so anyone holding an open position
  // showed a loss all day for bets that hadn't been decided yet — the board
  // said you were down when you were merely waiting.
  const today = day || nowIso().slice(0, 10);
  const daily = await store.query(
    `SELECT u.display_name,
            SUM(b.payout - b.stake) AS net,
            COUNT(*) AS settled,
            SUM(CASE WHEN b.status = 'won' THEN 1 ELSE 0 END) AS wins
     FROM bets b JOIN users u ON u.id = b.user_id
     WHERE b.status IN ('won','lost') AND b.settled_at >= $1
     GROUP BY u.display_name
     HAVING COUNT(*) > 0
     ORDER BY net DESC LIMIT 50`,
    [`${today}T00:00:00.000Z`]
  );

  const num = (v) => (v === null || v === undefined ? 0 : Number(v));
  return {
    bankroll: bankroll.map((r) => ({
      ...r, bankroll: num(r.bankroll), bets: num(r.bets), wins: num(r.wins),
      openBets: num(r.open_bets), atRisk: num(r.at_risk),
      granted: num(r.granted), net: num(r.net),
    })),
    roi: roi.map((r) => {
      const staked = num(r.staked);
      const returned = num(r.returned);
      return {
        ...r, staked, returned,
        roi: staked ? Math.round(((returned - staked) / staked) * 1000) / 10 : 0,
      };
    }),
    biggest: biggest.map((r) => ({
      ...r, payout: num(r.payout), stake: num(r.stake), odds: num(r.odds),
      profit: num(r.profit), line: r.line === null ? null : num(r.line),
      score: (r.home_score === null || r.home_score === undefined)
        ? null : `${num(r.home_score)}-${num(r.away_score)}`,
    })),
    daily: daily.map((r) => ({
      ...r, net: num(r.net), settled: num(r.settled), wins: num(r.wins),
    })),
  };
}

export {
  BetError,
  STARTING_BANKROLL,
  TOPUP_THRESHOLD,
  TOPUP_AMOUNT,
  MIN_STAKE,
  isLocked,
  reachedTarget,
  hasStarted,
  quote,
  placeBet,
  settleGame,
  voidGame,
  topUpStuck,
  leaderboards,
  updateRatings,
};
