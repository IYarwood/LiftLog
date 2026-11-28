// Pure points math for the weekly/monthly leaderboards (no DB).
const { test } = require('node:test');
const assert = require('node:assert');
const P = require('../src/leaderboard/points');

test('constants match the spec', () => {
  assert.strictEqual(P.TIMEZONE, process.env.LEADERBOARD_TZ || 'America/New_York');
  assert.deepStrictEqual(P.PROGRESS_CAP, { week: 50, month: 100 });
  assert.deepStrictEqual(P.DAYS_CAP, { week: 4, month: 16 });
  assert.strictEqual(P.MAX_PLAUSIBLE_GAIN_PCT, 25);
  assert.strictEqual(P.E1RM_MAX_REPS, 12);
  assert.strictEqual(P.BASELINE_WEEKS, 8);
});

test('e1rm is Epley: weight × (1 + reps/30)', () => {
  assert.strictEqual(P.e1rm(300, 0), 300);
  assert.strictEqual(P.e1rm(150, 30), 300);
  assert.ok(Math.abs(P.e1rm(200, 5) - 233.3333) < 1e-3);
});

test('no baseline → 0 points (first time sets the baseline)', () => {
  assert.deepStrictEqual(P.progressPoints(null, 250, 'week'), { pct: null, points: 0, status: 'new' });
  assert.strictEqual(P.progressPoints(0, 250, 'month').points, 0);
});

test("no baseline but done before the window → 'returning', still 0 points (p-liftlog-4002ce)", () => {
  assert.deepStrictEqual(P.progressPoints(null, 250, 'week', true), { pct: null, points: 0, status: 'returning' });
  assert.deepStrictEqual(P.progressPoints(null, 250, 'week', false), { pct: null, points: 0, status: 'new' });
  // a baseline wins: doneBefore only matters without one
  assert.strictEqual(P.progressPoints(100, 102, 'week', true).status, 'scored');
  const [e] = P.buildBoard({ users: [{ id: 1, username: 'a' }], lifts: [{ userId: 1, name: 'Squat', baseline: null, best: 100, doneBefore: true }], days: new Map(), period: 'week', viewerId: 1 });
  assert.strictEqual(e.exercises[0].status, 'returning');
});

test('+2.5% → 25 points; rounding to nearest point', () => {
  const r = P.progressPoints(P.e1rm(200, 5), P.e1rm(205, 5), 'week');
  assert.strictEqual(r.points, 25);
  assert.strictEqual(r.status, 'scored');
  assert.strictEqual(P.progressPoints(100, 101.04, 'week').points, 10);   // 10.4 → 10
  assert.strictEqual(P.progressPoints(100, 101.06, 'week').points, 11);   // 10.6 → 11
});

test('no improvement or a drop → 0, never negative', () => {
  assert.deepStrictEqual(P.progressPoints(200, 200, 'week'), { pct: 0, points: 0, status: 'no-gain' });
  assert.strictEqual(P.progressPoints(200, 150, 'week').points, 0);
  assert.strictEqual(P.progressPoints(200, 150, 'week').status, 'no-gain');
});

test('caps: 50 per exercise per week, 100 per month', () => {
  // +8% → 80 raw
  assert.deepStrictEqual(P.progressPoints(100, 108, 'week'), { pct: 8, points: 50, status: 'capped' });
  assert.deepStrictEqual(P.progressPoints(100, 108, 'month'), { pct: 8, points: 80, status: 'scored' });
  // +12% → 120 raw
  assert.deepStrictEqual(P.progressPoints(100, 112, 'month'), { pct: 12, points: 100, status: 'capped' });
  // exactly at the cap is "scored"
  assert.deepStrictEqual(P.progressPoints(100, 105, 'week'), { pct: 5, points: 50, status: 'scored' });
});

test('25% guard: > 25% ignored, exactly 25% still counts (capped)', () => {
  assert.deepStrictEqual(P.progressPoints(100, 125.5, 'month'), { pct: 25.5, points: 0, status: 'ignored' });
  assert.deepStrictEqual(P.progressPoints(100, 125, 'month'), { pct: 25, points: 100, status: 'capped' });
  assert.strictEqual(P.progressPoints(200, 2250, 'week').points, 0);   // typo 2250 for 225
});

