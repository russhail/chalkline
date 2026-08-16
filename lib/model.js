// Chalk Line — rating & pricing model.
// Zero dependencies. Glicko-style ratings so day-1 prices are wide and
// tighten as real results arrive; true odds (no vig); prices move with money.

const Q = Math.LN10 / 400;

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

// Turn a WFDF seed (1 = best) within a division of N teams into a starting
// rating. SPREAD is per-seed Elo; at Worlds the gap between a top club and a
// developing-nation club is genuinely enormous, so this is deliberately wide.
const BASE_RATING = 1500;
const SEED_SPREAD = 18;
const INITIAL_RD = 350; // high uncertainty => day-1 prices pulled toward even
const MIN_RD = 60;
const MAX_RD = 350;

function seedToRating(seed, fieldSize) {
  const median = (fieldSize + 1) / 2;
  return BASE_RATING + (median - seed) * SEED_SPREAD;
}

function newTeam({ id, name, division, seed, fieldSize }) {
  return {
    id,
    name,
    division,
    seed,
    rating: seedToRating(seed, fieldSize),
    rd: INITIAL_RD,
    played: 0,
  };
}

// ---------------------------------------------------------------------------
// Win probability
// ---------------------------------------------------------------------------

// Glicko's g(): damps the rating difference by how uncertain we are about the
// two teams. This is what makes day 1 cautious without any special-casing.
function damping(rdA, rdB) {
  const varSum = rdA * rdA + rdB * rdB;
  return 1 / Math.sqrt(1 + (3 * Q * Q * varSum) / (Math.PI * Math.PI));
}

function winProbability(teamA, teamB) {
  const g = damping(teamA.rd, teamB.rd);
  const diff = teamA.rating - teamB.rating;
  return 1 / (1 + Math.pow(10, (-g * diff) / 400));
}

// ---------------------------------------------------------------------------
// Expected winning margin
// ---------------------------------------------------------------------------

// Ultimate games run to 15 with a hard cap, so margin is bounded. Map the
// rating gap onto an expected margin and keep it inside a plausible range.
const MAX_MARGIN = 13;

function expectedMargin(teamA, teamB) {
  const g = damping(teamA.rd, teamB.rd);
  const diff = (teamA.rating - teamB.rating) * g;
  // ~1 point of margin per 55 Elo, saturating via tanh so blowouts stay sane.
  const raw = MAX_MARGIN * Math.tanh(diff / 420);
  return Math.round(raw * 2) / 2; // nearest half point, so there's no push
}

// ---------------------------------------------------------------------------
// Margin distribution — the basis of the spread market
// ---------------------------------------------------------------------------

// Spread of plausible margins around the expected one. A game to 15 with a
// time cap can't run away indefinitely, so this is tighter than most sports;
// but when the model is unsure about the two teams it must widen, or a
// confident-looking line gets sold on almost no information.
const BASE_MARGIN_SD = 3.5;
const MAX_MARGIN_SD = 8;

function marginSpread(teamA, teamB) {
  const g = damping(teamA.rd, teamB.rd); // ~0.54 when new, ~0.95 once known
  return Math.min(MAX_MARGIN_SD, BASE_MARGIN_SD / Math.max(0.35, g));
}

// Normal CDF via the Abramowitz & Stegun erf approximation — accurate to about
// 1e-7, which is far beyond what a play-money line needs.
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return sign * y;
}

const normalCdf = (z) => 0.5 * (1 + erf(z / Math.SQRT2));

// P(home wins by more than `line`). Lines are half points, so a bet can never
// push — there is always a winner and a loser.
function coverProbability(teamA, teamB, line) {
  const mean = expectedMargin(teamA, teamB);
  const sd = marginSpread(teamA, teamB);
  return clampProb(1 - normalCdf((line - mean) / sd));
}

// Three lines: the model's own, plus one either side. The middle one should
// price near evens; the outer two are the interesting bets — take the
// favourite to win big, or the underdog to keep it close.
const LADDER_STEP = 2;

// Every line must sit on a half point. A whole-number line looks harmless
// until a game lands exactly on it: there is no push in this book, so the
// backer simply loses a bet that was, in truth, a tie. Snapping to the
// nearest x.5 makes every handicap strictly decidable.
function toHalfPoint(x) {
  return Math.round(x - 0.5) + 0.5;
}

function spreadLadder(teamA, teamB) {
  const centre = toHalfPoint(expectedMargin(teamA, teamB));
  return [centre - LADDER_STEP, centre, centre + LADDER_STEP].map((line) => {
    const pHome = coverProbability(teamA, teamB, line);
    return {
      line,
      home: { prob: Math.round(pHome * 1e4) / 1e4, decimal: probToDecimal(pHome) },
      away: { prob: Math.round((1 - pHome) * 1e4) / 1e4, decimal: probToDecimal(1 - pHome) },
    };
  });
}

