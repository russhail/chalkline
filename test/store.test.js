import { test } from 'node:test';
import assert from 'node:assert/strict';
import { neonSqlEndpoint, SqliteStore } from '../lib/store.js';

test('the Neon HTTP endpoint replaces the first hostname label with api.', () => {
  assert.equal(
    neonSqlEndpoint('postgresql://u:p@ep-cool-name-123456.eu-central-1.aws.neon.tech/neondb'),
    'https://api.eu-central-1.aws.neon.tech/sql'
  );
});

test('pooled and direct connection strings resolve to the same endpoint', () => {
  const direct = neonSqlEndpoint('postgres://u:p@ep-x-99.us-east-2.aws.neon.tech/db');
  const pooled = neonSqlEndpoint('postgres://u:p@ep-x-99-pooler.us-east-2.aws.neon.tech/db');
  assert.equal(direct, pooled);
  assert.equal(direct, 'https://api.us-east-2.aws.neon.tech/sql');
});

test('query parameters on the connection string do not break endpoint parsing', () => {
  assert.equal(
    neonSqlEndpoint('postgresql://u:p@ep-a-1.eu-west-2.aws.neon.tech/db?sslmode=require&x=1'),
    'https://api.eu-west-2.aws.neon.tech/sql'
  );
});

test('repeated placeholders are remapped for SQLite in order of appearance', () => {
  const { sql, order } = SqliteStore.translate(
    'UPDATE users SET bankroll = bankroll - $1 WHERE id = $2 AND bankroll >= $1'
  );
  assert.equal(sql, 'UPDATE users SET bankroll = bankroll - ? WHERE id = ? AND bankroll >= ?');
  assert.deepEqual(order, [0, 1, 0]);
});

test('boolean literals are rewritten for SQLite but left alone for Postgres', () => {
  const { sql } = SqliteStore.translate('SELECT * FROM games WHERE settled = FALSE AND rated = TRUE');
  assert.match(sql, /settled = 0/);
  assert.match(sql, /rated = 1/);
});

import { coerceRows, coerceValue } from '../lib/store.js';

// Postgres OIDs: 20 int8, 23 int4, 701 float8, 1700 numeric, 16 bool, 25 text.
test('bigint ids arrive as strings and are coerced to numbers', () => {
  const rows = coerceRows(
    [{ id: '1311', home_team_id: '1131', stake_home: 0 }],
    [{ name: 'id', dataTypeID: 20 }, { name: 'home_team_id', dataTypeID: 20 },
     { name: 'stake_home', dataTypeID: 701 }]
  );
  assert.strictEqual(rows[0].id, 1311, 'an id must be a number, or === comparisons fail');
  assert.strictEqual(rows[0].home_team_id, 1131);
});

test('counts and sums come back as numbers, not strings', () => {
  const rows = coerceRows(
    [{ n: '656', total: '12345.67' }],
    [{ name: 'n', dataTypeID: 20 }, { name: 'total', dataTypeID: 1700 }]
  );
  assert.strictEqual(rows[0].n, 656);
  assert.strictEqual(rows[0].total, 12345.67);
});

test('booleans survive whichever way the wire encodes them', () => {
  assert.strictEqual(coerceValue('t', 16), true);
  assert.strictEqual(coerceValue('f', 16), false);
  assert.strictEqual(coerceValue(true, 16), true);
  assert.strictEqual(coerceValue(false, 16), false);
});

test('text and timestamps are left completely alone', () => {
  const rows = coerceRows(
    [{ name: 'Colony', starts_at: '2026-08-15 14:00:00+00', code: '0012' }],
    [{ name: 'name', dataTypeID: 25 }, { name: 'starts_at', dataTypeID: 1184 },
     { name: 'code', dataTypeID: 25 }]
  );
  assert.strictEqual(rows[0].name, 'Colony');
  assert.strictEqual(rows[0].starts_at, '2026-08-15 14:00:00+00');
  assert.strictEqual(rows[0].code, '0012', 'a text column that looks numeric must not be mangled');
});

test('nulls stay null', () => {
  assert.strictEqual(coerceValue(null, 20), null);
  assert.strictEqual(coerceValue(null, 16), null);
});

test('an integer too large for JS stays a string rather than going silently wrong', () => {
  const huge = '9007199254740993';
  assert.strictEqual(coerceValue(huge, 20), huge);
});

test('rows pass through untouched when the response carries no field metadata', () => {
  const rows = [{ id: '7' }];
  assert.strictEqual(coerceRows(rows, [])[0].id, '7');
});
