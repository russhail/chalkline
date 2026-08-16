// Chalk Line — WFDF live results feed.
//
// The results site is a static-JSON app, not an API with auth. Discovered
// endpoints (all GET, no headers, no credentials):
//
//   live/data/_heartbeat.json              cache_version — changes when data does
//   live/data/WUCC2026_reference.json      series, pools, pool_placements, teams,
//                                          countries, reservations
//   live/data/WUCC2026_games.json          all 656 games — fixtures only, NO scores
//   live/data/WUCC2026_games_active.json   games at or near kickoff
//   live/data/WUCC2026_standings_<pool>.json  <- scores live here
//
// The games file never carries a score, whatever a game's status. Results are
// published per pool under standings.games[] as `homescore` / `visitorscore`,
// plus a `forfeit` flag. So settlement reads standings, not games.
//
// Cache-bust with ?cb=<ms>; the server sets a 90s cache lifetime.

const BASE = 'https://results.wfdf.sport/wucc-2026/live/data/';

const SERIES = { 1000: "Women's", 1001: 'Mixed', 1002: 'Open' };

// Field names the feed might use for scores once games leave "scheduled".
// The feed only materialises these when a game is live or final, so we accept
// any of the plausible spellings rather than guessing one and breaking.
const HOME_SCORE_KEYS = ['homescore', 'home_score', 'scorehome', 'score_home', 'hometeamscore'];
const AWAY_SCORE_KEYS = ['visitorscore', 'visitor_score', 'scorevisitor', 'score_visitor',
                          'awayscore', 'away_score', 'visitorteamscore'];

const FINAL_STATUSES = new Set(['final', 'finished', 'complete', 'completed', 'played']);
const LIVE_STATUSES = new Set(['live', 'inprogress', 'in_progress', 'active', 'started']);

