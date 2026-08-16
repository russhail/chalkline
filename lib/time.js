// Chalk Line — timestamp normalisation.
//
// The two storage backends hand timestamps back differently:
//   SQLite   '2026-08-15T14:00:00.000Z'   (exactly what we wrote)
//   Postgres '2026-08-15 14:00:00+00'     (TIMESTAMPTZ, space-separated)
//
// V8 happily parses both, so this looks fine in Node and in Chrome. Safari's
// Date parser is stricter and returns NaN for the space-separated form — which
// would put "Invalid Date" on every fixture for anyone on an iPhone, i.e. most
// people standing at the fields. So every timestamp is normalised to ISO 8601
// before it leaves the API.

const PG_SHAPE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)(?:([+-]\d{2})(?::?(\d{2}))?|Z)?$/;

function parseTs(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;

  const s = String(value).trim();
  const m = PG_SHAPE.exec(s);
  if (m) {
    const [, date, time, offHours, offMins] = m;
    const zone = offHours ? `${offHours}:${offMins ?? '00'}` : 'Z';
    const ms = Date.parse(`${date}T${time}${zone}`);
    if (Number.isFinite(ms)) return ms;
  }
  const fallback = Date.parse(s);
  return Number.isFinite(fallback) ? fallback : null;
}

function toIso(value) {
  const ms = parseTs(value);
  return ms === null ? null : new Date(ms).toISOString();
}

export { parseTs, toIso };
