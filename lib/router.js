// Chalk Line — HTTP routing.
//
// A pure request handler: takes a plain request description, returns a plain
// response. server.js wraps it for local node:http, api/index.js wraps it for
// Vercel. Both run identical code, so the tests cover what ships.

import { createStore } from './store.js';
import * as auth from './auth.js';
import * as betting from './betting.js';
import { sync, syncLive, syncGameDetail, clearDerivedPoints, openGames, liveGames, gameDays, finishedGames, resultDays, poolsNeedingScores, getMeta, setMeta } from './sync.js';
import { priceGame, spreadLadder, probToDecimal } from './model.js';
import { toIso, parseTs } from './time.js';
import * as limit from './ratelimit.js';
import { inPlayProbability, suspensionRemaining } from './inplay.js';
import { teamStats, playerLeaders, coverage, comboLeaders, teamProfile, rankings, calibration } from './dashboard.js';

const COOKIE = 'chalkline_session';
// Anything that can vary by session must never sit in a shared cache — a
// cached /me would hand one player another player's account. So no-store is
// the default and caching is opt-in, per response, only for endpoints whose
// output is identical for every viewer.
const NO_STORE = 'no-store, no-cache, must-revalidate, private';
const json = (status, body, headers = {}) => ({
  status, body, headers: { 'Cache-Control': NO_STORE, ...headers },
});

// The board and the leaderboard are the same for everyone and are polled by
// every open tab. Without this, each poll is a fresh 194KB read out of
// Postgres; ten tabs would exhaust Neon's monthly egress in two days. A short
// shared cache collapses any amount of traffic into a few queries a minute.
const SHARED_CACHE = 'public, s-maxage=30, stale-while-revalidate=90';
const ok = (body) => json(200, body);
const fail = (status, error) => json(status, { error });

function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const sessionCookie = (token, maxAge = auth.SESSION_DAYS * 86400) =>
  `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${maxAge}`;

// ---------------------------------------------------------------------------
// Batched pricing so the board doesn't do N queries per game
// ---------------------------------------------------------------------------