function pick(obj, keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') {
      const n = Number(obj[k]);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

// The per-game detail file: every goal with scorer, assister and clock time,
// plus the opening-offence marker and any timeouts. Not referenced anywhere in
// the site's own JavaScript — found by watching what a player's stats page
// requests.
async function fetchGameDetail(gameId) {
  return getJson(`WUCC2026_games_${gameId}.json`);
}

async function getJson(file) {
  const res = await fetch(`${BASE}${file}?cb=${Date.now()}`);
  if (!res.ok) throw new Error(`WFDF ${file} returned ${res.status}`);
  return res.json();
}

// Cheap poll: the heartbeat's cache_version changes whenever the data does,
// so we only pull the big files when something actually moved.
async function fetchHeartbeat() {
  const h = await getJson('_heartbeat.json');
  return { cacheVersion: h.cache_version, lastUpdated: h.last_updated_utc };
}

async function fetchReference() {
  const r = await getJson('WUCC2026_reference.json');

  const countries = new Map((r.countries || []).map((c) => [c.country_id, c.name]));
  const pools = new Map((r.pools || []).map((p) => [p.pool_id, p]));

  // pool_placements gives each team's seed within its pool.
  const seedInPool = new Map();
  for (const p of r.pool_placements || []) {
    seedInPool.set(`${p.pool_id}:${p.team_id}`, p.placement);
  }

  const teams = (r.teams || []).map((t) => ({
    id: t.team_id,
    name: t.name,
    abbreviation: t.abbreviation,
    division: SERIES[t.series] || String(t.series),
    seriesId: t.series,
    country: countries.get(t.country) || null,
    // `rank` is the overall seed within the division (1 = top seed). This is
    // what feeds the rating model's priors.
    seed: t.rank,
    finalStanding: t.final_standing || null,
  }));

  const fieldSizes = {};
  for (const t of teams) fieldSizes[t.division] = (fieldSizes[t.division] || 0) + 1;

  return { teams, pools, countries, fieldSizes, seedInPool };
}

function normaliseGame(g, poolsById) {
  const pool = poolsById?.get?.(g.pool) || null;
  const homeScore = pick(g, HOME_SCORE_KEYS);
  const awayScore = pick(g, AWAY_SCORE_KEYS);
  const raw = String(g.status || '').toLowerCase().replace(/[\s-]/g, '');

  let state = 'scheduled';
  if (FINAL_STATUSES.has(raw)) state = 'final';
  else if (LIVE_STATUSES.has(raw)) state = 'live';
  // Belt and braces: a game carrying both scores is effectively final even if
  // the feed hasn't relabelled it yet.
  if (state === 'scheduled' && homeScore !== null && awayScore !== null) state = 'live';
  if (g.isongoing === 1 || g.isongoing === '1') state = 'live';

  return {
    id: g.game_id,
    homeTeamId: g.hometeam,
    awayTeamId: g.visitorteam,
    // time_utc is the authoritative kickoff; `time` is Irish local.
    startsAt: g.time_utc ? `${g.time_utc.replace(' ', 'T')}Z` : null,
    localTime: g.time || null,
    poolId: g.pool ?? null,
    poolName: pool?.poolname || null,
    forfeit: Boolean(Number(g.forfeit || 0)),
    divisionId: pool?.series_id ?? null,
    division: pool ? SERIES[pool.series_id] || null : null,
    fieldId: g.reservation ?? null,
    name: g.gamename || g.name || null,
    // Bracket games exist before their teams are known; these placeholder
    // labels ("Winner Pool A" etc.) are how we show them pre-seeding.
    homeLabel: g.scheduling_name_home || g.homeschedulingname || null,
    awayLabel: g.scheduling_name_visitor || g.visitorschedulingname || null,
    status: state,
    rawStatus: g.status || null,
    // Only the active feed carries these. `isongoing` is the tournament
    // telling us the clock is still running.
    ongoing: g.isongoing === 1 || g.isongoing === '1' || raw === 'ongoing',
    hasStarted: g.hasstarted === 1 || g.hasstarted === '1',
    // Point-by-point detail, present only on the active feed. `lastevent.num`
    // increments per point, so it identifies exactly which point a price was
    // quoted against.
    lastEventNum: g.lastevent && typeof g.lastevent.num === 'number' ? g.lastevent.num : null,
    lastEventAt: g.lastevent?.timestamp
      ? `${String(g.lastevent.timestamp).replace(' ', 'T')}Z` : null,
    timerStart: Number.isFinite(g.timer_start) ? g.timer_start : null,
    homeScore,
    awayScore,
    valid: g.valid === 1 || g.valid === '1',
  };
}

async function fetchGames(poolsById) {
  const g = await getJson('WUCC2026_games.json');
  const list = Array.isArray(g) ? g : g.games || [];
  return list.map((x) => normaliseGame(x, poolsById)).filter((x) => x.valid);
}

async function fetchActiveGames(poolsById) {
  const a = await getJson('WUCC2026_games_active.json');
  const list = Array.isArray(a) ? a : a.games || [];
  return list.map((x) => normaliseGame(x, poolsById));
}

// --- scores -----------------------------------------------------------------

// A pool's standings file. Also carries the pool's own rules — score cap, time
// cap, whether draws are allowed, what a forfeit is recorded as.
async function fetchPoolStandings(poolId) {
  const data = await getJson(`WUCC2026_standings_${poolId}.json`);
  const s = data.standings || data;
  return {
    poolId: s.pool_id,
    poolName: s.name,
    scoreCap: s.scorecap ?? null,
    timeCap: s.timecap ?? null,
    drawsAllowed: Boolean(s.drawsallowed),
    forfeitScore: s.forfeitscore ?? 0,
    games: (s.games || []).map((g) => ({
      id: g.game_id,
      homeTeamId: g.hometeam,
      awayTeamId: g.visitorteam,
      homeScore: g.homescore === null || g.homescore === '' ? null : Number(g.homescore),
      awayScore: g.visitorscore === null || g.visitorscore === '' ? null : Number(g.visitorscore),
      forfeit: Boolean(Number(g.forfeit || 0)),
    })),
  };
}

// Scores for the pools we care about, keyed by game id. Fetching all 55 pools
// every sync would be wasteful, so callers pass only the pools with games that
// have kicked off and aren't settled yet.
async function fetchScores(poolIds) {
  const scores = new Map();
  const failures = [];
  for (const poolId of poolIds) {
    try {
      const pool = await fetchPoolStandings(poolId);
      for (const g of pool.games) {
        if (g.homeScore === null || g.awayScore === null) continue;
        scores.set(g.id, {
          homeScore: g.homeScore,
          awayScore: g.awayScore,
          forfeit: g.forfeit,
          drawsAllowed: pool.drawsAllowed,
          timeCap: pool.timeCap,
          winningScore: pool.scoreCap,
        });
      }
    } catch (err) {
      failures.push({ poolId, error: err.message });
    }
  }
  return { scores, failures };
}

// One pass: everything the app needs to refresh itself. `poolsNeedingScores`
// comes from our own database — the pools with kicked-off, unsettled games.
async function fetchAll({ poolsNeedingScores = [] } = {}) {
  const heartbeat = await fetchHeartbeat();
  const reference = await fetchReference();
  const games = await fetchGames(reference.pools);
  const active = await fetchActiveGames(reference.pools);

  const byId = new Map(games.map((g) => [g.id, g]));
  for (const a of active) {
    const existing = byId.get(a.id);
    if (existing) Object.assign(existing, a);
    else byId.set(a.id, a);
  }

  // CRITICAL: the standings file publishes the score of a game IN PROGRESS,
  // not just its final result. Treating any score as final settles matches
  // mid-play at whatever the count happens to be. The active feed is the
  // authority on whether a game is still running — a game listed there with
  // isongoing is not finished, however plausible its score looks.
  const ongoing = new Set(
    active
      .filter((g) => g.ongoing || g.rawStatus === 'ongoing')
      .map((g) => g.id)
  );

  const { scores, failures } = await fetchScores(poolsNeedingScores);
  for (const [gameId, result] of scores) {
    const g = byId.get(gameId);
    if (!g) continue;
    g.homeScore = result.homeScore;
    g.awayScore = result.awayScore;
    g.forfeit = result.forfeit;
    g.timeCap = result.timeCap ?? null;
    g.winningScore = result.winningScore ?? null;
    // Scores are shown either way; only the status decides settlement.
    g.status = ongoing.has(gameId) ? 'live' : 'final';
  }

  return {
    heartbeat,
    teams: reference.teams,
    fieldSizes: reference.fieldSizes,
    games: [...byId.values()],
    scoreFailures: failures,
  };
}

// A bracket game with no real teams yet must never be bettable.
function isBettable(game) {
  return (
    game.status === 'scheduled' &&
    Number.isFinite(game.homeTeamId) &&
    Number.isFinite(game.awayTeamId) &&
    game.homeTeamId > 0 &&
    game.awayTeamId > 0 &&
    !!game.startsAt
  );
}

export {
  BASE,
  SERIES,
  getJson,
  fetchGameDetail,
  fetchHeartbeat,
  fetchReference,
  fetchGames,
  fetchActiveGames,
  fetchPoolStandings,
  fetchScores,
  fetchAll,
  normaliseGame,
  isBettable,
};
