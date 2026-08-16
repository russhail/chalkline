// Chalk Line — pull the WFDF feed into our database.
//
// Runs on a schedule. Cheap path first: if the heartbeat's cache_version is
// unchanged, nothing has moved and we stop. Otherwise refresh teams, games and
// scores, settle anything that finished, and let the ratings learn from it.

import { fetchAll, fetchHeartbeat, fetchActiveGames, isBettable, fetchGameDetail } from './wfdf.js';
import { newTeam, seedToRating } from './model.js';
import { effectiveSeed } from './priors.js';
import { settleGame } from './betting.js';
import { derivePoints, deriveTimeouts, timeoutOutcomes } from './gamestats.js';

async function getMeta(store, key) {
  const [row] = await store.query('SELECT value FROM meta WHERE key = $1', [key]);
  return row?.value ?? null;
}

async function setMeta(store, key, value) {
  await store.query(
    `INSERT INTO meta (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2`,
    [key, value]
  );
}

// Teams are inserted once with a rating derived from their WFDF seed. On later
// runs we only refresh the descriptive fields — never rating/rd/played, which
// belong to the model and would be wiped by a naive upsert.
// The rating a team should start from, once expert priors are taken into
// account. Kept in one place so creation and re-priming can't disagree.
function primeRating(t, fieldSizes) {
  const fieldSize = fieldSizes[t.division] || 48;
  const rawSeed = t.seed || Math.ceil(fieldSize / 2);
  const { seed, prior } = effectiveSeed(t.name, t.division, rawSeed);
  const base = seedToRating(seed, fieldSize);
  return { rating: base + (prior?.ratingBonus || 0), prior, effective: seed };
}

async function syncTeams(store, teams, fieldSizes) {
  let created = 0;
  let reprimed = 0;
  for (const t of teams) {
    const [existing] = await store.query(
      'SELECT id, played, rating FROM teams WHERE id = $1', [t.id]);
    const primed = primeRating(t, fieldSizes);

    if (existing) {
      await store.query(
        'UPDATE teams SET name=$1, abbreviation=$2, division=$3, country=$4, seed=$5 WHERE id=$6',
        [t.name, t.abbreviation, t.division, t.country, t.seed, t.id]
      );
      // A team that hasn't played yet has nothing but its prior, so a changed
      // prior should take effect. Once it has played, the model's own evidence
      // owns the rating and priors are never reapplied.
      if (Number(existing.played) === 0 && Math.abs(Number(existing.rating) - primed.rating) > 0.5) {
        await store.query('UPDATE teams SET rating = $1 WHERE id = $2', [primed.rating, t.id]);
        reprimed += 1;
      }
      continue;
    }

    const seeded = newTeam({
      id: t.id, name: t.name, division: t.division,
      seed: t.seed || Math.ceil((fieldSizes[t.division] || 48) / 2),
      fieldSize: fieldSizes[t.division] || 48,
    });
    await store.query(
      `INSERT INTO teams (id,name,abbreviation,division,country,seed,rating,rd,played)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0)`,
      [t.id, t.name, t.abbreviation, t.division, t.country, t.seed, primed.rating, seeded.rd]
    );
    created += 1;
  }
  return { teams: teams.length, created, reprimed };
}