test('consistency: 10/day, capped at 4 days/week and 16 days/month', () => {
  assert.deepStrictEqual(P.consistencyPoints(0, 'week'), { days: 0, countedDays: 0, points: 0 });
  assert.deepStrictEqual(P.consistencyPoints(3, 'week'), { days: 3, countedDays: 3, points: 30 });
  assert.deepStrictEqual(P.consistencyPoints(6, 'week'), { days: 6, countedDays: 4, points: 40 });
  assert.deepStrictEqual(P.consistencyPoints(12, 'month'), { days: 12, countedDays: 12, points: 120 });
  assert.deepStrictEqual(P.consistencyPoints(22, 'month'), { days: 22, countedDays: 16, points: 160 });
});

test('assignRanks: ties share a rank (1, 1, 3)', () => {
  const rows = [{ v: 9 }, { v: 9 }, { v: 5 }, { v: 5 }, { v: 1 }];
  P.assignRanks(rows, (a, b) => a.v === b.v);
  assert.deepStrictEqual(rows.map(r => r.rank), [1, 1, 3, 3, 5]);
});

test('buildBoard: totals, ordering, ties, viewer flag, no user ids leaked', () => {
  const users = [{ id: 1, username: 'zed' }, { id: 2, username: 'amy' }, { id: 3, username: 'bo' }];
  const lifts = [
    { userId: 1, name: 'Squat', baseline: 100, best: 102.5 },   // 25
    { userId: 1, name: 'Bench', baseline: null, best: 100 },    // new, 0
    { userId: 2, name: 'Squat', baseline: 100, best: 101.5 },   // 15
  ];
  const days = new Map([[1, 1], [2, 2], [3, 0]]);
  const board = P.buildBoard({ users, lifts, days, period: 'week', viewerId: 2 });
  assert.deepStrictEqual(board.map(e => [e.rank, e.username, e.total, e.isYou]),
    [[1, 'amy', 35, true], [1, 'zed', 35, false], [3, 'bo', 0, false]]);
  assert.ok(board.every(e => !('id' in e)));
  const zed = board.find(e => e.username === 'zed');
  assert.deepStrictEqual(zed.exercises.map(x => [x.name, x.points, x.status]), [['Squat', 25, 'scored'], ['Bench', 0, 'new']]);
  assert.deepStrictEqual(zed.consistency, { days: 1, countedDays: 1, points: 10 });
});

test("crown guard: a workout's best needs ANOTHER workout within 50% (either way)", () => {
  assert.strictEqual(P.CROWN_MAX_JUMP_PCT, 50);
  assert.strictEqual(P.isVerifiedLift(225, []), false);           // only one workout
  assert.strictEqual(P.isVerifiedLift(2250, [225]), false);       // typo
  assert.strictEqual(P.isVerifiedLift(150, [100]), true);         // exactly +50%
  assert.strictEqual(P.isVerifiedLift(150.5, [100]), false);      // just over
  assert.strictEqual(P.isVerifiedLift(2250, [9999, 225]), false); // a heavier outlier doesn't vouch
  assert.strictEqual(P.isVerifiedLift(225, [9999, 2250, 220]), true);
  assert.strictEqual(P.withinCrownJump(100, 150), true);
  assert.strictEqual(P.withinCrownJump(150, 100), true);
});

// One row per (user, workout): that workout's best lift.
const W = (userId, sessionId, weight, reps, date) =>
  ({ userId, username: 'u' + userId, sessionId, weight, reps, date });

test('crown guard: repeated typo sets in ONE workout stay unverified', () => {
  // 2250×5 typed for all 3 sets collapses to one per-workout best: nothing else backs it
  const { ranked, unverified } = P.strengthStandings([W(1, 's1', 2250, 5, '2026-01-02')]);
  assert.deepStrictEqual(ranked, []);
  assert.deepStrictEqual(unverified.map(r => [r.userId, r.weight]), [[1, 2250]]);
});

