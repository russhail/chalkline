import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTs, toIso } from '../lib/time.js';

// This is the exact string Postgres returned from the live deployment.
const PG = '2026-08-15 14:00:00+00';
const ISO = '2026-08-15T14:00:00.000Z';

test('the Postgres TIMESTAMPTZ shape parses to the right instant', () => {
  assert.equal(parseTs(PG), Date.parse(ISO));
  assert.equal(toIso(PG), ISO);
});

test('SQLite ISO strings round-trip unchanged', () => {
  assert.equal(toIso(ISO), ISO);
  assert.equal(parseTs(ISO), Date.parse(ISO));
});

test('offsets other than UTC are honoured, not dropped', () => {
  // Irish summer time is +01, so this is the same instant as 14:00Z.
  assert.equal(parseTs('2026-08-15 15:00:00+01'), Date.parse(ISO));
  assert.equal(parseTs('2026-08-15 15:00:00+01:00'), Date.parse(ISO));
});

test('fractional seconds survive', () => {
  assert.equal(toIso('2026-08-15 14:00:00.123+00'), '2026-08-15T14:00:00.123Z');
});

test('Date objects and epoch millis pass through', () => {
  assert.equal(toIso(new Date(ISO)), ISO);
  assert.equal(toIso(Date.parse(ISO)), ISO);
});

test('null and unparseable input yield null rather than Invalid Date', () => {
  for (const bad of [null, undefined, '', 'not a date', 'tomorrow']) {
    assert.equal(parseTs(bad), null, `parseTs(${JSON.stringify(bad)})`);
    assert.equal(toIso(bad), null);
  }
});

test('the emitted format is one Safari will accept', () => {
  // Safari requires the T separator and an explicit zone designator.
  assert.match(toIso(PG), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});
