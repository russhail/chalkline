-- Chalk Line — undo the premature settlement of 2026-08-15.
--
-- The sync settled games using the running score published in the standings
-- file. Nobody had bets on the affected game, so no payouts need reversing;
-- this puts the games back to unsettled and the ratings back to their seeded
-- values so the model relearns from real results.

BEGIN;

-- 1. Anything we settled goes back to unsettled. Voided games are admin
--    decisions and are left exactly as they are.
UPDATE games
SET settled = FALSE, rated = FALSE, status = 'scheduled',
    home_score = NULL, away_score = NULL, needs_review = NULL
WHERE settled = TRUE AND voided = FALSE;

-- 2. Any bet that was graded on a bad score returns to open, and the payout
--    is taken back out of the bankroll. (Expected to affect zero rows.)
UPDATE users u
SET bankroll = u.bankroll - COALESCE((
      SELECT SUM(b.payout) FROM bets b
      WHERE b.user_id = u.id AND b.status = 'won'
    ), 0)
WHERE EXISTS (SELECT 1 FROM bets b WHERE b.user_id = u.id AND b.status = 'won');

UPDATE bets SET status = 'open', payout = 0, settled_at = NULL
WHERE status IN ('won', 'lost');

-- 3. Ratings back to the seeded prior: 1500 + (median seed - seed) * 18,
--    with maximum uncertainty, exactly as newTeam() computes them.
UPDATE teams t
SET rating = 1500 + (
      ((SELECT COUNT(*) FROM teams x WHERE x.division = t.division) + 1) / 2.0 - t.seed
    ) * 18,
    rd = 350,
    played = 0;

-- 4. Force the next sync to do a full pass rather than trust the cache version.
DELETE FROM meta WHERE key IN ('cache_version', 'last_sync_attempt');

COMMIT;

-- Check: started should be > 0 once the 12:00 game is back in play.
SELECT COUNT(*) FILTER (WHERE settled)              AS still_settled,
       COUNT(*) FILTER (WHERE starts_at <= now())   AS started,
       COUNT(*)                                     AS total
FROM games WHERE home_team_id > 0;
