// Chalk Line — point-by-point derivation.
//
// WFDF publishes a per-game file nobody seems to use: every goal, timed to the
// second, with scorer and assister. What it does NOT publish is who was on
// offence for each point — and that is the fact everything interesting hangs
// off, because a goal only means something once you know whether the team
// scoring it had the disc to start with.
//
// It can be reconstructed. Ultimate alternates possession by rule: the team
// that scores then pulls, so whoever conceded receives the next point. And at
// half the sides swap — whoever started the game on defence receives, no
// matter who scored last:
//
//   offence(0)          = from the opening event
//   offence(first of H2) = whoever did NOT receive the opening pull
//   offence(n)          = whoever did NOT score point n-1
//   break               = the scoring team was not the offence team
//
// The halftime rule is the one that is easy to miss, and skipping it costs
// exactly one point per game — the first of the second half. The chain
// re-syncs immediately afterwards, because every later point depends only on
// who scored the previous one and not on the state of the chain.
//
// Checked against WFDF's own published timeline, which labels every point an
// Offensive Hold or a Break Score: 19 of 19 on a game where the halftime rule
// changes the answer, 27 of 27 on one where it doesn't.
//
// The same property has a useful consequence. The opening pull decides the
// offence for exactly TWO points — the first of each half — and nothing else.
// So a game with no opening marker is not a lost game: it is a game missing
// two points.
//
// Two things the feed does not give us, stated plainly because they bound what
// any of this can mean:
//
//   * No turnover events. "Time on offence" is time spent as the receiving
//     team, not time in possession of the disc. A team that turfs it on the
//     first throw is still counted as the offence for that point.
//   * About one game in six has no opening-offence marker. That costs the two
//     points whose offence depends on it and nothing more; the rest of the game
//     is as solid as any other. Guessing the marker would be worse than the
//     gap — the opening point is a hold only about two times in three, so a
//     guess would be wrong on a third of them and say nothing about it.

const DEFAULT_TARGET = 15;
const MAX_SANE_POINT_S = 1800; // 30 minutes; anything longer is bad data, not a point

// Which side received the opening pull. Returns 'home', 'away', or null when
// the feed never recorded it — null is a real answer here, not a failure.
function startingOffence(detail) {
  const events = detail?.gameevents || [];
  const opener = events.find((e) => e && e.type === 'offence');
  if (!opener) return null;
  return Number(opener.ishome) === 1 ? 'home' : 'away';
}

// Where the second half starts, as an index into the ordered goals.
//
// The feed's `halftime` is a clock reading and is present in about seven games
// in ten. Where it is missing, half is taken at the point where a side first
// reaches half the target, which is what the rules say and what the field
// agrees with: across the games carrying both, the last point before the
// recorded halftime is the one taking a team to 8 in 43 cases out of 46.
function secondHalfIndex(goals, halftimeAt, target = DEFAULT_TARGET) {
  if (!goals.length) return -1;
  if (halftimeAt) {
    const idx = goals.findIndex((g) => Number(g.time) > halftimeAt);
    if (idx > 0) return idx;
    if (idx === 0) return -1; // every goal after the reading: not a real half
  }
  const half = Math.ceil(target / 2);
  const idx = goals.findIndex(
    (g) => Math.max(Number(g.homescore) || 0, Number(g.visitorscore) || 0) >= half
  );
  return idx >= 0 && idx + 1 < goals.length ? idx + 1 : -1;
}

// Goals in play order, defensively sorted. `num` is the authoritative sequence:
// two games in the sample have timestamps that step backwards, presumably a
// scorekeeper correcting an entry, and ordering by time would deal those points
// to the wrong side of the possession chain.
function orderedGoals(detail) {
  return (detail?.goals || [])
    .filter((g) => g && Number.isFinite(Number(g.num)))
    .slice()
    .sort((a, b) => Number(a.num) - Number(b.num));
}

