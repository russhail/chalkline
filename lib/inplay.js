// Chalk Line — in-play pricing.
//
// Ultimate is a race to a fixed score, which makes live win probability exactly
// computable rather than estimated. If a team wins each point independently
// with probability p, then from any score the chance of getting to the target
// first is a small dynamic program — at most 16x16 states, solved in
// microseconds, no simulation and no fitting.
//
// The one calibration that matters: p is chosen so that the DP evaluated at
// 0-0 reproduces the pre-game price the model already publishes. A game that
// hasn't started must be worth the same live as it was a minute earlier, or
// the two markets disagree with each other in public.

import { winProbability } from './model.js';
import { parseTs } from './time.js';

const DEFAULT_TARGET = 15;

// P(home reaches `target` before away), from the current score.
//
// Iterative rather than recursive: the recursion is only ~256 states deep but
// it is called for every game on every poll, and this avoids rebuilding a call
// stack twenty times a second.
function raceWinProbability(homeScore, awayScore, target, p) {
  if (homeScore >= target) return 1;
  if (awayScore >= target) return 0;
  if (p <= 0) return 0;
  if (p >= 1) return 1;

  const need = target - homeScore;      // points home still needs
  const oppNeed = target - awayScore;   // points away still needs

  // f[j] = P(home wins | home needs i, away needs j), filled by increasing i.
  let f = new Float64Array(oppNeed + 1);
  f[0] = 0;                              // away already there
  for (let j = 1; j <= oppNeed; j += 1) f[j] = 1; // home needs 0 => home won

  for (let i = 1; i <= need; i += 1) {
    const next = new Float64Array(oppNeed + 1);
    next[0] = 0;
    for (let j = 1; j <= oppNeed; j += 1) {
      // Win the point -> home needs one fewer: g(i-1, j), which is f[j].
      // Lose it       -> away needs one fewer: g(i, j-1), already computed.
      next[j] = p * f[j] + (1 - p) * next[j - 1];
    }
    f = next;
  }
  return f[oppNeed];
}

// Find the per-point probability that reproduces a given game win probability
// in a race to `target` from 0-0. Monotonic in p, so bisection is exact enough
// and needs about forty iterations.
function calibratePointProbability(gameWinProb, target = DEFAULT_TARGET) {
  const wanted = Math.min(0.999, Math.max(0.001, gameWinProb));
  let lo = 0.001;
  let hi = 0.999;
  for (let i = 0; i < 40; i += 1) {
    const mid = (lo + hi) / 2;
    if (raceWinProbability(0, 0, target, mid) < wanted) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// Ultimate's time cap changes the target mid-game: once time expires the game
// plays to the leader's score plus one. Before that, it's a straight race.
// `elapsedMinutes` and `timeCapMinutes` come from the feed and the pool config.
//
// The crucial part is that the capped target is fixed at the instant the cap
// lands and never moves again. Recomputing leader-plus-one on every call looks
// equivalent and is not: the target chases the score upward, the game becomes
// mathematically unfinishable, and the live price never converges to 1. So the
// caller passes `capTarget` once it has been recorded, and only a game seeing
// the cap for the very first time derives it here.
function effectiveTarget({ homeScore, awayScore, target = DEFAULT_TARGET,
                           elapsedMinutes = null, timeCapMinutes = null,
                           capTarget = null }) {
  if (capTarget) return { target: Math.min(target, capTarget), capped: true };
  if (elapsedMinutes === null || timeCapMinutes === null) return { target, capped: false };
  if (elapsedMinutes < timeCapMinutes) return { target, capped: false };
  // The cap has just landed: whoever leads needs one more point, and a tie
  // means the next point wins it.
  const fresh = Math.max(homeScore, awayScore) + 1;
  return { target: Math.min(target, Math.max(fresh, 1)), capped: true, fresh: true };
}

// The live price for a game in progress.
function inPlayProbability(home, away, {
  homeScore = 0, awayScore = 0, target = DEFAULT_TARGET,
  elapsedMinutes = null, timeCapMinutes = null, capTarget = null,
} = {}) {
  const pre = winProbability(home, away);
  const p = calibratePointProbability(pre, target);
  const eff = effectiveTarget({
    homeScore, awayScore, target, elapsedMinutes, timeCapMinutes, capTarget });
  const prob = raceWinProbability(
    Math.min(homeScore, eff.target),
    Math.min(awayScore, eff.target),
    eff.target,
    p
  );
  return { prob, pointProb: p, preGameProb: pre, target: eff.target, capped: eff.capped };
}

// Betting is suspended briefly after every point. We learn about a score about
// seven seconds after it happens (measured across 19 live games), so anyone
// standing at the field has a few seconds of private information. Holding the
// market shut for a while after each point removes that edge; points arrive
// roughly every two and a half minutes, so the cost is a small slice of the
// available betting time.
const SUSPEND_MS = 20_000;

function isSuspended(lastPointAt, now = Date.now(), suspendMs = SUSPEND_MS) {
  if (!lastPointAt) return false;
  const at = typeof lastPointAt === 'number' ? lastPointAt : parseTs(lastPointAt);
  if (at === null || !Number.isFinite(at)) return false;
  return now - at < suspendMs;
}

function suspensionRemaining(lastPointAt, now = Date.now(), suspendMs = SUSPEND_MS) {
  if (!isSuspended(lastPointAt, now, suspendMs)) return 0;
  const at = typeof lastPointAt === 'number' ? lastPointAt : parseTs(lastPointAt);
  return Math.ceil((suspendMs - (now - at)) / 1000);
}

export {
  DEFAULT_TARGET,
  SUSPEND_MS,
  raceWinProbability,
  calibratePointProbability,
  effectiveTarget,
  inPlayProbability,
  isSuspended,
  suspensionRemaining,
};
