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

test('crown guard: top lift needs a second lift within 50%', () => {
  assert.strictEqual(P.CROWN_MAX_JUMP_PCT, 50);
  assert.strictEqual(P.isVerifiedLift(1, 225, null), false);    // only lift
  assert.strictEqual(P.isVerifiedLift(1, 2250, 225), false);    // typo
  assert.strictEqual(P.isVerifiedLift(1, 150, 100), true);      // exactly +50%
  assert.strictEqual(P.isVerifiedLift(1, 150.5, 100), false);   // just over
  assert.strictEqual(P.isVerifiedLift(2, 225, null), true);     // backed by a heavier lift
});

test('strengthStandings: guard, fallback to next lift, ranking and ties', () => {
  const L = (userId, rn, weight, nextWeight, reps, date) =>
    ({ userId, username: 'u' + userId, rn, weight, nextWeight, reps, date });
  const { ranked, unverified } = P.strengthStandings([
    L(1, 1, 2250, 225, 5, '2026-01-02'), L(1, 2, 225, 220, 5, '2026-01-01'),   // typo → 225 counts
    L(2, 1, 230, 220, 3, '2026-01-03'), L(2, 2, 220, 200, 3, '2026-01-03'),
    L(3, 1, 225, 200, 5, '2026-01-01'), L(3, 2, 200, 180, 5, '2026-01-01'),    // ties user 1 exactly
    L(4, 1, 500, null, 1, '2026-01-01'),                                       // single lift: unverified only
  ]);
  assert.deepStrictEqual(ranked.map(r => [r.rank, r.userId, r.weight]), [[1, 2, 230], [2, 1, 225], [2, 3, 225]]);
  assert.deepStrictEqual(unverified.map(r => [r.userId, r.weight]), [[1, 2250], [4, 500]]);
});
