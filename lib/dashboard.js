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
  //
  // The clock is split by outcome, because a single average over defensive
  // points is the mean of two opposite virtues and therefore means nothing.
  // When the defence breaks, a SHORT point is the good one — the turn came
  // early and got converted. When the defence is held, a LONG point is the
  // good one — they forced the offence to work for it. Averaging those two
  // together lets a ruthless defence and a leaky one land on the same number
  // by opposite routes, which is exactly the reading the old column invited.
  const def = await store.query(
    `SELECT p.d_team_id AS team_id,
            COUNT(*) AS d_points,
            SUM(CASE WHEN p.score_team_id = p.d_team_id THEN 1 ELSE 0 END) AS breaks,
            SUM(CASE WHEN p.usable_clock = TRUE THEN p.duration_s ELSE 0 END) AS d_time,
            SUM(CASE WHEN p.usable_clock = TRUE THEN 1 ELSE 0 END) AS d_clock_n,
            SUM(CASE WHEN p.usable_clock = TRUE AND p.score_team_id = p.d_team_id
                     THEN p.duration_s ELSE 0 END) AS break_time,
            SUM(CASE WHEN p.usable_clock = TRUE AND p.score_team_id = p.d_team_id
                     THEN 1 ELSE 0 END) AS break_clock_n,
            SUM(CASE WHEN p.usable_clock = TRUE AND p.score_team_id <> p.d_team_id
                     THEN p.duration_s ELSE 0 END) AS conceded_time,
            SUM(CASE WHEN p.usable_clock = TRUE AND p.score_team_id <> p.d_team_id
                     THEN 1 ELSE 0 END) AS conceded_clock_n
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

  // Timeouts, split by what the next point actually was. Winning it off a
  // timeout on defence is a break; winning it on offence is a hold, which is
  // what should have happened anyway. was_break is null both for unconverted
  // timeouts and for converted ones on unanchored points, so the two splits
  // deliberately do not have to sum to `converted` — the shortfall is the
  // number we cannot attribute, and the page says so rather than hiding it.
  const tos = await store.query(
    `SELECT t.team_id, COUNT(*) AS n,
            SUM(CASE WHEN t.converted = TRUE THEN 1 ELSE 0 END) AS converted,
            SUM(CASE WHEN t.converted = TRUE AND t.was_break = TRUE
                     THEN 1 ELSE 0 END) AS converted_break,
            SUM(CASE WHEN t.converted = TRUE AND t.was_break = FALSE
                     THEN 1 ELSE 0 END) AS converted_hold
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
        breakTime: 0, breakClockN: 0, concededTime: 0, concededClockN: 0,
        callahans: 0, timeouts: 0, timeoutsConverted: 0,
        timeoutsBreak: 0, timeoutsHold: 0,
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
    t.breakTime = num(r.break_time); t.breakClockN = num(r.break_clock_n);
    t.concededTime = num(r.conceded_time); t.concededClockN = num(r.conceded_clock_n);
  }
  for (const r of callahans) put(r.team_id).callahans = num(r.n);
  for (const r of tos) {
    if (!byId.has(Number(r.team_id))) continue; // a timeout in a game we never derived
    const t = put(r.team_id);
    t.timeouts = num(r.n); t.timeoutsConverted = num(r.converted);
    t.timeoutsBreak = num(r.converted_break); t.timeoutsHold = num(r.converted_hold);
  }

  const meta = new Map(teams.map((t) => [Number(t.id), t]));
  const byTeamPlayers = groupPlayersByTeam(players);

  const rows = [...byId.values()].map((t) => {
    const info = meta.get(t.teamId) || {};
    const totalPoints = t.oPoints + t.dPoints;
    const conceded = t.oPoints - t.holds;      // broken on their own offence
    const squad = byTeamPlayers.get(t.teamId) || [];
    const reliance = relianceFor(squad);
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

      // The two halves of a defensive point, which want opposite things.
      // Short is good here: the turn came early and the break followed.
      secondsPerBreak: t.breakClockN ? Math.round(t.breakTime / t.breakClockN) : null,
      // Long is good here: they were beaten, but they made it expensive. A
      // defence conceding in forty seconds is being walked through.
      secondsPerConcededHold: t.concededClockN
        ? Math.round(t.concededTime / t.concededClockN) : null,
      breakClockN: t.breakClockN, concededClockN: t.concededClockN,
      breakTime: t.breakTime, concededTime: t.concededTime,

      // How long a hold takes. Short means clean; long means turnovers and
      // grinding the disc back. With no turnover events in the feed this is
      // the closest honest proxy for offensive efficiency we can build.
      secondsPerHold: t.holdClockN ? Math.round(t.holdTime / t.holdClockN) : null,
      // The raw pair travels too, so the profile page can show a hold total
      // against the opponent's conceded total and have the two reconcile.
      holdTime: t.holdTime, holdClockN: t.holdClockN,

      games: (gamesByTeam.get(t.teamId) || new Set()).size,
      gamesUntraced: (untracedByTeam.get(t.teamId) || new Set()).size,

      callahans: t.callahans,
      timeouts: t.timeouts,
      timeoutsConverted: t.timeoutsConverted,
      timeoutConversion: pct(t.timeoutsConverted, t.timeouts),
      // Of the points won off a timeout, the ones that were breaks rather than
      // holds. Rated against every timeout called, not against the conversions
      // — "how often does calling one win us a break" is the question, and
      // dividing by conversions would flatter a side that rarely converts.
      timeoutsBreak: t.timeoutsBreak,
      timeoutsHold: t.timeoutsHold,
      timeoutBreakRate: pct(t.timeoutsBreak, t.timeouts),
      timeoutHoldRate: pct(t.timeoutsHold, t.timeouts),
      // Converted, but on a point whose possession chain was never anchored.
      timeoutsUnattributed: Math.max(
        0, t.timeoutsConverted - t.timeoutsBreak - t.timeoutsHold
      ),

      // Star dependence, computed three ways rather than one. A side whose
      // ASSISTS pile up on one handler is a different fragility from a side
      // whose GOALS pile up on one cutter: mark the handler out of the game
      // and the offence has no engine, mark the cutter and it still has an
      // engine but nowhere to put the disc. Pooled into a single goals-plus-
      // assists figure the two are indistinguishable, which is why the combined
      // number alone was never enough to scout against.
      reliance,

      // Flat aliases for the combined view. Kept so every existing caller —
      // and anything cached from the old payload — keeps reading the same
      // field names it always did.
      concentration: reliance.total.rate,
      topThree: reliance.total.part,
      topThreeNames: reliance.total.names.map((p) => ({ name: p.name, total: p.n })),
      contributions: reliance.total.whole,
      contributors: reliance.total.contributors,
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

// Top n by a given tally. The name tiebreak is not cosmetic: without it two
// players on the same count can swap places between two requests, and a page
// that reshuffles while nothing has happened reads as live data when it isn't.
function topNBy(players, key, n) {
  return players.slice()
    .sort((a, b) => (b[key] || 0) - (a[key] || 0)
      || String(a.name || '').localeCompare(String(b.name || '')))
    .slice(0, n);
}

// Share of a team's output produced by its top few. `key` selects what is
// being counted: 'goals', 'assists', or 'total' for the two together.
//
// Null below a handful of events, where the ratio swings wildly on a single
// point. The threshold counts the thing being measured, which means the goals
// and assists views qualify later than the combined one — a club needs twelve
// goals before its goal concentration is reported, not twelve contributions.
// That is deliberate: half the sample earns half the confidence.
function concentrationFor(players, { key = 'total', topN = 3, minTotal = 12 } = {}) {
  const total = players.reduce((s, p) => s + (p[key] || 0), 0);
  if (total < minTotal) return null;
  const top = topNBy(players, key, topN).reduce((s, p) => s + (p[key] || 0), 0);
  return pct(top, total);
}

const RELIANCE_KEYS = ['goals', 'assists', 'total'];

// The three concentrations, each carrying the counts and the names behind it.
//
// One caveat the page has to carry with the assists figure: every point has a
// scorer by definition, but the feed leaves the assist blank on callahans and
// anywhere the scorekeeper skipped it. So the assist denominator is a subset
// of the goal denominator rather than its equal, and a club's assist
// concentration is computed over slightly less evidence than its goal one.
function relianceFor(players, { topN = 3, minTotal = 12 } = {}) {
  const out = {};
  for (const key of RELIANCE_KEYS) {
    const top = topNBy(players, key, topN).filter((p) => (p[key] || 0) > 0);
    out[key] = {
      rate: concentrationFor(players, { key, topN, minTotal }),
      part: top.reduce((s, p) => s + (p[key] || 0), 0),
      whole: players.reduce((s, p) => s + (p[key] || 0), 0),
      // People who actually did this particular thing. A squad where twenty
      // have scored but only eight have thrown an assist has eight assisters,
      // and reporting twenty would make the tail look far deeper than it is.
      contributors: players.filter((p) => (p[key] || 0) > 0).length,
      names: top.map((p) => ({ name: p.name, n: p[key] || 0 })),
    };
  }
  return out;
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

// Thrower to scorer: the pairs that actually produce goals.
//
// The feed names both ends of every goal, so these connections have been in
// the data the whole time. Nobody publishes them because the raw file is one
// game at a time, and a partnership only becomes visible once a tournament is
// pooled — "Groom to Rippe, nine goals" is not a fact about any single game.
//
// Both players are on the scoring team by definition — a goal is scored by the
// scoring team and assisted by it too — so the pair groups under score_team_id
// with no roster lookup needed.
//
// Grouped on the ids alone, with the names picked up by MAX(). Grouping on the
// names as well would split one partnership into two rows the moment a
// scorekeeper typed a surname differently between games.
async function comboLeaders(store, {
  division = null, teamId = null, limit = 15, minGoals = 2,
} = {}) {
  const clauses = ['p.assist_id IS NOT NULL', 'p.scorer_id IS NOT NULL'];
  const args = [];
  if (division) { args.push(division); clauses.push(`p.division = $${args.length}`); }
  if (teamId) { args.push(Number(teamId)); clauses.push(`p.score_team_id = $${args.length}`); }
  args.push(minGoals);

  const rows = await store.query(
    `SELECT p.assist_id, MAX(p.assist_name) AS assist_name,
            p.scorer_id, MAX(p.scorer_name) AS scorer_name,
            p.score_team_id AS team_id, COUNT(*) AS n
     FROM points p
     WHERE ${clauses.join(' AND ')}
     GROUP BY p.assist_id, p.scorer_id, p.score_team_id
     HAVING COUNT(*) >= $${args.length}`,
    args
  );

  const teams = await store.query('SELECT id, name FROM teams');
  const names = new Map(teams.map((t) => [Number(t.id), t.name]));

  return rows
    .map((r) => ({
      assistId: Number(r.assist_id),
      assistName: r.assist_name,
      scorerId: Number(r.scorer_id),
      scorerName: r.scorer_name,
      teamId: Number(r.team_id),
      team: names.get(Number(r.team_id)) || null,
      goals: num(r.n),
    }))
    // Deterministic all the way down, so the list doesn't reshuffle between
    // two identical requests.
    .sort((a, b) => b.goals - a.goals
      || String(a.assistName || '').localeCompare(String(b.assistName || ''))
      || String(a.scorerName || '').localeCompare(String(b.scorerName || '')))
    .slice(0, limit);
}

// Reading a nested field by path, so the profile spec below can name
// 'reliance.goals.rate' as flatly as it names 'holdPct'.
const dig = (obj, path) =>
  path.split('.').reduce((o, k) => (o === null || o === undefined ? o : o[k]), obj);

function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  const m = v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  return Math.round(m * 10) / 10;
}

// Linear-interpolated percentile, used to give the page a scale for the
// division rather than letting it invent one.
//
// p10/p90 rather than min/max: one freak club at either end would otherwise
// squash every other side into the middle of the bar, which is the opposite
// of showing shape.
function percentile(values, p) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  if (v.length === 1) return v[0];
  const i = ((p / 100) * (v.length - 1));
  const lo = Math.floor(i), hi = Math.ceil(i);
  const val = lo === hi ? v[lo] : v[lo] + (v[hi] - v[lo]) * (i - lo);
  return Math.round(val * 10) / 10;
}

// What a club profile compares, and which way is up for each.
//
// `lowerIsBetter` describes the direction of virtue, not the direction of the
// number, and it really does differ stat by stat: a quick offensive point is
// a good one, a quick point conceded on defence is a bad one. Getting this
// wrong would colour half the page backwards.
//
// `sample`/`min` is the gate, read from the same denominator the dashboard
// gates on — and gated per stat, never per club, for the reason set out at the
// top of this file. A team can have a meaningful break rate and a meaningless
// hold rate at the same time.
const PROFILE_STATS = [
  { key: 'holdPct', label: 'Holds', unit: '%', sample: 'oPoints', min: 10 },
  { key: 'breakPct', label: 'Breaks', unit: '%', sample: 'dPoints', min: 10 },
  { key: 'brokenPct', label: 'Broken', unit: '%', sample: 'oPoints', min: 10,
    lowerIsBetter: true },
  { key: 'oSecsPerPoint', label: 'O point length', unit: 's', sample: 'oClockN', min: 10,
    lowerIsBetter: true },
  { key: 'secondsPerHold', label: 'Time to hold', unit: 's', sample: 'holdClockN', min: 10,
    lowerIsBetter: true },
  // Both marked neutral, and that is a finding rather than a hedge. Across the
  // full tournament neither correlates with whether a club actually breaks
  // (r = -0.07 and +0.05); what they do correlate with is how long that club's
  // points run in general (r = +0.65 and +0.76). They describe a defence, they
  // do not grade one — so no green end, and no rank, which would imply one.
  { key: 'secondsPerBreak', label: 'Time to break', unit: 's', sample: 'breakClockN', min: 5,
    neutral: true },
  { key: 'secondsPerConcededHold', label: 'Time to concede', unit: 's',
    sample: 'concededClockN', min: 5, neutral: true },
  { key: 'timeoutConversion', label: 'After a timeout', unit: '%', sample: 'timeouts', min: 5 },
  { key: 'timeoutBreakRate', label: 'Timeout breaks', unit: '%', sample: 'timeouts', min: 5 },
  { key: 'oTimeShare', label: 'Share of clock on O', unit: '%', sample: 'oClockN', min: 10,
    neutral: true },
  { key: 'reliance.goals.rate', label: 'Goal reliance', unit: '%',
    sample: 'reliance.goals.whole', min: 12, neutral: true },
  { key: 'reliance.assists.rate', label: 'Assist reliance', unit: '%',
    sample: 'reliance.assists.whole', min: 12, neutral: true },
  { key: 'reliance.total.rate', label: 'Star reliance', unit: '%',
    sample: 'reliance.total.whole', min: 12, neutral: true },
];

// One stat, placed against the division: the club's value, the median of every
// club with enough of a sample to count, and the rank among that same set.
//
// Ranking only within the qualified pool matters. Rank a club against peers
// who never met the sample gate and you get "4th of 24" where twenty of the
// twenty-four had no number at all — a flattering, meaningless placing.
function contextFor(me, peers, spec) {
  const qualifies = (t) =>
    num(dig(t, spec.sample)) >= (spec.min || 0) && Number.isFinite(dig(t, spec.key));
  const pool = peers.filter(qualifies);
  const values = pool.map((t) => Number(dig(t, spec.key)));
  const has = Boolean(me) && qualifies(me);
  const value = has ? Number(dig(me, spec.key)) : null;

  let rank = null;
  if (has && !spec.neutral) {
    rank = values.filter((v) => (spec.lowerIsBetter ? v < value : v > value)).length + 1;
  }

  return {
    key: spec.key,
    label: spec.label,
    unit: spec.unit,
    value,
    median: median(values),
    // The shape of the division around that median, so a bar can be drawn to
    // a real scale instead of an assumed one.
    p10: percentile(values, 10),
    p90: percentile(values, 90),
    rank,
    of: pool.length,
    // The club is below the sample gate for THIS stat — not short of data
    // generally, which is a different and usually wrong statement.
    thin: !has,
    lowerIsBetter: Boolean(spec.lowerIsBetter),
    neutral: Boolean(spec.neutral),
  };
}

// A club's defensive points measured against ITSELF rather than against the
// tournament.
//
// The reason for the self-centring: across all 55 clubs, time to break and
// time to concede are both dominated by how long that club's points run in
// general (r = +0.65 and +0.76 against its own average defensive point). Put
// two clubs side by side on raw seconds and mostly you have ranked them by
// tempo. Subtracting each club's own average cancels that out and leaves the
// asymmetry, which is the only part of the pair that is about the defence.
//
// What it still cannot tell you is whether the defence is any good — neither
// half predicts break rate (r = -0.07 and +0.05). This is a description of
// shape. The page has to say so, and does.
const D_SHAPE_MIN = 5;

function dShapeFor(me, peers) {
  if (!me) return null;
  const usable = (t) => t.breakClockN >= D_SHAPE_MIN && t.concededClockN >= D_SHAPE_MIN
    && Number.isFinite(t.secondsPerBreak) && Number.isFinite(t.secondsPerConcededHold);

  // The club's own average defensive point is the centre line. It is exactly
  // dSecsPerPoint, because the break and conceded buckets partition the
  // clocked defensive points between them.
  const own = me.dSecsPerPoint;
  const ok = usable(me) && Number.isFinite(own);
  const gaps = peers.filter(usable).map((t) => t.secondsPerConcededHold - t.secondsPerBreak);

  return {
    own: ok ? own : null,
    toBreak: ok ? me.secondsPerBreak : null,
    toConcede: ok ? me.secondsPerConcededHold : null,
    breakN: me.breakClockN,
    concedeN: me.concededClockN,
    // Signed: positive means they take longer to be scored on than to score.
    gap: ok ? me.secondsPerConcededHold - me.secondsPerBreak : null,
    // What a typical club in this division does, so "+79s" has a scale.
    divisionMedianGap: median(gaps),
    divisionClubsCompared: gaps.length,
    thin: !ok,
    minSample: D_SHAPE_MIN,
  };
}

// Everything about one club in a single view, each number placed against its
// division instead of left bare.
//
// "58% holds" tells a reader nothing unless they already know what good looks
// like in that division, and the divisions differ enough that one shared
// benchmark would be wrong. So every stat travels with its division median and
// the club's rank inside the division, and the page can draw shape — where
// this side is unusual — rather than a wall of percentages.
//
// Median rather than mean: at this sample size a single 15-0 drags a mean
// badly, and the question being asked is "next to a typical club in here".
async function teamProfile(store, teamId, { limit = 10 } = {}) {
  const id = Number(teamId);
  const [info] = await store.query(
    'SELECT id, name, abbreviation, division, country, seed FROM teams WHERE id = $1',
    [id]
  );
  if (!info) return null;
  const division = info.division;

  const [peers, players, combos] = await Promise.all([
    teamStats(store, { division }),
    playerTallies(store, { division }),
    comboLeaders(store, { teamId: id, limit, minGoals: 2 }),
  ]);

  const me = peers.find((t) => t.teamId === id) || null;
  const squad = players
    .filter((p) => p.teamId === id)
    .sort((a, b) => b.total - a.total
      || String(a.name || '').localeCompare(String(b.name || '')));

  return {
    team: {
      teamId: id,
      name: info.name,
      abbreviation: info.abbreviation || null,
      division,
      country: info.country || null,
      seed: info.seed ?? null,
    },
    // Null when the club has played but nothing of theirs could be traced —
    // distinct from a club with no games at all, and the page says which.
    stats: me,
    dShape: dShapeFor(me, peers),
    context: PROFILE_STATS.map((spec) => contextFor(me, peers, spec)),
    squad,
    combos,
    divisionClubs: peers.length,
  };
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
  relianceFor,
  comboLeaders,
  teamProfile,
  dShapeFor,
  median,
  percentile,
  PROFILE_STATS,
  coverage,
};
