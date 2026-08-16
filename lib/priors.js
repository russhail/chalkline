// Chalk Line — expert priors.
//
// WFDF's seeding is the only information the model starts with, and it is a
// thin signal: it is built from qualification results across wildly different
// regions, months before the event. Ultiworld's previews and power rankings
// carry information seeding cannot — recent form, roster moves, and the
// long-standing pattern of some clubs travelling better than others.
//
// Each entry restates a published assessment as an *effective seed*: where the
// expert view would have placed this club. The model then treats that as the
// prior instead of the raw seed. Nothing here claims more certainty than the
// seeding did — the rating deviation is untouched, so these teams are still
// maximally uncertain and the first real result moves them as much as anyone.
//
// Adjustments are capped, deliberately. A wrong prior that is twice as
// confident is twice as damaging, and by day three of pool play the model has
// its own evidence and none of this matters much.
//
// Sources:
//   "WUCC 2026: The Five Most Essential Worlds Storylines", Ultiworld, 12 Aug 2026
//   "Club Power Rankings [8/12/26]", Ultiworld, 11 Aug 2026

const MAX_SEED_SHIFT = 14;

const PRIORS = [
  // --- Open ----------------------------------------------------------------
  // Named a dark horse with elite handlers and receivers, well clear of where
  // a 24 seed sits. The largest correction in the table, and the one most
  // likely to be wrong.
  { division: 'Open', name: 'Tchac', seed: 24, effectiveSeed: 12,
    note: 'Named a dark horse contender despite a low seed' },

  // Described as lurking for a podium spot rather than a mid-table finish.
  { division: 'Open', name: 'BFD la Fotta', seed: 12, effectiveSeed: 8,
    note: 'Rated a podium threat' },

  // Co-favourite alongside the American champions; a 3 seed understates that.
  { division: 'Open', name: 'Mooncatchers', seed: 3, effectiveSeed: 1,
    note: 'Co-favourite: defending European champions, deep roster' },

  // --- Women's -------------------------------------------------------------
  // Top of Ultiworld's domestic rankings, seeded 7th here.
  { division: "Women's", name: 'Scandal', seed: 7, effectiveSeed: 2,
    note: 'Ranked first domestically at the time of the event' },

  // Both dominate at home but have a long record of falling short at Worlds.
  // A modest downgrade, not a dismissal.
  { division: "Women's", name: 'Fury', seed: 3, effectiveSeed: 4,
    note: 'Domestically dominant, historically underperforms at Worlds' },
  { division: "Women's", name: 'Brute Squad', seed: 2, effectiveSeed: 3,
    note: 'Domestically dominant, historically underperforms at Worlds' },

  // European clubs picked out as genuine medal threats, all seeded well below
  // that. These are the corrections most likely to pay off.
  { division: "Women's", name: 'BFD Shout', seed: 18, effectiveSeed: 8,
    note: 'Picked as a serious medal contender' },
  { division: "Women's", name: 'GRUT', seed: 19, effectiveSeed: 9,
    note: 'Picked as a serious medal contender' },
  { division: "Women's", name: 'Mooncup', seed: 12, effectiveSeed: 7,
    note: 'Picked as a serious medal contender' },

  // Flagged as dangerous underdogs — a nudge, not a promotion.
  { division: "Women's", name: 'NLSU Yaka', seed: 16, effectiveSeed: 13,
    note: 'Flagged as a dangerous underdog' },
  { division: "Women's", name: 'jinX midnight', seed: 22, effectiveSeed: 18,
    note: 'Flagged as a dangerous underdog' },
  { division: "Women's", name: 'Tequila Boom Boom', seed: 11, effectiveSeed: 9,
    note: 'Flagged as a dangerous underdog' },

  // --- Mixed ---------------------------------------------------------------
  // Described as the only out-and-out favourite in any division, chasing a
  // third straight title. A 1 seed doesn't capture that separation.
  { division: 'Mixed', name: 'Hybrid', seed: 1, effectiveSeed: 1, ratingBonus: 60,
    note: 'The only out-and-out favourite across all three divisions' },

  // Closing on Hybrid, with the final widely expected to be these two.
  { division: 'Mixed', name: 'XIST', seed: 6, effectiveSeed: 2,
    note: 'Expected to meet Hybrid in the final' },

  { division: 'Mixed', name: 'Tartu Turbulence', seed: 13, effectiveSeed: 10,
    note: 'Named among the upset threats' },
];

// Match on division plus an exact (case-insensitive) name, because club names
// repeat across divisions — GRUT field both an Open and a Women's team, and
// adjusting the wrong one would be invisible and wrong.
function priorFor(name, division) {
  const n = String(name || '').trim().toLowerCase();
  return PRIORS.find((p) => p.division === division && p.name.toLowerCase() === n) || null;
}

// The seed the model should actually use, with the shift capped.
function effectiveSeed(name, division, seed) {
  const prior = priorFor(name, division);
  if (!prior) return { seed, prior: null };
  const shift = Math.max(-MAX_SEED_SHIFT, Math.min(MAX_SEED_SHIFT, prior.effectiveSeed - seed));
  return { seed: Math.max(1, seed + shift), prior };
}

export { PRIORS, MAX_SEED_SHIFT, priorFor, effectiveSeed };
