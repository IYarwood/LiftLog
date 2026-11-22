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
// ...and all of a user's progress points together are capped per period.
// Consistency points are separate (they have their own DAYS_CAP).
const PROGRESS_TOTAL_CAP = { week: 150, month: 400 };

// An improvement over this many percent in one period is ignored (0 points):
// most likely a typo (2250 for 225) or cheating.
const MAX_PLAUSIBLE_GAIN_PCT = 25;

// Consistency: points per distinct local day with a finished workout, capped.
const POINTS_PER_DAY = 10;
const DAYS_CAP = { week: 4, month: 16 };

const PERIODS = ['week', 'month'];

// Strength crown guard: a user's top lift for an exercise can't take or hold
// the crown while it is more than this many percent heavier than their
// next-best lift of that exercise (a typo like 2250 for 225). It counts as soon
// as they log a second lift within this margin of it.
const CROWN_MAX_JUMP_PCT = 50;

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

// Is a user's rn-th best lift (1 = their top) verified? `weight` is its weight,
// `nextWeight` that of the lift just below it (null if none). Anything below the
// top is backed by a heavier lift, so only the top can be unverified.
function isVerifiedLift(rn, weight, nextWeight) {
  if (rn > 1) return true;
  if (nextWeight === null || nextWeight === undefined) return false;
  return weight <= nextWeight * (1 + CROWN_MAX_JUMP_PCT / 100) + 1e-9;
}

// Strength order: heavier → more reps at that weight → done first → name.
function compareLifts(a, b) {
  return b.weight - a.weight || b.reps - a.reps ||
    new Date(a.date) - new Date(b.date) || a.username.localeCompare(b.username);
}

// rows: each user's top 2 lifts for ONE exercise, as
//   { userId, username, rn, weight, nextWeight, reps, date, ... }.
// Returns { ranked, unverified }: ranked = each user's best VERIFIED lift in
// crown order (with ranks); unverified = top lifts that fail the guard.
function strengthStandings(rows) {
  const byUser = new Map();
  for (const r of rows) {
    if (!byUser.has(r.userId)) byUser.set(r.userId, []);
    byUser.get(r.userId).push(r);
  }
  const ranked = [], unverified = [];
  for (const lifts of byUser.values()) {
    lifts.sort((a, b) => a.rn - b.rn);
    const best = lifts.find(l => isVerifiedLift(l.rn, l.weight, l.nextWeight));
    if (best) ranked.push(best);
    if (lifts[0] !== best) unverified.push(lifts[0]);
  }
  ranked.sort(compareLifts);
  unverified.sort(compareLifts);
  const same = (a, b) => a.weight === b.weight && a.reps === b.reps && +new Date(a.date) === +new Date(b.date);
  return { ranked: assignRanks(ranked, same), unverified };
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
    // progressRaw = sum over exercises; progress = after the per-period total cap
    e.progressRaw = e.progress;
    e.progress = Math.min(e.progressRaw, PROGRESS_TOTAL_CAP[period]);
    e.progressCapped = e.progressRaw > e.progress;
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
  PROGRESS_CAP, PROGRESS_TOTAL_CAP, MAX_PLAUSIBLE_GAIN_PCT, POINTS_PER_DAY, DAYS_CAP, PERIODS, CROWN_MAX_JUMP_PCT,
  e1rm, progressPoints, consistencyPoints, assignRanks, buildBoard, round1,
  isVerifiedLift, strengthStandings,
};
