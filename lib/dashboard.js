// Chalk Line — the stats dashboard.
//
// Everything here reads the `points` table, which already has the possession
// chain resolved (see gamestats.js). That keeps this file to aggregation, and
// keeps the aggregation to a handful of GROUP BYs rather than replaying every
// game on every request.
//
// A recurring decision throughout: counts flatter whoever played more. A team
// that gets broken repeatedly earns more defensive points and therefore more
// chances to break back, so raw break totals partly measure how badly you are
// losing. Rates are reported alongside every count for that reason, and the
// table sorts on the rate.
//
// Note what is deliberately NOT here: any judgement about whether a team has
// played enough for its numbers to mean something. That looks like a property
// of the team and is not. Fury won 15-0: fourteen breaks from fourteen
// defensive points, an excellent sample for a break rate — and exactly one
// offensive point, a worthless sample for a hold rate. One flag per team
// cannot say both. Worse, a whole-team threshold punishes dominance, because
// the more completely you win the fewer points get played. So the sample-size
// question belongs to whichever stat is being displayed, and lives with the
// views in the page.


async function teamStats(store, { division = null } = {}) {
  const where = division ? 'AND p.division = $1' : '';
  const args = division ? [division] : [];

  // Offensive side: points received, held, and the clock spent on them.
  const off = await store.query(
    `SELECT p.o_team_id AS team_id,
            COUNT(*) AS o_points,
            SUM(CASE WHEN p.score_team_id = p.o_team_id THEN 1 ELSE 0 END) AS holds,
            SUM(CASE WHEN p.usable_clock = TRUE THEN p.duration_s ELSE 0 END) AS o_time,
            SUM(CASE WHEN p.usable_clock = TRUE AND p.score_team_id = p.o_team_id
                     THEN p.duration_s ELSE 0 END) AS hold_time,
            SUM(CASE WHEN p.usable_clock = TRUE AND p.score_team_id = p.o_team_id
                     THEN 1 ELSE 0 END) AS hold_clock_n,
            SUM(CASE WHEN p.usable_clock = TRUE THEN 1 ELSE 0 END) AS o_clock_n
     FROM points p
     WHERE p.anchored = TRUE AND p.o_team_id IS NOT NULL ${where}
     GROUP BY p.o_team_id`,
    args
  );

  // Defensive side: points pulled, broken, and the clock spent on them.
  const def = await store.query(
    `SELECT p.d_team_id AS team_id,
            COUNT(*) AS d_points,
            SUM(CASE WHEN p.score_team_id = p.d_team_id THEN 1 ELSE 0 END) AS breaks,
            SUM(CASE WHEN p.usable_clock = TRUE THEN p.duration_s ELSE 0 END) AS d_time,
            SUM(CASE WHEN p.usable_clock = TRUE THEN 1 ELSE 0 END) AS d_clock_n
     FROM points p
     WHERE p.anchored = TRUE AND p.d_team_id IS NOT NULL ${where}
     GROUP BY p.d_team_id`,
    args
  );

  const callahans = await store.query(
    `SELECT p.score_team_id AS team_id, COUNT(*) AS n
     FROM points p WHERE p.is_callahan = TRUE ${where}
     GROUP BY p.score_team_id`,
    args
  );

  const tos = await store.query(
    `SELECT t.team_id, COUNT(*) AS n,
            SUM(CASE WHEN t.converted = TRUE THEN 1 ELSE 0 END) AS converted
     FROM timeouts t GROUP BY t.team_id`
  );

  // Games played, so a short rail can be read correctly. Without it, "14
  // defensive points" is ambiguous between a team that has played once and a
  // team whose offence is so good it is rarely on defence — opposite readings
  // from an identical picture.
  const pairs = await store.query(
    `SELECT p.o_team_id AS a, p.d_team_id AS b, p.game_id
     FROM points p WHERE p.anchored = TRUE AND p.o_team_id IS NOT NULL ${where}
     GROUP BY p.o_team_id, p.d_team_id, p.game_id`,
    args
  );
  const gamesByTeam = new Map();
  for (const r of pairs) {
    for (const id of [Number(r.a), Number(r.b)]) {
      if (!id) continue;
      if (!gamesByTeam.has(id)) gamesByTeam.set(id, new Set());
      gamesByTeam.get(id).add(Number(r.game_id));
    }
  }

  // Games we hold points for but could not trace, because the feed never
  // recorded who received the opening pull. Their goals count; their breaks,
  // holds and O/D time cannot. Reporting the number matters: Fury have played
  // twice and only one game is traceable, and a row reading "1 game" without
  // saying so is not a gap in the data, it is a wrong statement about it.
  const untraced = await store.query(
    `SELECT p.score_team_id AS team_id, p.game_id
     FROM points p WHERE p.anchored = FALSE ${where}
     GROUP BY p.score_team_id, p.game_id`,
    args
  );
  const untracedByTeam = new Map();
  for (const r of untraced) {
    const id = Number(r.team_id);
    if (!untracedByTeam.has(id)) untracedByTeam.set(id, new Set());
    untracedByTeam.get(id).add(Number(r.game_id));
  }

  const players = await playerTallies(store, { division });
  const teams = await store.query(
    'SELECT id, name, abbreviation, division, country, seed FROM teams'
  );

  const byId = new Map();
  const put = (id) => {
    const key = Number(id);
    if (!byId.has(key)) {
      byId.set(key, {
        teamId: key, oPoints: 0, dPoints: 0, holds: 0, breaks: 0,
        oTime: 0, dTime: 0, holdTime: 0, holdClockN: 0, oClockN: 0, dClockN: 0,
        callahans: 0, timeouts: 0, timeoutsConverted: 0,
      });
    }
    return byId.get(key);
  };

  for (const r of off) {
    const t = put(r.team_id);
    t.oPoints = num(r.o_points); t.holds = num(r.holds);
    t.oTime = num(r.o_time); t.holdTime = num(r.hold_time);
    t.holdClockN = num(r.hold_clock_n); t.oClockN = num(r.o_clock_n);
  }
  for (const r of def) {
    const t = put(r.team_id);
    t.dPoints = num(r.d_points); t.breaks = num(r.breaks); t.dTime = num(r.d_time);
    t.dClockN = num(r.d_clock_n);
  }
  for (const r of callahans) put(r.team_id).callahans = num(r.n);
  for (const r of tos) {
    if (!byId.has(Number(r.team_id))) continue; // a timeout in a game we never derived
    const t = put(r.team_id);
    t.timeouts = num(r.n); t.timeoutsConverted = num(r.converted);
  }

  const meta = new Map(teams.map((t) => [Number(t.id), t]));
  const byTeamPlayers = groupPlayersByTeam(players);

  const rows = [...byId.values()].map((t) => {
    const info = meta.get(t.teamId) || {};
    const totalPoints = t.oPoints + t.dPoints;
    const conceded = t.oPoints - t.holds;      // broken on their own offence
    return {
      teamId: t.teamId,
      name: info.name || `Team ${t.teamId}`,
      abbreviation: info.abbreviation || null,
      division: info.division || null,
      country: info.country || null,
      seed: info.seed ?? null,

      pointsPlayed: totalPoints,
      oPoints: t.oPoints,
      dPoints: t.dPoints,

      // The pair that actually describes a team.
      holds: t.holds,
      holdPct: pct(t.holds, t.oPoints),
      breaks: t.breaks,
      breakPct: pct(t.breaks, t.dPoints),
      brokenPct: pct(conceded, t.oPoints),

      // Clock. Reported in seconds; the UI does the formatting.
      oTime: t.oTime,
      dTime: t.dTime,
      oTimeShare: pct(t.oTime, t.oTime + t.dTime),
      // Per point, which is the comparable figure. A total mostly measures how
      // many games a club has played.
      oSecsPerPoint: t.oClockN ? Math.round(t.oTime / t.oClockN) : null,
      dSecsPerPoint: t.dClockN ? Math.round(t.dTime / t.dClockN) : null,
      oClockN: t.oClockN, dClockN: t.dClockN,

      // How long a hold takes. Short means clean; long means turnovers and
      // grinding the disc back. With no turnover events in the feed this is
      // the closest honest proxy for offensive efficiency we can build.
      secondsPerHold: t.holdClockN ? Math.round(t.holdTime / t.holdClockN) : null,

      games: (gamesByTeam.get(t.teamId) || new Set()).size,
      gamesUntraced: (untracedByTeam.get(t.teamId) || new Set()).size,

      callahans: t.callahans,
      timeouts: t.timeouts,
      timeoutsConverted: t.timeoutsConverted,
      timeoutConversion: pct(t.timeoutsConverted, t.timeouts),

      // Star dependence: the share of a team's goals and assists produced by
      // its three biggest contributors. The raw counts travel too, so the page
      // can draw the part against the whole rather than just the ratio.
      concentration: concentrationFor(byTeamPlayers.get(t.teamId) || []),
      topThree: topNTotal(byTeamPlayers.get(t.teamId) || [], 3),
      topThreeNames: (byTeamPlayers.get(t.teamId) || []).slice(0, 3)
        .map((p) => ({ name: p.name, total: p.total })),
      contributions: (byTeamPlayers.get(t.teamId) || []).reduce((n, p) => n + p.total, 0),
      contributors: (byTeamPlayers.get(t.teamId) || []).length,

    };
  });

  rows.sort((a, b) => b.pointsPlayed - a.pointsPlayed);
  return rows;
}