// Games are upserted. Bracket fixtures start life with team ids of 0 and
// placeholder labels, then gain real teams as pools resolve — so the update
// path has to be able to fill those in.
async function syncGames(store, games, now = Date.now()) {
  let created = 0;
  let teamsResolved = 0;
  let livePoints = 0;
  const finished = [];

  for (const g of games) {
    const [existing] = await store.query('SELECT * FROM games WHERE id = $1', [g.id]);

    if (!existing) {
      await store.query(
        `INSERT INTO games (id,home_team_id,away_team_id,home_label,away_label,division,
                            pool_id,pool_name,starts_at,status,home_score,away_score,forfeit)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [g.id, g.homeTeamId, g.awayTeamId, g.homeLabel, g.awayLabel, g.division,
         g.poolId, g.poolName, g.startsAt, g.status, g.homeScore, g.awayScore,
         Boolean(g.forfeit)]
      );
      created += 1;
      // A game can be in progress the first time we ever see it — a bracket
      // fixture whose teams resolved mid-round, or a cold database. Recording
      // the live state only on the update path left those showing 0-0.
      if (g.ongoing) { await recordLiveState(store, g, null, now); livePoints += 1; }
      continue;
    }

    // Never touch a game we've already settled or voided.
    if (existing.settled || existing.voided) continue;

    // Live state. `last_point_at` only moves when the score actually changes,
    // so a poll that finds nothing new doesn't keep re-suspending the market.
    if (g.ongoing && await recordLiveState(store, g, existing, now)) livePoints += 1;

    if (!existing.home_team_id && g.homeTeamId) teamsResolved += 1;

    await store.query(
      `UPDATE games SET home_team_id=$1, away_team_id=$2, home_label=$3, away_label=$4,
              division=$5, pool_id=$6, pool_name=$7, starts_at=$8, status=$9,
              home_score=$10, away_score=$11, forfeit=$12
       WHERE id=$13`,
      [g.homeTeamId, g.awayTeamId, g.homeLabel, g.awayLabel, g.division, g.poolId,
       g.poolName, g.startsAt, g.status, g.homeScore, g.awayScore, Boolean(g.forfeit), g.id]
    );

    // Belt and braces: settlement requires an explicitly final status. A
    // score alone is not enough — the feed publishes running scores too.
    if (g.status === 'final' && g.ongoing !== true &&
        Number.isFinite(g.homeScore) && Number.isFinite(g.awayScore)) {
      finished.push(g);
    }
  }

  return { games: games.length, created, teamsResolved, livePoints, finished };
}

// Write the live score, and restart the suspension clock only when the score
// actually moved — a routine poll finding the same score must not keep the
// market shut. Returns true if a point was recorded.
async function recordLiveState(store, g, existing, now = Date.now()) {
  await store.query(
    `UPDATE games SET live_home_score=$1, live_away_score=$2, live_event_num=$3,
            started_at=COALESCE(started_at,$4), time_cap=COALESCE(time_cap,$5)
     WHERE id=$6`,
    [g.homeScore, g.awayScore, g.lastEventNum,
     g.timerStart ? new Date(g.timerStart * 1000).toISOString() : g.startsAt,
     g.timeCap ?? null, g.id]
  );
  // Freeze the capped target the first time we see a game past its time cap.
  // From that instant the game is to the leader's score plus one, and that
  // number must never move again — recomputing it as the score climbs makes
  // the game unwinnable on paper and the live price never reaches certainty.
  // COALESCE in the WHERE clause means the first writer wins and every later
  // poll leaves it alone.
  await recordCapTarget(store, g, now);

  const changed = !existing ||
    existing.live_home_score !== g.homeScore || existing.live_away_score !== g.awayScore;
  if (!changed) return false;
  await store.query('UPDATE games SET last_point_at = $1 WHERE id = $2',
    [g.lastEventAt || new Date().toISOString(), g.id]);
  return true;
}

async function recordCapTarget(store, g, now = Date.now()) {
  if (!g.timeCap || !g.timerStart) return;
  const elapsedMin = (now - g.timerStart * 1000) / 60000;
  if (elapsedMin < g.timeCap) return;
  const target = Math.max(Number(g.homeScore) || 0, Number(g.awayScore) || 0) + 1;
  if (!Number.isFinite(target)) return;
  await store.query(
    'UPDATE games SET cap_target = $1 WHERE id = $2 AND cap_target IS NULL',
    [target, g.id]
  );
}

// Settle everything the feed now reports as final.
//
// Two things are deliberately NOT auto-settled, because Russell chose to rule
// on them case by case: forfeits (recorded as 0-0 or 15-0 depending on the
// pool's config, which is a judgement call about whether a bet should stand)
// and level scores, which ultimate's rules make impossible and therefore mean
// the data is wrong rather than the game was drawn.
async function settleFinished(store, finished) {
  const settled = [];
  const needsAttention = [];
  for (const g of finished) {
    let reason = null;
    if (g.forfeit) reason = 'forfeit — void or settle by hand';
    else if (g.homeScore === g.awayScore) reason = 'level score reported';

    if (reason) {
      needsAttention.push({ gameId: g.id, reason });
      await store.query('UPDATE games SET needs_review = $1 WHERE id = $2', [reason, g.id]);
      continue;
    }

    try {
      const res = await settleGame(store, {
        gameId: g.id,
        homeScore: g.homeScore,
        awayScore: g.awayScore,
      });
      if (!res.alreadySettled) settled.push(res);
    } catch (err) {
      needsAttention.push({ gameId: g.id, reason: err.message });
      await store.query('UPDATE games SET needs_review = $1 WHERE id = $2', [err.message, g.id]);
    }
  }
  return { settled, needsAttention };
}

// Which pools might have a result we haven't recorded? Only those with a game
// that has kicked off and isn't settled. Checking all 55 every five minutes
// would be 55 requests for nothing.
async function poolsNeedingScores(store, { now = Date.now() } = {}) {
  const rows = await store.query(
    `SELECT DISTINCT pool_id FROM games
     WHERE pool_id IS NOT NULL AND settled = FALSE AND voided = FALSE
       AND starts_at IS NOT NULL AND starts_at <= $1`,
    [new Date(now).toISOString()]
  );
  return rows.map((r) => r.pool_id).filter(Boolean);
}

async function sync(store, { force = false, fetcher = fetchAll, now = Date.now() } = {}) {
  const startedAt = new Date().toISOString();
  const pools = await poolsNeedingScores(store, { now });

  // The heartbeat short-circuit is an optimisation, and it is only safe when
  // there is nothing outstanding. If a game has kicked off and we haven't
  // settled it, we check the standings regardless of what the heartbeat says —
  // trusting it there would mean silently never settling if WFDF's global
  // cache version doesn't tick when a pool score is entered. That failure
  // would be invisible: the site would look healthy and simply never pay out.
  if (!force && pools.length === 0) {
    const heartbeat = await fetchHeartbeat();
    const seen = await getMeta(store, 'cache_version');
    if (seen && seen === heartbeat.cacheVersion) {
      return { skipped: true, reason: 'unchanged', cacheVersion: seen, startedAt };
    }
  }

  const data = await fetcher({ poolsNeedingScores: pools });
  const teamResult = await syncTeams(store, data.teams, data.fieldSizes);
  const gameResult = await syncGames(store, data.games, now);
  const settleResult = await settleFinished(store, gameResult.finished);

  await setMeta(store, 'cache_version', data.heartbeat.cacheVersion);
  await setMeta(store, 'last_sync', startedAt);

  return {
    skipped: false,
    startedAt,
    cacheVersion: data.heartbeat.cacheVersion,
    teams: teamResult,
    games: { ...gameResult, finished: gameResult.finished.length },
    livePoints: gameResult.livePoints,
    settled: settleResult.settled.length,
    needsAttention: settleResult.needsAttention,
    poolsChecked: pools.length,
    scoreFailures: data.scoreFailures || [],
  };
}

// A lightweight refresh for the live board: one small file, no reference data,
// no pool standings. The full sync pulls hundreds of kilobytes and takes
// seconds — awaiting that on the live path made /api/live time out, and a live
// price that arrives ten seconds late is worse than none.
async function syncLive(store, { fetcher = fetchActiveGames, now = Date.now() } = {}) {
  const active = await fetcher();
  let points = 0;
  let seen = 0;
  for (const g of active) {
    if (!g.ongoing) continue;
    const [existing] = await store.query(
      'SELECT id, live_home_score, live_away_score, settled, voided FROM games WHERE id = $1',
      [g.id]
    );
    if (!existing || existing.settled || existing.voided) continue;
    seen += 1;
    // A game the bulk sync still thinks is scheduled is, demonstrably, not.
    await store.query("UPDATE games SET status = 'live' WHERE id = $1 AND status = 'scheduled'",
      [g.id]);
    if (await recordLiveState(store, g, existing, now)) points += 1;
  }
  return { live: seen, points };
}

// Games in progress, with everything needed to price them live.
async function liveGames(store) {
  return store.query(
    `SELECT g.id, g.home_team_id, g.away_team_id, g.division, g.pool_name, g.starts_at,
            g.live_home_score, g.live_away_score, g.last_point_at, g.live_event_num,
            g.started_at, g.time_cap, g.cap_target,
            h.name AS home_name, h.country AS home_country, h.seed AS home_seed,
            a.name AS away_name, a.country AS away_country, a.seed AS away_seed
     FROM games g
     LEFT JOIN teams h ON h.id = g.home_team_id
     LEFT JOIN teams a ON a.id = g.away_team_id
     WHERE g.status = 'live' AND g.settled = FALSE AND g.voided = FALSE
       AND g.home_team_id > 0 AND g.away_team_id > 0
     ORDER BY g.starts_at ASC LIMIT 60`
  );
}

// Everything a punter can bet on right now, cheapest query first.
// A day's worth of fixtures at a time. Every known game is available — which
// in practice means all of pool play, because bracket fixtures have no teams
// until pools resolve — but only the day you're looking at is fetched, so the
// payload stays small however far ahead the schedule runs.
async function openGames(store, { now = Date.now(), limit = 200, day = null } = {}) {
  const from = new Date(now).toISOString();
  const to = day
    ? new Date(`${day}T23:59:59.999Z`).toISOString()
    : new Date(now + 36 * 3600_000).toISOString();

  // The lower bound is added by building the statement, not by passing NULL.
  // Postgres cannot infer a parameter's type from `$4 IS NULL`, so a nullable
  // placeholder here fails with 42P08 — while SQLite accepts it silently,
  // which is precisely why the tests were green and production was not.
  const params = [from, to, limit];
  let dayClause = '';
  if (day) {
    params.push(new Date(`${day}T00:00:00.000Z`).toISOString());
    dayClause = `AND g.starts_at >= $${params.length}`;
  }

  return store.query(
    `SELECT g.id, g.home_team_id, g.away_team_id, g.division, g.pool_name, g.starts_at,
            g.stake_home, g.stake_away,
            h.name AS home_name, h.country AS home_country, h.seed AS home_seed,
            a.name AS away_name, a.country AS away_country, a.seed AS away_seed
     FROM games g
     LEFT JOIN teams h ON h.id = g.home_team_id
     LEFT JOIN teams a ON a.id = g.away_team_id
     WHERE g.status = 'scheduled' AND g.settled = FALSE AND g.voided = FALSE
       AND g.starts_at > $1 AND g.starts_at < $2
       AND g.home_team_id > 0 AND g.away_team_id > 0
       ${dayClause}
     ORDER BY g.starts_at ASC LIMIT $3`,
    params
  );
}

// One row per day with a count. Tiny, and it lets the board draw every day
// header — collapsed — without pulling the fixtures behind them.
async function gameDays(store, { now = Date.now() } = {}) {
  const dayExpr = store.dialect === 'postgres'
    ? `to_char(starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')`
    : `SUBSTR(starts_at, 1, 10)`;
  const rows = await store.query(
    `SELECT ${dayExpr} AS day, COUNT(*) AS games
     FROM games
     WHERE status = 'scheduled' AND settled = FALSE AND voided = FALSE
       AND home_team_id > 0 AND away_team_id > 0 AND starts_at > $1
     GROUP BY ${dayExpr}
     ORDER BY day ASC`,
    [new Date(now).toISOString()]
  );
  return rows.map((r) => ({ day: r.day, games: Number(r.games) }));
}

export { sync, syncLive, syncTeams, syncGames, settleFinished, openGames, liveGames, gameDays,
         poolsNeedingScores, getMeta, setMeta };

// ---------------------------------------------------------------------------
// Point-by-point ingest
// ---------------------------------------------------------------------------

// How many finished games to pull detail for per run. Each is a separate HTTP
// fetch, and the sync already shares a 60-second function budget with feed
// pulls and settlement — so this trickles rather than floods. At a dozen a run
// and a run every three minutes, a full day of results is absorbed in minutes,
// and the backlog only ever shrinks.
const DETAIL_BATCH = 25;

// Pull and derive the point-by-point record for games that have finished and
// haven't been ingested. Deliberately last in the sync and deliberately
// non-fatal: this feeds a dashboard, and a dashboard must never be the reason
// bets don't settle.
// Wipe the derived record so the next pass rebuilds it. Needed whenever the
// derivation itself changes: the ingest skips games it has already seen, and
// the point rows are written with ON CONFLICT DO NOTHING, so without this a
// corrected chain would never reach a game already in the table.
async function clearDerivedPoints(store) {
  await store.query('DELETE FROM points');
  await store.query('DELETE FROM timeouts');
  await store.query('UPDATE games SET detail_synced = FALSE, start_offence = NULL');
  return { cleared: true };
}

async function syncGameDetail(store, { fetcher = fetchGameDetail, limit = DETAIL_BATCH } = {}) {
  // Any game with a result, whether or not a bet was ever placed on it.
  // Gating this on `settled` tied the dashboard to the betting engine, which
  // meant games nobody bet on, games held for review, and everything that
  // finished before an account existed were all invisible — most of the
  // tournament, on a page whose whole job is to cover the tournament.
  const pending = await store.query(
    `SELECT id, division FROM games
     WHERE detail_synced = FALSE
       AND home_score IS NOT NULL AND away_score IS NOT NULL
       AND home_team_id > 0 AND away_team_id > 0
     ORDER BY starts_at ASC, id ASC LIMIT ${Number(limit) || DETAIL_BATCH}`
  );

  let ingested = 0;
  let pointsWritten = 0;
  let unanchored = 0;
  const failures = [];

  for (const g of pending) {
    try {
      const detail = await fetcher(g.id);
      const { points, startKnown } = derivePoints(detail);
      const timeouts = timeoutOutcomes(points, deriveTimeouts(detail));

      for (const p of points) {
        await store.query(
          `INSERT INTO points (game_id, num, time_s, duration_s, usable_clock, anchored,
                               o_team_id, d_team_id, score_team_id, is_break,
                               scorer_id, scorer_name, assist_id, assist_name,
                               is_callahan, division)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
           ON CONFLICT (game_id, num) DO NOTHING`,
          [g.id, p.num, p.timeS, p.durationS, p.usableClock, p.anchored,
           p.oTeam, p.dTeam, p.scoreTeam, p.isBreak,
           p.scorerId, p.scorerName, p.assistId, p.assistName,
           p.isCallahan, g.division]
        );
        pointsWritten += 1;
      }

      for (const t of timeouts) {
        await store.query(
          `INSERT INTO timeouts (game_id, time_s, team_id, converted)
           VALUES ($1,$2,$3,$4) ON CONFLICT (game_id, time_s, team_id) DO NOTHING`,
          [g.id, t.timeS, t.teamId, t.converted]
        );
      }

      await store.query(
        'UPDATE games SET detail_synced = TRUE, start_offence = $1 WHERE id = $2',
        [startKnown ? (points[0]?.oTeam === Number(detail?.game_result?.hometeam) ? 'home' : 'away') : null, g.id]
      );
      if (!startKnown) unanchored += 1;
      ingested += 1;
    } catch (err) {
      // Leave detail_synced false so the next run retries. A game whose file is
      // briefly missing should not be written off permanently.
      failures.push({ id: g.id, error: err.message });
    }
  }

  return { pending: pending.length, ingested, pointsWritten, unanchored, failures };
}

export { syncGameDetail, clearDerivedPoints, DETAIL_BATCH };