test('crown guard: two workouts agreeing → verified (and a single-workout user is not)', () => {
  const { ranked, unverified } = P.strengthStandings([
    W(1, 'a', 300, 3, '2026-01-01'), W(1, 'b', 290, 3, '2026-01-08'),   // backed
    W(2, 'c', 400, 1, '2026-01-02'),                                    // one workout only
  ]);
  assert.deepStrictEqual(ranked.map(r => [r.rank, r.userId, r.weight]), [[1, 1, 300]]);
  assert.deepStrictEqual(unverified.map(r => [r.userId, r.weight]), [[2, 400]]);
});

test('crown guard: 9999 / 2250 typos with real 225s → the 225 holds', () => {
  const { ranked, unverified } = P.strengthStandings([
    W(1, 'a', 9999, 5, '2026-01-03'), W(1, 'b', 2250, 5, '2026-01-02'),
    W(1, 'c', 225, 5, '2026-01-01'), W(1, 'd', 225, 3, '2026-01-04'),
    W(2, 'e', 230, 5, '2026-01-01'), W(2, 'f', 160, 5, '2026-01-01'),
  ]);
  assert.deepStrictEqual(ranked.map(r => [r.rank, r.userId, r.weight, r.reps, r.sessionId]),
    [[1, 2, 230, 5, 'e'], [2, 1, 225, 5, 'c']]);
  assert.deepStrictEqual(unverified.map(r => [r.userId, r.weight]), [[1, 9999], [1, 2250]]);
});

test('crown guard: ties share a rank; earlier wins on equal weight × reps', () => {
  const { ranked } = P.strengthStandings([
    W(1, 'a', 225, 5, '2026-01-01'), W(1, 'b', 220, 5, '2026-01-05'),
    W(2, 'c', 225, 5, '2026-01-01'), W(2, 'd', 200, 5, '2026-01-05'),   // exact tie with user 1
    W(3, 'e', 225, 5, '2026-01-02'), W(3, 'f', 225, 5, '2026-01-03'),   // same lift, done later
    W(4, 'g', 225, 6, '2026-01-09'), W(4, 'h', 200, 6, '2026-01-09'),   // more reps wins
  ]);
  assert.deepStrictEqual(ranked.map(r => [r.rank, r.userId]), [[1, 4], [2, 1], [2, 2], [4, 3]]);
});

test('total progress cap: 150/week, 400/month; consistency is separate', () => {
  assert.deepStrictEqual(P.PROGRESS_TOTAL_CAP, { week: 150, month: 400 });
  const users = [{ id: 1, username: 'a' }, { id: 2, username: 'b' }];
  // user 1: four exercises at +10% → 4 × capped 50 = 200 raw (week) / 4 × 100 = 400 (month)
  const lifts = ['A', 'B', 'C', 'D'].map(name => ({ userId: 1, name, baseline: 100, best: 110 }))
    .concat([{ userId: 2, name: 'A', baseline: 100, best: 103 }]);          // 30
  const days = new Map([[1, 6], [2, 1]]);
  const wk = P.buildBoard({ users, lifts, days, period: 'week', viewerId: 1 });
  const a = wk.find(e => e.username === 'a');
  assert.deepStrictEqual([a.progressRaw, a.progress, a.progressCapped, a.consistency.points, a.total],
    [200, 150, true, 40, 190]);
  const b = wk.find(e => e.username === 'b');
  assert.deepStrictEqual([b.progressRaw, b.progress, b.progressCapped, b.total], [30, 30, false, 40]);

  // month: 400 raw is exactly the cap → not marked capped
  const mo = P.buildBoard({ users, lifts, days, period: 'month', viewerId: 1 });
  const am = mo.find(e => e.username === 'a');
  assert.deepStrictEqual([am.progressRaw, am.progress, am.progressCapped], [400, 400, false]);
  // five of them → 500 raw → 400
  const five = lifts.concat([{ userId: 1, name: 'E', baseline: 100, best: 110 }]);
  const am5 = P.buildBoard({ users, lifts: five, days, period: 'month', viewerId: 1 }).find(e => e.username === 'a');
  assert.deepStrictEqual([am5.progressRaw, am5.progress, am5.progressCapped, am5.total], [500, 400, true, 460]);
});
