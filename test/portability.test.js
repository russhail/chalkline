import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The test suite runs on SQLite, so anything Postgres rejects but SQLite
// tolerates ships green and breaks in production. These are static checks over
// the SQL we actually write — crude, but they catch the exact class of bug
// that has bitten repeatedly today.

const libDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib');
// Comments discuss these patterns by name, so strip them before scanning —
// otherwise the guard trips on the note explaining why the guard exists.
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const sources = readdirSync(libDir)
  .filter((f) => f.endsWith('.js'))
  .map((f) => ({ file: f, text: stripComments(readFileSync(join(libDir, f), 'utf8')) }));

test('no placeholder is compared against NULL', () => {
  // "could not determine data type of parameter $n" (42P08). Postgres infers a
  // parameter's type from its context; `$4 IS NULL` provides none.
  for (const { file, text } of sources) {
    const hits = text.match(/\$\d+\s+IS\s+(NOT\s+)?NULL/gi) || [];
    assert.deepEqual(hits, [],
      `${file} compares a placeholder to NULL (${hits.join(', ')}). ` +
      'Build the clause conditionally, or cast the parameter.');
  }
});

test('no placeholder sits bare inside COALESCE', () => {
  // Same failure mode: COALESCE($1, x) gives Postgres nothing to infer from.
  for (const { file, text } of sources) {
    const hits = text.match(/COALESCE\s*\(\s*\$\d+/gi) || [];
    assert.deepEqual(hits, [], `${file} has an untypeable COALESCE parameter`);
  }
});

test('timestamps are never bucketed by casting them to text', () => {
  // Postgres renders a timestamptz in the session timezone, so CAST(ts AS TEXT)
  // silently assigns games to the wrong day if the session isn't UTC.
  for (const { file, text } of sources) {
    const hits = text.match(/CAST\s*\(\s*\w*(starts_at|created_at|placed_at|settled_at)\w*\s+AS\s+TEXT/gi) || [];
    assert.deepEqual(hits, [],
      `${file} casts a timestamp to text (${hits.join(', ')}); use an explicit UTC conversion`);
  }
});

test('boolean columns are compared to TRUE/FALSE, not 1/0', () => {
  // Postgres will not compare a boolean to an integer; the SQLite adapter
  // rewrites TRUE/FALSE, so writing the Postgres form is the portable one.
  for (const { file, text } of sources) {
    const hits = text.match(/\b(settled|voided|rated|is_admin|verified|forfeit)\s*=\s*[01]\b/g) || [];
    assert.deepEqual(hits, [], `${file} compares a boolean to an integer (${hits.join(', ')})`);
  }
});

test('every query that groups by a derived day does so in UTC', () => {
  for (const { file, text } of sources) {
    if (!/GROUP BY/i.test(text)) continue;
    if (/starts_at/.test(text) && /to_char|SUBSTR/i.test(text)) {
      assert.match(text, /dialect === 'postgres'|AT TIME ZONE 'UTC'/,
        `${file} derives a day from a timestamp without pinning the timezone`);
    }
  }
});

test('the two backends declare which dialect they speak', async () => {
  const { SqliteStore, NeonHttpStore } = await import('../lib/store.js');
  assert.equal(new SqliteStore(':memory:').dialect, 'sqlite');
  assert.equal(
    new NeonHttpStore('postgresql://u:p@ep-x.eu-central-1.aws.neon.tech/db').dialect,
    'postgres'
  );
});

test('the SQLite adapter rejects a binding count Postgres would reject', async () => {
  const { createStore } = await import('../lib/store.js');
  const s = createStore({ backend: 'sqlite' });
  await s.migrate();

  // Too many: exactly the search bug — both IN clauses referenced $1, but the
  // ids were passed twice. SQLite ignored the extras; Postgres returned 08P01.
  await assert.rejects(
    () => s.query('SELECT * FROM teams WHERE id IN ($1) OR id IN ($1)', [7, 7]),
    /binds 2 parameters but the statement uses \$1\.\.\$1/);

  // Too few, which SQLite would happily bind as NULL.
  await assert.rejects(
    () => s.query('SELECT * FROM teams WHERE id = $1 AND seed = $2', [7]),
    /binds 1 parameters/);

  // The correct form still works, repeated placeholder and all.
  const rows = await s.query('SELECT * FROM teams WHERE id IN ($1) OR id IN ($1)', [7]);
  assert.ok(Array.isArray(rows));
  s.close();
});

test('no database timestamp is parsed with a bare Date.parse', () => {
  // Postgres renders TIMESTAMPTZ as '2026-08-15 16:00:00+00'. The '+00' is not
  // a valid ISO offset, so Date.parse returns NaN and every comparison against
  // it quietly becomes false. lib/time.js exists precisely for this.
  for (const { file, text } of sources) {
    const hits = text.match(/Date\.parse\s*\(\s*(String\()?\s*\w*\.?(starts_at|placed_at|settled_at|created_at|window_start|session_started|last_point_at)/g) || [];
    assert.deepEqual(hits, [],
      `${file} parses a database timestamp directly (${hits.join(', ')}); use parseTs()`);
  }
});
