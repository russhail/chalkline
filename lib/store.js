// Chalk Line — storage layer.
//
// Two backends, one interface:
//   sqlite     node:sqlite, used for local dev and the whole test suite
//   neon-http  Vercel Postgres over its HTTP SQL endpoint, used in production
//
// Production is serverless, so a TCP pool is the wrong shape and would need a
// driver we can't install anyway. Neon exposes plain HTTP SQL, so the adapter
// is a fetch call. SQL is written in Postgres dialect ($1 placeholders) and
// rewritten for SQLite, so the tests exercise the same statements that ship.

const PG_TYPES = {
  ID: 'BIGSERIAL PRIMARY KEY',
  INT: 'BIGINT',
  NUM: 'DOUBLE PRECISION',
  TEXT: 'TEXT',
  BOOL: 'BOOLEAN',
  TS: 'TIMESTAMPTZ',
};

const SQLITE_TYPES = {
  ID: 'INTEGER PRIMARY KEY AUTOINCREMENT',
  INT: 'INTEGER',
  NUM: 'REAL',
  TEXT: 'TEXT',
  BOOL: 'INTEGER',
  TS: 'TEXT',
};

function buildSchema(T) {
  return [
    `CREATE TABLE IF NOT EXISTS users (
      id ${T.ID},
      display_name ${T.TEXT} NOT NULL,
      recovery_hash ${T.TEXT} NOT NULL,
      email ${T.TEXT},
      is_admin ${T.BOOL} NOT NULL DEFAULT FALSE,
      bankroll ${T.NUM} NOT NULL DEFAULT 10000,
      topups ${T.INT} NOT NULL DEFAULT 0,
      granted ${T.NUM} NOT NULL DEFAULT 10000,
      created_at ${T.TS} NOT NULL
    )`,
    // One row per point, with the possession chain already resolved. Storing
    // the derivation rather than the raw goals means the dashboard is a GROUP
    // BY instead of 656 file fetches and a replay on every page load.
    `CREATE TABLE IF NOT EXISTS points (
      game_id ${T.INT} NOT NULL,
      num ${T.INT} NOT NULL,
      time_s ${T.INT} NOT NULL,
      duration_s ${T.INT} NOT NULL,
      usable_clock ${T.BOOL} NOT NULL DEFAULT TRUE,
      anchored ${T.BOOL} NOT NULL DEFAULT FALSE,
      o_team_id ${T.INT},
      d_team_id ${T.INT},
      score_team_id ${T.INT} NOT NULL,
      is_break ${T.BOOL},
      scorer_id ${T.INT},
      scorer_name ${T.TEXT},
      assist_id ${T.INT},
      assist_name ${T.TEXT},
      is_callahan ${T.BOOL} NOT NULL DEFAULT FALSE,
      division ${T.TEXT},
      PRIMARY KEY (game_id, num)
    )`,
    `CREATE TABLE IF NOT EXISTS timeouts (
      game_id ${T.INT} NOT NULL,
      time_s ${T.INT} NOT NULL,
      team_id ${T.INT} NOT NULL,
      converted ${T.BOOL},
      PRIMARY KEY (game_id, time_s, team_id)
    )`,
    `CREATE TABLE IF NOT EXISTS sessions (
      token ${T.TEXT} PRIMARY KEY,
      user_id ${T.INT} NOT NULL,
      created_at ${T.TS} NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS teams (
      id ${T.INT} PRIMARY KEY,
      name ${T.TEXT} NOT NULL,
      abbreviation ${T.TEXT},
      division ${T.TEXT} NOT NULL,
      country ${T.TEXT},
      seed ${T.INT},
      rating ${T.NUM} NOT NULL,
      rd ${T.NUM} NOT NULL,
      played ${T.INT} NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS games (
      id ${T.INT} PRIMARY KEY,
      home_team_id ${T.INT},
      away_team_id ${T.INT},
      home_label ${T.TEXT},
      away_label ${T.TEXT},
      division ${T.TEXT},
      pool_id ${T.INT},
      pool_name ${T.TEXT},
      starts_at ${T.TS},
      status ${T.TEXT} NOT NULL DEFAULT 'scheduled',
      home_score ${T.INT},
      away_score ${T.INT},
      settled ${T.BOOL} NOT NULL DEFAULT FALSE,
      voided ${T.BOOL} NOT NULL DEFAULT FALSE,
      void_reason ${T.TEXT},
      forfeit ${T.BOOL} NOT NULL DEFAULT FALSE,
      needs_review ${T.TEXT},
      live_home_score ${T.INT},
      live_away_score ${T.INT},
      last_point_at ${T.TS},
      live_event_num ${T.INT},
      started_at ${T.TS},
      time_cap ${T.INT},
      cap_target ${T.INT},
      stake_home ${T.NUM} NOT NULL DEFAULT 0,
      stake_away ${T.NUM} NOT NULL DEFAULT 0,
      rated ${T.BOOL} NOT NULL DEFAULT FALSE
    )`,
    `CREATE TABLE IF NOT EXISTS bets (
      id ${T.ID},
      user_id ${T.INT} NOT NULL,
      game_id ${T.INT} NOT NULL,
      side ${T.TEXT} NOT NULL,
      market ${T.TEXT} NOT NULL DEFAULT 'moneyline',
      in_play ${T.BOOL} NOT NULL DEFAULT FALSE,
      line ${T.NUM},
      stake ${T.NUM} NOT NULL,
      odds ${T.NUM} NOT NULL,
      status ${T.TEXT} NOT NULL DEFAULT 'open',
      payout ${T.NUM} NOT NULL DEFAULT 0,
      placed_at ${T.TS} NOT NULL,
      settled_at ${T.TS}
    )`,
    `CREATE TABLE IF NOT EXISTS futures (
      id ${T.ID},
      user_id ${T.INT} NOT NULL,
      market ${T.TEXT} NOT NULL,
      team_id ${T.INT} NOT NULL,
      stake ${T.NUM} NOT NULL,
      odds ${T.NUM} NOT NULL,
      status ${T.TEXT} NOT NULL DEFAULT 'open',
      payout ${T.NUM} NOT NULL DEFAULT 0,
      placed_at ${T.TS} NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ledger (
      id ${T.ID},
      user_id ${T.INT} NOT NULL,
      amount ${T.NUM} NOT NULL,
      reason ${T.TEXT} NOT NULL,
      ref ${T.TEXT},
      created_at ${T.TS} NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS rate_limits (
      bucket ${T.TEXT} PRIMARY KEY,
      hits ${T.INT} NOT NULL DEFAULT 0,
      window_start ${T.TEXT} NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS meta (
      key ${T.TEXT} PRIMARY KEY,
      value ${T.TEXT}
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_name ON users(LOWER(display_name))`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(LOWER(email))`,
    `CREATE INDEX IF NOT EXISTS idx_bets_user ON bets(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_bets_game ON bets(game_id)`,
    `CREATE INDEX IF NOT EXISTS idx_games_start ON games(starts_at)`,
    `CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger(user_id)`,
  ];
}

// Statements that bring an older database up to date. Each is expected to fail
// harmlessly once already applied — SQLite has no ADD COLUMN IF NOT EXISTS —
// so migrate() runs them individually and swallows the errors.
function buildMigrations(T) {
  return [
    `ALTER TABLE users ADD COLUMN recovery_hash ${T.TEXT}`,
    `ALTER TABLE users ADD COLUMN email ${T.TEXT}`,
    `ALTER TABLE users ALTER COLUMN email DROP NOT NULL`,
    `ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL`,
    `ALTER TABLE bets ADD COLUMN market ${T.TEXT} DEFAULT 'moneyline'`,
    `ALTER TABLE bets ADD COLUMN line ${T.NUM}`,
    `ALTER TABLE bets ADD COLUMN in_play ${T.BOOL} DEFAULT FALSE`,
    `ALTER TABLE games ADD COLUMN live_home_score ${T.INT}`,
    `ALTER TABLE games ADD COLUMN live_away_score ${T.INT}`,
    `ALTER TABLE games ADD COLUMN last_point_at ${T.TS}`,
    `ALTER TABLE games ADD COLUMN live_event_num ${T.INT}`,
    `ALTER TABLE games ADD COLUMN started_at ${T.TS}`,
    `ALTER TABLE games ADD COLUMN time_cap ${T.INT}`,
    `ALTER TABLE games ADD COLUMN cap_target ${T.INT}`,
    // Every unit the house has handed a player: the opening 10,000 plus each
    // top-up. The leaderboard subtracts it, so charity never flatters a rank.
    `ALTER TABLE users ADD COLUMN granted ${T.NUM} NOT NULL DEFAULT 10000`,
    // Marks a game whose point-by-point detail has been pulled and derived, so
    // the ingest never re-reads a game that is already in.
    `ALTER TABLE games ADD COLUMN detail_synced ${T.BOOL} NOT NULL DEFAULT FALSE`,
    `ALTER TABLE games ADD COLUMN start_offence ${T.TEXT}`,
  ];
}

// --- SQLite adapter --------------------------------------------------------

class SqliteStore {
  dialect = 'sqlite';

  constructor(path = ':memory:') {
    // node:sqlite ships with Node 22 — no dependency to install.
    const { DatabaseSync } = require('node:sqlite');
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
  }

  // Postgres dialect in, SQLite dialect out.
  //
  // Postgres placeholders are named by position and may repeat ("... WHERE
  // bankroll >= $1" alongside "SET bankroll = bankroll - $1"). SQLite's are
  // anonymous and positional, so we rebuild the argument list in the order the
  // placeholders actually appear rather than assuming each is used once.
  static translate(sql) {
    const order = [];
    const out = sql
      .replace(/\$(\d+)/g, (_, n) => {
        order.push(Number(n) - 1);
        return '?';
      })
      .replace(/\bTRUE\b/g, '1')
      .replace(/\bFALSE\b/g, '0');
    return { sql: out, order };
  }

  async query(sql, params = []) {
    const { sql: translated, order } = SqliteStore.translate(sql);

    // Postgres rejects a statement bound with the wrong number of parameters
    // ("bind message supplies N parameters, but prepared statement requires
    // M", 08P01). SQLite is positional and simply ignores extras, so a
    // mismatch passes every test and fails in production. Be strict here so
    // the two behave the same.
    if (order.length) {
      const highest = Math.max(...order) + 1;
      if (params.length !== highest) {
        throw new Error(
          `SQL binds ${params.length} parameters but the statement uses $1..$${highest}. ` +
          'Postgres would reject this (08P01).'
        );
      }
    }

    const stmt = this.db.prepare(translated);
    const reordered = order.length ? order.map((i) => params[i]) : params;
    const normalised = reordered.map((p) =>
      typeof p === 'boolean' ? (p ? 1 : 0) : p === undefined ? null : p
    );
    if (/^\s*(select|with)/i.test(sql) || /returning/i.test(sql)) {
      return stmt.all(...normalised);
    }
    stmt.run(...normalised);
    return [];
  }

  async exec(sql) {
    this.db.exec(SqliteStore.translate(sql).sql);
  }

  async transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = await fn(this);
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  async migrate() {
    for (const stmt of buildSchema(SQLITE_TYPES)) await this.exec(stmt);
    for (const stmt of buildMigrations(SQLITE_TYPES)) {
      try { await this.exec(stmt); } catch { /* already applied */ }
    }
  }

  close() {
    this.db.close();
  }
}

// --- Neon HTTP adapter -----------------------------------------------------

// Neon's SQL-over-HTTP endpoint is NOT https://<db-host>/sql. The official
// driver rewrites the first hostname label to `api.`, so
//   ep-cool-name-123.eu-central-1.aws.neon.tech
//   -> https://api.eu-central-1.aws.neon.tech/sql
// The same rewrite collapses the pooled (`-pooler`) and direct hostnames onto
// one endpoint, so either connection string works.
// Verified against neondatabase/serverless, src/shims/net/index.ts.
const NEON_FIRST_LABEL = /^[^.]+\./;

function neonSqlEndpoint(connectionString) {
  const { hostname } = new URL(connectionString);
  return `https://${hostname.replace(NEON_FIRST_LABEL, 'api.')}/sql`;
}

// Postgres sends int8/numeric over the wire as STRINGS, because they can
// exceed what a JS number holds. SQLite sends numbers. Left alone, the two
// backends disagree about the type of every id, count and sum — which is
// subtle and horrible: `game.id === 1311` is false when the id arrived as
// "1311", so a click handler silently does nothing.
//
// The response carries a `fields` array with Postgres type OIDs, so we coerce
// by declared column type rather than by guessing from the value.
const PG_OID = {
  BOOL: 16,
  INT8: 20, INT2: 21, INT4: 23,
  FLOAT4: 700, FLOAT8: 701,
  NUMERIC: 1700,
};
const NUMERIC_OIDS = new Set([PG_OID.INT8, PG_OID.INT2, PG_OID.INT4,
                              PG_OID.FLOAT4, PG_OID.FLOAT8, PG_OID.NUMERIC]);

function coerceValue(value, oid) {
  if (value === null || value === undefined) return value;
  if (NUMERIC_OIDS.has(oid)) {
    if (typeof value === 'number') return value;
    const n = Number(value);
    // A bigint beyond JS's safe range must stay a string rather than become a
    // silently wrong number. Our ids are nowhere near it, but the rule holds.
    if (!Number.isFinite(n)) return value;
    if (Number.isInteger(n) && !Number.isSafeInteger(n)) return value;
    return n;
  }
  if (oid === PG_OID.BOOL) {
    if (typeof value === 'boolean') return value;
    return value === 't' || value === 'true' || value === true;
  }
  return value;
}

function coerceRows(rows, fields) {
  if (!fields.length || !rows.length) return rows;
  const oids = new Map(fields.map((f) => [f.name, f.dataTypeID]));
  return rows.map((row) => {
    const out = {};
    for (const [key, value] of Object.entries(row)) out[key] = coerceValue(value, oids.get(key));
    return out;
  });
}

class NeonHttpStore {
  dialect = 'postgres';

  constructor(connectionString) {
    if (!connectionString) throw new Error('POSTGRES_URL is not set');
    this.endpoint = neonSqlEndpoint(connectionString);
    this.connectionString = connectionString;
  }

  async query(sql, params = []) {
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Neon-Connection-String': this.connectionString,
        // Let the server do the type parsing and hand back objects; the
        // official driver asks for raw text only because it re-parses with
        // node-postgres, which we don't have.
        'Neon-Raw-Text-Output': 'false',
        'Neon-Array-Mode': 'false',
      },
      body: JSON.stringify({ query: sql, params }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Postgres HTTP ${res.status}: ${body.slice(0, 400)}`);
    }
    const data = await res.json();
    return coerceRows(data.rows || [], data.fields || []);
  }

  async exec(sql) {
    await this.query(sql, []);
  }

  // The HTTP endpoint is single-statement, so there is no interactive
  // transaction. Every write that must be atomic is expressed as a single
  // conditional statement instead (see lib/betting.js).
  async transaction(fn) {
    return fn(this);
  }

  async migrate() {
    for (const stmt of buildSchema(PG_TYPES)) await this.exec(stmt);
    for (const stmt of buildMigrations(PG_TYPES)) {
      try { await this.exec(stmt); } catch { /* already applied */ }
    }
  }

  close() {}
}

// `require` inside an ESM module — only used by the SQLite adapter, which
// never runs in the serverless bundle.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

function createStore(opts = {}) {
  const url = opts.connectionString ?? process.env.POSTGRES_URL ?? process.env.DATABASE_URL;
  if (opts.backend === 'sqlite' || (!url && opts.backend !== 'neon')) {
    return new SqliteStore(opts.path ?? process.env.SQLITE_PATH ?? ':memory:');
  }
  return new NeonHttpStore(url);
}

export { createStore, SqliteStore, NeonHttpStore, neonSqlEndpoint, coerceRows, coerceValue,
         buildSchema, buildMigrations, PG_TYPES, SQLITE_TYPES };