// Did the home side cover? Half-point lines mean this is never ambiguous.
function coversSpread(homeScore, awayScore, line) {
  return homeScore - awayScore > line;
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

const MIN_PROB = 0.02;
const MAX_PROB = 0.98;

function clampProb(p) {
  return Math.min(MAX_PROB, Math.max(MIN_PROB, p));
}

// Conservative pricing.
//
// The model is working from seeds and a handful of results, so its tails are
// the least trustworthy part of it — and the tails are exactly where a single
// lucky bet can decide a leaderboard. Two guards:
//
//   MARGIN   shortens both sides slightly, so implied probabilities sum to a
//            little over 1. Costs the confident bettor a few percent and
//            stops the book paying out more than it believes.
//   MAX_ODDS caps the longest price. A 46-to-1 on a rating gap the model
//            invented from seeding is a lottery ticket, not a bet.
const MARGIN = 0.05;
const MAX_ODDS = 12;
const MIN_ODDS = 1.02;

function probToDecimal(p) {
  const withMargin = clampProb(p) * (1 + MARGIN);
  const decimal = 1 / Math.min(0.995, withMargin);
  return Math.round(Math.min(MAX_ODDS, Math.max(MIN_ODDS, decimal)) * 100) / 100;
}

// Prices move with the money. Model probability acts as a prior with virtual
// liquidity L; real stakes pull the price toward whichever side is backed.
// L is in play-money units: bigger L = stickier line.
const LIQUIDITY = 50000;

function marketProbability(modelProb, stakeHome, stakeAway, liquidity = LIQUIDITY) {
  const total = stakeHome + stakeAway;
  return clampProb((modelProb * liquidity + stakeHome) / (liquidity + total));
}

// Full price for a fixture, given how much money is already on each side.
function priceGame(teamA, teamB, stakeA = 0, stakeB = 0) {
  const modelProb = winProbability(teamA, teamB);
  const pA = marketProbability(modelProb, stakeA, stakeB);
  const pB = 1 - pA;
  return {
    modelProb: Math.round(modelProb * 1e4) / 1e4,
    home: { prob: Math.round(pA * 1e4) / 1e4, decimal: probToDecimal(pA) },
    away: { prob: Math.round(pB * 1e4) / 1e4, decimal: probToDecimal(pB) },
    margin: expectedMargin(teamA, teamB),
  };
}

// ---------------------------------------------------------------------------
// Learning from results
// ---------------------------------------------------------------------------

// Glicko update. Margin of victory nudges the result score away from a flat
// win/loss, so a 15-3 teaches the model more than a 15-14.
function applyResult(teamA, teamB, scoreA, scoreB) {
  const margin = Math.abs(scoreA - scoreB);
  const total = Math.max(1, scoreA + scoreB);
  // Blend the binary outcome with the score share, lightly.
  const binary = scoreA > scoreB ? 1 : scoreA < scoreB ? 0 : 0.5;
  const share = scoreA / total;
  const observed = 0.75 * binary + 0.25 * share;

  const updated = [];
  for (const [self, opp, obs] of [
    [teamA, teamB, observed],
    [teamB, teamA, 1 - observed],
  ]) {
    const g = damping(0, opp.rd); // opponent uncertainty only, per Glicko
    const e = 1 / (1 + Math.pow(10, (-g * (self.rating - opp.rating)) / 400));
    const dSq = 1 / (Q * Q * g * g * e * (1 - e));
    const denom = 1 / (self.rd * self.rd) + 1 / dSq;
    const newRd = Math.min(MAX_RD, Math.max(MIN_RD, Math.sqrt(1 / denom)));
    const newRating = self.rating + Q * newRd * newRd * g * (obs - e);
    updated.push({
      ...self,
      rating: Math.round(newRating * 100) / 100,
      rd: Math.round(newRd * 100) / 100,
      played: self.played + 1,
      lastMargin: margin,
    });
  }
  return { home: updated[0], away: updated[1] };
}

export {
  BASE_RATING,
  INITIAL_RD,
  MARGIN,
  MAX_ODDS,
  LIQUIDITY,
  MAX_MARGIN,
  seedToRating,
  newTeam,
  damping,
  winProbability,
  expectedMargin,
  probToDecimal,
  marketProbability,
  marginSpread,
  normalCdf,
  coverProbability,
  spreadLadder,
  coversSpread,
  toHalfPoint,
  LADDER_STEP,
  priceGame,
  applyResult,
};