// Goals and assists per player. A scorer belongs to the team credited with the
// point, and so does the assister — the feed has no separate team field for
// either, and a goal is by definition scored by the scoring team.
async function playerTallies(store, { division = null } = {}) {
  const where = division ? 'AND p.division = $1' : '';
  const args = division ? [division] : [];

  const goals = await store.query(
    `SELECT p.scorer_id AS pid, p.scorer_name AS name, p.score_team_id AS team_id,
            COUNT(*) AS n
     FROM points p WHERE p.scorer_id IS NOT NULL ${where}
     GROUP BY p.scorer_id, p.scorer_name, p.score_team_id`,
    args
  );
  const assists = await store.query(
    `SELECT p.assist_id AS pid, p.assist_name AS name, p.score_team_id AS team_id,
            COUNT(*) AS n
     FROM points p WHERE p.assist_id IS NOT NULL ${where}
     GROUP BY p.assist_id, p.assist_name, p.score_team_id`,
    args
  );

  const byPlayer = new Map();
  const put = (pid, name, teamId) => {
    const key = Number(pid);
    if (!byPlayer.has(key)) {
      byPlayer.set(key, { playerId: key, name, teamId: Number(teamId), goals: 0, assists: 0 });
    }
    return byPlayer.get(key);
  };
  for (const r of goals) put(r.pid, r.name, r.team_id).goals = num(r.n);
  for (const r of assists) put(r.pid, r.name, r.team_id).assists = num(r.n);

  return [...byPlayer.values()].map((p) => ({ ...p, total: p.goals + p.assists }));
}

