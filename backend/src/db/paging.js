const { hydrateSessions } = require('./hydrate');

// Keyset pagination for lists of finished sessions (friend history + feed).
const PAGE_DEFAULT = 20;
const PAGE_MAX = 50;

// Cursor = "<finished_at as exact UTC timestamp with µs>|<session id>". Ordering is
// (finished_at DESC, id DESC) so ties on finished_at still page deterministically.
const CURSOR_TS = `to_char(s.finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

// Accept only the exact format CURSOR_TS emits (UTC, microseconds), and only
// real calendar dates — Date.parse alone is too lenient (e.g. "2020", "June 5",
// "2026-02-30") and Postgres would then reject the value with a 500.
const CURSOR_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
function isCursorTs(ts) {
  if (!CURSOR_TS_RE.test(ts)) return false;
  const d = new Date(ts.slice(0, 23) + 'Z');   // ms precision is enough to round-trip
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 23) === ts.slice(0, 23);
}

function parsePage(query) {
  let limit = parseInt(query.limit, 10);
  if (!Number.isFinite(limit) || limit < 1) limit = PAGE_DEFAULT;
  limit = Math.min(limit, PAGE_MAX);
  let before = null;
  if (typeof query.before === 'string' && query.before) {
    const i = query.before.lastIndexOf('|');
    const ts = i > 0 ? query.before.slice(0, i) : '';
    const id = i > 0 ? query.before.slice(i + 1) : '';
    if (!id || !isCursorTs(ts)) return { error: 'invalid cursor' };
    before = { ts, id };
  }
  return { limit, before };
}

// rows were fetched with LIMIT limit+1; trims and builds the next cursor.
async function pageResponse(rows, limit) {
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const items = await hydrateSessions(pageRows.map(({ cursor_ts, ...r }) => r));
  const last = pageRows[pageRows.length - 1];
  return { items, nextCursor: hasMore ? `${last.cursor_ts}|${last.id}` : null };
}

module.exports = { isCursorTs, parsePage, pageResponse, CURSOR_TS, PAGE_DEFAULT, PAGE_MAX };