async function priceBoard(store, rows) {
  const ids = [...new Set(rows.flatMap((r) => [r.home_team_id, r.away_team_id]))].filter(Boolean);
  if (!ids.length) return [];
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
  const teams = await store.query(`SELECT * FROM teams WHERE id IN (${placeholders})`, ids);
  const byId = new Map(teams.map((t) => [t.id, t]));

  return rows
    .map((g) => {
      const home = byId.get(g.home_team_id);
      const away = byId.get(g.away_team_id);
      if (!home || !away) return null;
      // No stakes passed: the displayed probability is the model's own, not a
      // market price bent by money that can no longer be staked. With both
      // stakes zero, marketProbability is the identity, so prob === modelProb
      // and the two sides sum to exactly 1.
      const p = priceGame(home, away);
      return {
        id: g.id,
        startsAt: toIso(g.starts_at),
        division: g.division,
        pool: g.pool_name,
        // Expected winning margin, signed towards the home side. Kept from the
        // pricing model because it says how one-sided, where the percentage
        // only says which way.
        margin: p.margin,
        home: { id: home.id, name: home.name, country: home.country, seed: home.seed,
                prob: p.home.prob },
        away: { id: away.id, name: away.name, country: away.country, seed: away.seed,
                prob: p.away.prob },
      };
    })
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

let cachedStore = null;
function storeFor(opts) {
  if (opts?.store) return opts.store;
  if (!cachedStore) cachedStore = createStore();
  return cachedStore;
}

// Serverless has no deploy step to hang a migration off, and every instance
// starts cold, so the schema is created on first use. All the statements are
// CREATE ... IF NOT EXISTS, so this is safe to run concurrently and cheap to
// repeat. Tests pass their own store and migrate themselves.
let migrated = null;
async function ensureSchema(store, opts) {
  if (opts?.store) return;
  if (!migrated) {
    migrated = store.migrate().catch((err) => {
      migrated = null; // let the next request retry rather than wedging forever
      throw err;
    });
  }
  return migrated;
}

// Is our storage actually durable? Without POSTGRES_URL we fall back to
// SQLite, which on serverless lives in an instance that gets thrown away —
// accounts and bets would silently vanish. Worth being able to see at a glance.
function storageMode() {
  const url = process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (url) return { backend: 'postgres', durable: true };
  return {
    backend: 'sqlite',
    durable: false,
    warning: 'No POSTGRES_URL set. Storage is in-memory and every cold start ' +
      'will wipe all accounts and bets. Attach a Postgres store and redeploy.',
  };
}

// Opportunistic sync. Guarded by a timestamp in the database rather than an
// in-process variable, because serverless instances don't share memory and
// each cold start would otherwise trigger its own sync.
const SYNC_INTERVAL_MS = 3 * 60 * 1000;
// Live pricing is only as good as the score behind it, and the feed's own
// cache is ten seconds. Anything slower than this and the board is quoting a
// score that has already changed.
const LIVE_INTERVAL_MS = 10 * 1000;
let syncInFlight = null;

// The live refresh is separate from the main sync: its own timestamp, its own
// interval, and it only touches the small active feed.
let liveInFlight = null;
async function maybeRefreshLive(store, now) {
  if (liveInFlight) return liveInFlight;
  try {
    const last = await getMeta(store, 'last_live_refresh');
    if (last && now - (parseTs(last) ?? 0) < LIVE_INTERVAL_MS) return null;
    await setMeta(store, 'last_live_refresh', new Date(now).toISOString());
    liveInFlight = syncLive(store)
      .catch(() => null)
      .finally(() => { liveInFlight = null; });
    return liveInFlight;
  } catch {
    return null;
  }
}

async function maybeSync(store, now, force = false, mode = 'full') {
  if (syncInFlight) return syncInFlight;
  try {
    const interval = mode === 'live' ? LIVE_INTERVAL_MS : SYNC_INTERVAL_MS;
    const last = await getMeta(store, 'last_sync_attempt');
    if (!force && last && now - (parseTs(last) ?? 0) < interval) return null;
    await setMeta(store, 'last_sync_attempt', new Date(now).toISOString());
    syncInFlight = sync(store, { now })
      .catch(async (err) => {
        // A silently failing sync is the worst outcome here: the site looks
        // healthy and simply never settles. Record it where health can see it.
        await setMeta(store, 'last_sync_error',
          `${new Date(now).toISOString()} ${err.message}`).catch(() => {});
        return { error: err.message };
      })
      .finally(() => { syncInFlight = null; });
    return syncInFlight;
  } catch {
    // A stale board is much better than a board that won't load.
    return null;
  }
}

async function handle(req, opts = {}) {
  const store = storeFor(opts);
  const now = opts.now ?? Date.now();
  try {
    await ensureSchema(store, opts);
  } catch (err) {
    return fail(500, `Database is not reachable: ${err.message}`);
  }
  const url = new URL(req.url, 'http://local');
  const path = url.pathname.replace(/^\/api/, '') || '/';
  const method = req.method.toUpperCase();
  const body = req.body ?? {};
  const cookies = parseCookies(req.headers?.cookie);
  const bearer = (req.headers?.authorization || '').replace(/^Bearer\s+/i, '');
  const sessionToken = cookies[COOKIE] || bearer || null;
  const who = limit.clientKey(req.headers);
  const me = await auth.userForToken(store, sessionToken, { now });

  const requireUser = () => {
    if (!me) throw Object.assign(new Error('Sign in first.'), { status: 401 });
    return me;
  };
  const requireAdmin = () => {
    const u = requireUser();
    if (!u.is_admin) throw Object.assign(new Error('Admins only.'), { status: 403 });
    return u;
  };

  try {
    // --- accounts ---------------------------------------------------------
    if (method === 'POST' && path === '/login') {
      // Keyed on the name being attacked as well as the source, so one
      // attacker can't lock everyone out by hammering the whole site.
      const bucket = `login:${who}:${String(body.displayName || '').toLowerCase()}`;
      const gate = await limit.hit(store, bucket, limit.WINDOW.LOGIN, now);
      if (!gate.allowed) {
        return fail(429, `Too many attempts. Try again in ${Math.ceil(gate.retryAfter / 60)} minutes.`);
      }
      const res = await auth.login(store, { ...body, now });
      if (!res.ok) return fail(401, res.error);
      await limit.clear(store, bucket);
      return json(200, { ok: true, user: res.user }, { 'Set-Cookie': sessionCookie(res.token) });
    }

    if (method === 'POST' && path === '/logout') {
      if (sessionToken) await auth.logout(store, sessionToken);
      return json(200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
    }

    if (method === 'POST' && path === '/regenerate-code') {
      const user = requireUser();
      const res = await auth.regenerateCode(store, { userId: user.id });
      return ok({ ok: true, recoveryCode: res.recoveryCode });
    }

    // Attach, change or remove the optional recovery address.
    if (method === 'POST' && path === '/email') {
      const user = requireUser();
      const res = await auth.setEmail(store, { userId: user.id, email: body.email });
      if (!res.ok) return fail(400, res.error);
      return ok({ ok: true, removed: Boolean(res.removed) });
    }

    // Always answers the same way, so it can't be used to discover which
    // addresses have accounts.
    if (method === 'POST' && path === '/recover') {
      const gate = await limit.hit(store, `recover:${who}`, limit.WINDOW.RECOVER, now);
      if (!gate.allowed) return fail(429, 'Too many recovery requests. Try again later.');
      if (!auth.recoveryByEmailEnabled()) {
        return fail(503, 'Recovery by email is not set up on this site.');
      }
      await auth.requestRecovery(store, { email: body.email });
      return ok({ ok: true, message: 'If that address has an account, a new code is on its way.' });
    }

    if (method === 'GET' && path === '/me') {
      if (!me) return ok({ user: null });
      // Top up here as well as on the sync tick, so someone who has just gone
      // broke is playable again on their next page load rather than after a
      // wait they can't see the end of.
      const [fresh] = await store.query('SELECT * FROM users WHERE id = $1', [me.id]);
      // Open bets are carried at cost, so the profit in the header matches the
      // one on the leaderboard instead of dipping every time you place a bet.
      const [risk] = await store.query(
        "SELECT SUM(stake) AS at_risk FROM bets WHERE user_id = $1 AND status = 'open'",
        [me.id]
      );
      return ok({ user: auth.publicUser(fresh || me, Number(risk?.at_risk) || 0) });
    }

    // --- board ------------------------------------------------------------
    if (method === 'GET' && path === '/games') {
      // Deliberately NOT awaited. Pulling the feed takes several seconds, and
      // making the board wait for it meant the first visitor after a stale
      // period got a request that ran past the function timeout. The board
      // always answers from what's already stored; /tick does the fetching.
      const division = url.searchParams.get('division');
      const day = url.searchParams.get('day');
      const days = await gameDays(store, { now });
      // With no day asked for, serve the first one that has games — so the
      // board is useful on arrival without fetching the whole tournament.
      const wanted = day || days[0]?.day || null;
      const rows = await openGames(store, { now, day: wanted });
      const filtered = division ? rows.filter((r) => r.division === division) : rows;
      // Finished games are deliberately absent: they belong in your own bet
      // history, not on a board of things you can still back.
      const [{ n: liveNow } = {}] = await store.query(
        `SELECT COUNT(*) AS n FROM games
         WHERE status = 'live' AND settled = FALSE AND voided = FALSE AND home_team_id > 0`
      );
      return json(200, {
        days,
        day: wanted,
        liveNow: Number(liveNow ?? 0),
        games: await priceBoard(store, filtered),
        now: new Date(now).toISOString(),
      }, { 'Cache-Control': SHARED_CACHE });
    }

    // Games in progress, priced from the current score. Cached for only a few
    // seconds: the price moves with every point, so a stale board here is a
    // wrong price rather than merely an old one.
    if (method === 'GET' && path === '/live') {
      if (opts.autoSync !== false) await maybeRefreshLive(store, now);
      const rows = await liveGames(store);
      const ids = [...new Set(rows.flatMap((r) => [r.home_team_id, r.away_team_id]))].filter(Boolean);
      let byId = new Map();
      if (ids.length) {
        const ph = ids.map((_, i) => `$${i + 1}`).join(',');
        const teams = await store.query(`SELECT * FROM teams WHERE id IN (${ph})`, ids);
        byId = new Map(teams.map((t) => [t.id, t]));
      }
      const games = rows.map((g) => {
        const home = byId.get(g.home_team_id);
        const away = byId.get(g.away_team_id);
        if (!home || !away) return null;
        const started = parseTs(g.started_at) ?? parseTs(g.starts_at);
        const live = inPlayProbability(home, away, {
          homeScore: g.live_home_score ?? 0,
          awayScore: g.live_away_score ?? 0,
          elapsedMinutes: started === null ? null : (now - started) / 60000,
          timeCapMinutes: g.time_cap ?? null,
        });
        const suspendedFor = suspensionRemaining(g.last_point_at, now);
        // Decided on the score, ahead of the official confirmation. Betting is
        // already closed server-side; this tells the board to stop offering it.
        const decided = betting.reachedTarget(g, now);
        return {
          id: g.id, division: g.division, pool: g.pool_name,
          startsAt: toIso(g.starts_at),
          score: { home: g.live_home_score ?? 0, away: g.live_away_score ?? 0 },
          capped: live.capped, target: live.target,
          decided,
          suspendedFor,
          // Priced here, through the same probToDecimal every other market
          // uses. The browser used to derive this itself and skipped the
          // floor, so a heavy live favourite could be shown at 0.96 — a price
          // that loses money on a winning bet. One pricing function, server
          // side, is the only way these can't drift apart.
          home: { id: home.id, name: home.name, country: home.country, seed: home.seed,
                  prob: Math.round(live.prob * 1e4) / 1e4,
                  decimal: probToDecimal(live.prob) },
          away: { id: away.id, name: away.name, country: away.country, seed: away.seed,
                  prob: Math.round((1 - live.prob) * 1e4) / 1e4,
                  decimal: probToDecimal(1 - live.prob) },
        };
      }).filter(Boolean);
      return json(200, { games, now: new Date(now).toISOString() },
        { 'Cache-Control': 'public, s-maxage=5, stale-while-revalidate=10' });
    }

    // Find a club and everything it still has to play. The board only looks
    // 36 hours ahead, so without this there is no way to answer "when does my
    // team play next" — or to bet on it.
    if (method === 'GET' && path === '/search') {
      const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
      if (q.length < 2) {
        return json(200, { query: q, teams: [], games: [] }, { 'Cache-Control': SHARED_CACHE });
      }
      const like = `%${q}%`;
      const teams = await store.query(
        `SELECT id, name, abbreviation, division, country, seed, rating, rd, played
         FROM teams
         WHERE LOWER(name) LIKE $1 OR LOWER(country) LIKE $1 OR LOWER(abbreviation) LIKE $1
         ORDER BY division, seed LIMIT 12`,
        [like]
      );
      if (!teams.length) return json(200, { query: q, teams: [], games: [] },
        { 'Cache-Control': SHARED_CACHE });

      const ids = teams.map((t) => t.id);
      const ph = ids.map((_, i) => `$${i + 1}`).join(',');
      const rows = await store.query(
        `SELECT g.id, g.home_team_id, g.away_team_id, g.division, g.pool_name, g.starts_at,
                g.stake_home, g.stake_away, g.status, g.settled, g.home_score, g.away_score,
                h.name AS home_name, h.country AS home_country, h.seed AS home_seed,
                a.name AS away_name, a.country AS away_country, a.seed AS away_seed
         FROM games g
         LEFT JOIN teams h ON h.id = g.home_team_id
         LEFT JOIN teams a ON a.id = g.away_team_id
         WHERE (g.home_team_id IN (${ph}) OR g.away_team_id IN (${ph}))
           AND g.home_team_id > 0 AND g.away_team_id > 0
         ORDER BY g.starts_at ASC LIMIT 40`,
        // Both IN clauses reference the same placeholders, so the values are
        // supplied once. Postgres counts bindings against the statement, not
        // against how many times each is used.
        ids
      );

      // parseTs, not Date.parse: Postgres returns '2026-08-15 16:00:00+00',
      // whose '+00' is not a valid ISO offset. Date.parse gives NaN, NaN > now
      // is false, and every fixture silently vanishes from the results.
      const upcoming = rows.filter(
        (r) => !r.settled && r.status === 'scheduled' && (parseTs(r.starts_at) ?? 0) > now
      );
      const played = rows.filter((r) => r.settled || r.home_score !== null);

      return json(200, {
        query: q,
        teams: teams.map((t) => ({
          id: t.id, name: t.name, division: t.division, country: t.country,
          seed: t.seed, played: t.played,
          // Exposed so the model's learning is inspectable from outside:
          // rating moves with results, and confidence rises as rd falls.
          rating: Math.round(Number(t.rating)),
          confidence: Math.round((1 - (Number(t.rd) - 60) / (350 - 60)) * 100),
        })),
        games: await priceBoard(store, upcoming),
        results: played.slice(-12).map((g) => ({
          id: g.id, startsAt: toIso(g.starts_at), division: g.division, pool: g.pool_name,
          home: { name: g.home_name, score: g.home_score },
          away: { name: g.away_name, score: g.away_score },
        })),
      }, { 'Cache-Control': SHARED_CACHE });
    }

    if (method === 'GET' && path.startsWith('/game/')) {
      const id = Number(path.split('/')[2]);
      const q = await betting.quote(store, id, { clock: () => now });
      const [row] = await store.query('SELECT * FROM games WHERE id = $1', [id]);
      // Positions show once the game has kicked off — not once betting is
      // locked. Those used to be the same question; in-play betting split
      // them, and keying off `locked` made everyone's bets appear and vanish
      // with each twenty-second suspension between points.
      const revealed = row ? betting.hasStarted(row, now) : q.locked;
      let bets = [];
      if (revealed) {
        bets = await store.query(
          `SELECT u.display_name, b.side, b.stake, b.odds, b.status
           FROM bets b JOIN users u ON u.id = b.user_id
           WHERE b.game_id = $1 ORDER BY b.stake DESC LIMIT 100`,
          [id]
        );
      }
      return ok({ game: q, bets, revealed });
    }

    // --- betting ----------------------------------------------------------
    // --- admin ------------------------------------------------------------
    if (method === 'POST' && path === '/admin/settle') {
      requireAdmin();
      const res = await betting.settleGame(store, {
        gameId: Number(body.gameId), homeScore: Number(body.homeScore),
        awayScore: Number(body.awayScore), clock: () => now,
      });
      return ok({ ok: true, ...res });
    }

    if (method === 'POST' && path === '/admin/void') {
      requireAdmin();
      const res = await betting.voidGame(store, {
        gameId: Number(body.gameId), reason: body.reason, clock: () => now,
      });
      return ok({ ok: true, ...res });
    }

    if (method === 'GET' && path === '/admin/games') {
      requireAdmin();
      const rows = await store.query(
        `SELECT g.*, h.name AS home_name, a.name AS away_name,
                (SELECT COUNT(*) FROM bets b WHERE b.game_id = g.id) AS bet_count
         FROM games g
         LEFT JOIN teams h ON h.id = g.home_team_id
         LEFT JOIN teams a ON a.id = g.away_team_id
         WHERE g.starts_at <= $1 AND g.settled = FALSE
         ORDER BY g.starts_at DESC LIMIT 100`,
        [new Date(now + 3600_000).toISOString()]
      );
      return ok({ games: rows.map((g) => ({ ...g, starts_at: toIso(g.starts_at) })) });
    }

    // A snapshot of everything that can't be rebuilt from the WFDF feed.
    // Neon's free plan keeps only 6 hours of restore history, which is no use
    // across an eight-day tournament: notice a problem the next morning and
    // the window has closed. Games and teams re-sync from the feed; accounts,
    // bets and the ledger do not.
    if (method === 'GET' && path === '/admin/export') {
      requireAdmin();
      const [users, bets, ledger, futures] = await Promise.all([
        store.query('SELECT id, display_name, email, is_admin, bankroll, topups, created_at FROM users'),
        store.query('SELECT * FROM bets'),
        store.query('SELECT * FROM ledger'),
        store.query('SELECT * FROM futures'),
      ]);
      // Ratings are learned from results and would take a full replay to
      // rebuild, so they travel with the backup.
      const teams = await store.query('SELECT id, rating, rd, played FROM teams');
      return json(200, {
        exportedAt: new Date(now).toISOString(),
        counts: { users: users.length, bets: bets.length, ledger: ledger.length },
        users, bets, ledger, futures, teamRatings: teams,
      }, { 'Content-Disposition': `attachment; filename="chalkline-backup.json"` });
    }

    // --- sync (cron or admin) --------------------------------------------
    if (path === '/sync' && (method === 'POST' || method === 'GET')) {
      const secret = process.env.CRON_SECRET;
      const provided = url.searchParams.get('secret') ||
        (req.headers?.authorization || '').replace(/^Bearer\s+/i, '');
      const isCron = secret && provided === secret;
      if (!isCron) requireAdmin();
      const result = await sync(store, { force: url.searchParams.get('force') === '1', now });
      // Last, and swallowed: this feeds a dashboard, and a dashboard must never
      // be the reason a bet doesn't settle.
      // ?backfill=1 pulls far harder, for filling the dashboard from cold.
      const backfill = url.searchParams.get('backfill') === '1';
      const detail = await syncGameDetail(store, backfill ? { limit: 90 } : {})
        .catch((e) => ({ error: e.message }));
      return ok({ ...result, detail });
    }

    // Refresh the feed. Called by the board after it renders, so the work
    // happens in its own request with the full function budget rather than
    // holding up the page. Rate-limited by a timestamp in the database, so
    // it's safe to leave open — hammering it just returns "not due yet".
    if (method === 'GET' && path === '/tick') {
      if (opts.autoSync === false) return ok({ skipped: true, reason: 'disabled' });
      const result = await maybeSync(store, now, url.searchParams.get('force') === '1');

      // The point-by-point ingest runs on every tick, including the ones where
      // the feed sync isn't due yet. They are separate jobs with separate
      // backlogs: the feed is rate-limited because re-pulling it costs
      // bandwidth and changes nothing, whereas the ingest has a finite queue
      // that only ever shrinks. Hanging it off the sync's three-minute window
      // meant ?backfill=1 did nothing at all on any tick that returned early —
      // which, with a pinger running every minute, is two ticks in three.
      // When there's nothing pending this is one indexed query returning no
      // rows, so running it unconditionally is close to free.
      const backfill = url.searchParams.get('backfill') === '1';
      // ?rederive=1 throws away every derived point and rebuilds from the feed.
      // For when the derivation changes, not for routine use.
      if (url.searchParams.get('rederive') === '1') await clearDerivedPoints(store);
      const detail = await syncGameDetail(store, {
        ...(backfill ? { limit: 90 } : {}),
        ...(opts.detailFetcher ? { fetcher: opts.detailFetcher } : {}),
      }).catch((e) => ({ error: e.message }));

      if (!result) {
        const last = await getMeta(store, 'last_sync_attempt');
        return ok({
          skipped: true, reason: 'not due', lastAttempt: last,
          nextDueInSeconds: last
            ? Math.max(0, Math.round((SYNC_INTERVAL_MS - (now - (parseTs(last) ?? now))) / 1000))
            : 0,
          detail,
        });
      }
      return ok({ ...result, detail });
    }

    // The stats dashboard. Identical for every viewer and moderately expensive
    // to assemble, so it takes the shared cache — one build a minute serves any
    // number of tabs.
    if (method === 'GET' && path === '/stats') {
      const division = url.searchParams.get('division') || null;
      const [teams, players, combos, cov] = await Promise.all([
        teamStats(store, { division }),
        playerLeaders(store, { division }),
        comboLeaders(store, { division, limit: 30, minGoals: 2 }),
        coverage(store),
      ]);
      return json(200, { teams, players, combos, coverage: cov },
        { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' });
    }

    // One club, every number it has, each placed against its division. Same
    // cache policy as /stats — the payload is identical for every viewer, and
    // assembling it is a handful of GROUP BYs that shouldn't run once per tab.
    if (method === 'GET' && path === '/team') {
      const id = Number(url.searchParams.get('id'));
      if (!Number.isInteger(id) || id <= 0) return fail(400, 'Bad team id.');
      const profile = await teamProfile(store, id);
      if (!profile) return fail(404, 'No such team.');
      return json(200, profile,
        { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' });
    }

    // What happened. The mirror of /games: that answers "what is still to
    // come", this answers "what did I miss" — and without it a finished game
    // would leave the site entirely, which for a stats site is backwards.
    if (method === 'GET' && path === '/results') {
      const division = url.searchParams.get('division');
      const day = url.searchParams.get('day');
      const days = await resultDays(store);
      const wanted = day || days[0]?.day || null;
      const rows = wanted ? await finishedGames(store, { day: wanted }) : [];
      return json(200, {
        days,
        day: wanted,
        games: division ? rows.filter((r) => r.division === division) : rows,
      }, { 'Cache-Control': SHARED_CACHE });
    }

    // The model's own order, which is not the seeding.
    if (method === 'GET' && path === '/rankings') {
      const division = url.searchParams.get('division') || null;
      const [teams, calib] = await Promise.all([
        rankings(store, { division }),
        // Shipped alongside the ranking on purpose: a table ordered by a model
        // should carry that model's own report card, not make you go looking.
        calibration(store, { division }),
      ]);
      return json(200, { teams, calibration: calib }, { 'Cache-Control': SHARED_CACHE });
    }

    if (method === 'GET' && path === '/health') {
      const [{ n } = {}] = await store.query('SELECT COUNT(*) AS n FROM games');
      const [{ t } = {}] = await store.query('SELECT COUNT(*) AS t FROM teams');
      const [{ u } = {}] = await store.query('SELECT COUNT(*) AS u FROM users');
      const [{ b } = {}] = await store.query("SELECT COUNT(*) AS b FROM bets WHERE status = 'open'");
      // Everything needed to tell, from outside, whether settlement is alive.
      const started = await store.query(
        `SELECT COUNT(*) AS c FROM games
         WHERE settled = FALSE AND voided = FALSE AND starts_at <= $1
           AND home_team_id > 0`,
        [new Date(now).toISOString()]
      );
      const pools = await poolsNeedingScores(store, { now });
      return ok({
        ok: true,
        storage: storageMode(),
        games: Number(n ?? 0),
        teams: Number(t ?? 0),
        users: Number(u ?? 0),
        openBets: Number(b ?? 0),
        sync: {
          lastSync: await getMeta(store, 'last_sync'),
          lastAttempt: await getMeta(store, 'last_sync_attempt'),
          lastError: await getMeta(store, 'last_sync_error'),
          cacheVersion: await getMeta(store, 'cache_version'),
          startedUnsettledGames: Number(started[0]?.c ?? 0),
          poolsAwaitingScores: pools.length,
        },
        recoveryByEmail: auth.recoveryByEmailEnabled(),
        time: new Date(now).toISOString(),
      });
    }

    return fail(404, 'No such endpoint.');
  } catch (err) {
    if (err instanceof betting.BetError) return fail(400, err.message);
    if (err.status) return fail(err.status, err.message);
    return fail(500, err.message || 'Something went wrong.');
  }
}

export { handle, parseCookies, priceBoard, COOKIE };