function groupPlayersByTeam(players) {
  const out = new Map();
  for (const p of players) {
    if (!out.has(p.teamId)) out.set(p.teamId, []);
    out.get(p.teamId).push(p);
  }
  for (const list of out.values()) list.sort((a, b) => b.total - a.total);
  return out;
}

function topNTotal(players, n) {
  return players.slice(0, n).reduce((s, p) => s + p.total, 0);
}

// Share of a team's scoring produced by its top three. Null below a handful of
// contributions, where the number swings wildly on a single point.
function concentrationFor(players, topN = 3, minTotal = 12) {
  const total = players.reduce((s, p) => s + p.total, 0);
  if (total < minTotal) return null;
  const top = players.slice(0, topN).reduce((s, p) => s + p.total, 0);
  return pct(top, total);
}

async function playerLeaders(store, { division = null, limit = 15 } = {}) {
  const players = await playerTallies(store, { division });
  const teams = await store.query('SELECT id, name FROM teams');
  const names = new Map(teams.map((t) => [Number(t.id), t.name]));
  const withTeam = players.map((p) => ({ ...p, team: names.get(p.teamId) || null }));
  const take = (key) => withTeam.slice().sort((a, b) => b[key] - a[key] || a.name.localeCompare(b.name))
    .slice(0, limit);
  return { goals: take('goals'), assists: take('assists'), combined: take('total') };
}

// How much of the tournament this dashboard can actually see. Shown on the
// page: a stat with unstated coverage is a stat you can't argue with.
async function coverage(store) {
  // Counted the same way the ingest selects: every game with a result.
  const [games] = await store.query(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN detail_synced = TRUE THEN 1 ELSE 0 END) AS ingested
     FROM games
     WHERE home_score IS NOT NULL AND away_score IS NOT NULL
       AND home_team_id > 0 AND away_team_id > 0`
  );
  const [pts] = await store.query(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN anchored = TRUE THEN 1 ELSE 0 END) AS anchored,
            SUM(CASE WHEN usable_clock = TRUE THEN 1 ELSE 0 END) AS timed
     FROM points`
  );
  const total = num(games?.total);
  const ingested = num(games?.ingested);
  return {
    playedGames: total,
    ingestedGames: ingested,
    pendingGames: Math.max(0, total - ingested),
    points: num(pts?.total),
    anchoredPoints: num(pts?.anchored),
    timedPoints: num(pts?.timed),
    anchoredPct: pct(num(pts?.anchored), num(pts?.total)),
  };
}

const num = (v) => (v === null || v === undefined ? 0 : Number(v));
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

export {
  teamStats,
  playerTallies,
  playerLeaders,
  concentrationFor,
  coverage,
};
