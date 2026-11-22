// Leaderboard scoring: constants + pure math (no DB). The SQL in
// routes/leaderboard.js finds each user's best e1RM per exercise and their
// workout days; everything about how that turns into points lives here.

// Weekly/monthly periods reset at 00:00 in this timezone (Monday for weekly,
// the 1st for monthly). Any IANA zone name Postgres knows. LEADERBOARD_TZ in
// backend/.env overrides it without a code change.
const TIMEZONE = process.env.LEADERBOARD_TZ || 'America/New_York';

// Only sets in this rep range feed the e1RM (higher-rep estimates are noise).
const E1RM_MIN_REPS = 1;
const E1RM_MAX_REPS = 12;

// Baseline = the user's own best e1RM in this many weeks before the period starts.
const BASELINE_WEEKS = 8;

// Progress points = round(% improvement × POINTS_PER_PERCENT), capped per exercise.
const POINTS_PER_PERCENT = 10;
const PROGRESS_CAP = { week: 50, month: 100 };

// An improvement over this many percent in one period is ignored (0 points):
// most likely a typo (2250 for 225) or cheating.
const MAX_PLAUSIBLE_GAIN_PCT = 25;

// Consistency: points per distinct local day with a finished workout, capped.
const POINTS_PER_DAY = 10;
const DAYS_CAP = { week: 4, month: 16 };

const PERIODS = ['week', 'month'];

// Epley estimated 1RM.
function e1rm(weight, reps) {
  return weight * (1 + reps / 30);
}

// Points for one exercise in one period.
//   baseline: best e1RM in the BASELINE_WEEKS before the period (null = none)
//   best:     best e1RM in the period
// status: 'new' (no baseline — this sets it), 'no-gain', 'ignored' (> MAX
// gain), 'capped', 'scored'.
function progressPoints(baseline, best, period) {
  const cap = PROGRESS_CAP[period];
  if (!(baseline > 0)) return { pct: null, points: 0, status: 'new' };
  // Round to 1e-6 % first so float noise (2.4999999) can't move the rounding.
  const pct = Math.round(((best - baseline) / baseline) * 100 * 1e6) / 1e6;
  if (pct <= 0) return { pct, points: 0, status: 'no-gain' };
  if (pct > MAX_PLAUSIBLE_GAIN_PCT) return { pct, points: 0, status: 'ignored' };
  const raw = Math.round(pct * POINTS_PER_PERCENT);
  if (raw > cap) return { pct, points: cap, status: 'capped' };
  return { pct, points: raw, status: 'scored' };
}

function consistencyPoints(days, period) {
  const counted = Math.min(days, DAYS_CAP[period]);
  return { days, countedDays: counted, points: counted * POINTS_PER_DAY };
}

// Competition ranking ("1, 1, 3"): rows must already be sorted best-first;
// rows for which sameAs(prev, row) is true share prev's rank.
function assignRanks(rows, sameAs) {
  rows.forEach((row, i) => {
    row.rank = i > 0 && sameAs(rows[i - 1], row) ? rows[i - 1].rank : i + 1;
  });
  return rows;
}

const round1 = (n) => (n === null || n === undefined ? null : Math.round(n * 10) / 10);

// Build the board for one period.
//   users:  [{ id, username }]  — viewer + accepted friends
//   lifts:  [{ userId, name, baseline, best }]  — best is non-null
//   days:   Map userId -> distinct workout days in the period
function buildBoard({ users, lifts, days, period, viewerId }) {
  const byUser = new Map(users.map(u => [u.id, {
    id: u.id,
    username: u.username,
    isYou: u.id === viewerId,
    total: 0,
    progress: 0,
    consistency: null,
    exercises: [],
  }]));
  for (const l of lifts) {
    const e = byUser.get(l.userId);
    if (!e) continue;
    const p = progressPoints(l.baseline, l.best, period);
    e.progress += p.points;
    e.exercises.push({
      name: l.name,
      baseline: round1(l.baseline),
      best: round1(l.best),
      pct: p.pct === null ? null : Math.round(p.pct * 10) / 10,
      points: p.points,
      status: p.status,
    });
  }
  const entries = [...byUser.values()];
  for (const e of entries) {
    e.consistency = consistencyPoints(days.get(e.id) || 0, period);
    e.total = e.progress + e.consistency.points;
    e.exercises.sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
  }
  entries.sort((a, b) => b.total - a.total || a.username.localeCompare(b.username));
  for (const e of entries) delete e.id;   // user ids are never sent to the client
  return assignRanks(entries, (a, b) => a.total === b.total);
}

module.exports = {
  TIMEZONE, E1RM_MIN_REPS, E1RM_MAX_REPS, BASELINE_WEEKS, POINTS_PER_PERCENT,
  PROGRESS_CAP, MAX_PLAUSIBLE_GAIN_PCT, POINTS_PER_DAY, DAYS_CAP, PERIODS,
  e1rm, progressPoints, consistencyPoints, assignRanks, buildBoard, round1,
};
