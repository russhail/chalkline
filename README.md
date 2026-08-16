# Chalk Line

Play-money betting on every game at the **WFDF 2026 World Ultimate Club Championships**
(Limerick, 15–22 August 2026). No real money, no prizes.

Live at [chalklineultimate.com](https://chalklineultimate.com).

## How it works

**Odds.** There is no betting market for ultimate to copy, so prices come from a
Glicko-style rating model seeded from each team's WFDF division seed. Uncertainty is
high on day one, which deliberately pulls prices toward even money; as results arrive
the uncertainty falls and the lines sharpen on their own. Prices are **true odds — no
vig** — and they **move with the money**: your bet locks the price you were shown, and
the next punter sees a price shifted by what you just backed.

**Results.** The WFDF results site publishes static JSON, so settlement is a plain
`fetch` on a schedule rather than a scraper. Worth knowing: the games file
(`WUCC2026_games.json`) never carries a score — every game reads `scheduled` forever.
Scores live in the per-pool standings files as `homescore` / `visitorscore`, alongside
a `forfeit` flag and the pool's own rules (score cap, time cap, draws allowed). So the
sync reads standings, and only for pools with a game that has kicked off and isn't
settled — checking all 55 every five minutes would be 55 requests for nothing.

A heartbeat file exposes a cache version, so a sync that finds nothing new costs one
small request. Forfeits and level scores are flagged for the admin rather than
auto-settled: a level score is impossible under the rules and means the data is wrong,
and a forfeit is a judgement call about whether the bet should stand.

**Rules.** Everyone starts with 10,000 bucks — play money, no real value. Bets lock at the scheduled start time, no exceptions.
Rainouts, forfeits and abandoned games are voided by the admin and refunded in full.
Anyone under 500 bucks gets topped up once a day.

## Running it

```bash
npm run dev     # http://localhost:3000, SQLite
npm test        # 76 tests, no network needed
```

Zero runtime dependencies — Node 22's built-in `node:sqlite`, `node:crypto` and `fetch`
do all of it.

## Deploying

Import the repo on Vercel. Required environment variables:

| Variable | Purpose |
|---|---|
| `POSTGRES_URL` | Vercel Postgres / Neon connection string. Without it the app falls back to SQLite, which does not persist on serverless. |
| `CRON_SECRET` | Guards `/api/sync` so only the cron job can trigger it. |
| `RESEND_API_KEY` | Optional. Enables email verification; without it accounts are auto-verified. |
| `MAIL_FROM` | Optional. Sender address for verification mail. |

`vercel.json` registers a daily cron on `/api/sync` (Vercel's free tier allows only
daily crons). That is far too slow for a live tournament, so the board *also* syncs
opportunistically: if the last attempt was more than three minutes ago, the next person
to load the board triggers a refresh. When nothing has changed that costs one small
heartbeat request. If the feed is unreachable the board still renders from the last
known state.

The schema is created automatically on the first request — serverless has no deploy
hook to hang a migration off, and every instance starts cold. `GET /api/health` reports
which storage backend is live and warns loudly if `POSTGRES_URL` is missing, because
the SQLite fallback is not durable on serverless.

To make yourself an admin, run once against the database:

```sql
UPDATE users SET is_admin = TRUE WHERE email = 'you@example.com';
```

## Layout

```
lib/model.js     ratings, win probability, pricing
lib/wfdf.js      the WFDF feed, normalised
lib/sync.js      feed -> database, and auto-settlement
lib/betting.js   placing, settling, voiding, leaderboards
lib/store.js     SQLite (dev/test) and Postgres-over-HTTP (prod)
lib/auth.js      accounts, scrypt passwords, sessions
lib/router.js    the HTTP API, shared by server.js and api/index.js
public/          the whole front end, one file
```