// The possession chain: one row per point, each knowing who was on offence,
// who was on defence, who scored, and whether that made it a break.
function derivePoints(detail) {
  const result = detail?.game_result || {};
  const homeId = Number(result.hometeam);
  const awayId = Number(result.visitorteam);
  const goals = orderedGoals(detail);
  const start = startingOffence(detail);
  const halftimeAt = Number(result.halftime) || null;

  if (!goals.length || !homeId || !awayId) {
    return { points: [], startKnown: start !== null, secondHalfIndex: -1,
             homeId, awayId, halftimeAt };
  }

  // Without the opening marker we lose the offence for the first point of each
  // half and nothing else. Those two are flagged; the rest of the game is as
  // solid as any anchored game, because their offence follows from who scored
  // the point before.
  const known = start !== null;
  const h2 = secondHalfIndex(goals, halftimeAt);
  let offenceIsHome = start === 'home';
  let prevTime = 0;
  const points = [];

  for (let i = 0; i < goals.length; i += 1) {
    const g = goals[i];
    // Half time: the side that started on defence receives, whatever happened
    // on the last point of the first half.
    if (i === h2) offenceIsHome = start !== 'home';
    const dependsOnStart = i === 0 || i === h2;
    const anchored = known || !dependsOnStart;
    const timeS = Number(g.time) || 0;
    // Clamp rather than drop: a negative gap from a corrected timestamp should
    // not turn into negative time on offence for somebody.
    const rawDuration = timeS - prevTime;
    const duration = rawDuration > 0 ? rawDuration : 0;
    prevTime = Math.max(prevTime, timeS);

    // The point that straddles half time carries the entire break with it —
    // ten or fifteen minutes of standing about, attributed to whoever happened
    // to be receiving. It counts as a point but its clock is thrown away.
    const spansHalftime = Boolean(
      halftimeAt && timeS > halftimeAt && timeS - duration < halftimeAt
    );
    const usableClock = !spansHalftime && duration > 0 && duration <= MAX_SANE_POINT_S;

    const scorerIsHome = Number(g.ishomegoal) === 1;
    const scoreTeam = scorerIsHome ? homeId : awayId;
    const oTeam = offenceIsHome ? homeId : awayId;
    const dTeam = offenceIsHome ? awayId : homeId;

    points.push({
      num: Number(g.num),
      timeS,
      durationS: duration,
      usableClock,
      spansHalftime,
      anchored,
      startKnown: known,
      secondHalf: h2 >= 0 && i >= h2,
      oTeam: anchored ? oTeam : null,
      dTeam: anchored ? dTeam : null,
      scoreTeam,
      isBreak: anchored ? scoreTeam !== oTeam : null,
      scorerId: g.scorer ? Number(g.scorer) : null,
      scorerName: playerName(g.scorerfirstname, g.scorerlastname),
      assistId: g.assist ? Number(g.assist) : null,
      assistName: playerName(g.assistfirstname, g.assistlastname),
      isCallahan: Number(g.iscallahan) === 1,
    });

    // Score, then pull. Whoever just conceded receives the next one.
    offenceIsHome = !scorerIsHome;
  }

  return { points, startKnown: known, secondHalfIndex: h2, homeId, awayId, halftimeAt };
}

function playerName(first, last) {
  const name = `${first || ''} ${last || ''}`.trim();
  return name || null;
}

// Timeouts, with the team that called each one. Used to answer a question the
// raw feed can't: does calling one actually win you the next point?
function deriveTimeouts(detail) {
  const result = detail?.game_result || {};
  const homeId = Number(result.hometeam);
  const awayId = Number(result.visitorteam);
  return (detail?.gameevents || [])
    .filter((e) => e && e.type === 'timeout')
    .map((e) => ({
      timeS: Number(e.time) || 0,
      teamId: Number(e.ishome) === 1 ? homeId : awayId,
    }))
    .filter((t) => t.teamId);
}

// Did the team that called a timeout score the next point after it? A timeout
// is called mid-point, so "the next point" is the first goal at or after the
// timeout's clock time.
function timeoutOutcomes(points, timeouts) {
  return timeouts.map((t) => {
    const next = points.find((p) => p.timeS >= t.timeS);
    return {
      ...t,
      converted: next ? next.scoreTeam === t.teamId : null,
    };
  });
}

export {
  MAX_SANE_POINT_S,
  DEFAULT_TARGET,
  secondHalfIndex,
  startingOffence,
  orderedGoals,
  derivePoints,
  deriveTimeouts,
  timeoutOutcomes,
};
