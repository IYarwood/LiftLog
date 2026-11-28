// "Share workout as image": the pure parts of frontend/js/shareCard.js —
// best set / PR picking, the caption, and the card layout (no clipping,
// long workouts grow the image instead).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.resolve(__dirname, '../../frontend/js/shareCard.js')).href);
const html = fs.readFileSync(path.resolve(__dirname, '../../frontend/index.html'), 'utf8');

const NOW = new Date('2026-11-28T12:00:00');
let n = 0;
const sets = (...pairs) => pairs.map(([weight, reps]) => ({ id: 's' + (++n), weight, reps, savedAt: 'x' }));
const sess = (id, startedAt, exercises) => ({
  id, startedAt, finishedAt: new Date(new Date(startedAt).getTime() + 72 * 60000).toISOString(),
  exercises: exercises.map(([name, s], i) => ({ id: id + i, name, sets: s })),
});

// The designer's mockup workout (Sat, Nov 21), plus earlier history.
const today = sess('w', '2026-11-21T18:02:00', [
  ['Bench Press', sets([135, 8], [185, 5], [195, 5], [205, 5], [205, 4])],
  ['Incline DB Press', sets([60, 10], [65, 10], [65, 9], [65, 8])],
  ['Overhead Press', sets([95, 8], [105, 6], [105, 6], [110, 4])],
]);
const history = [
  today,
  sess('old1', '2026-11-14T18:00:00', [['bench press', sets([200, 3])], ['Incline DB Press', sets([70, 6])]]),
  sess('old2', '2026-11-07T18:00:00', [['Overhead Press', sets([110, 5])]]),
  // a LATER workout must not count against this one's PRs
  sess('later', '2026-11-25T18:00:00', [['Bench Press', sets([225, 1])]]),
];

test('best set = highest estimated 1RM; first wins a tie', async () => {
  const { bestSetIndex } = await load();
  assert.strictEqual(bestSetIndex([{ weight: 60, reps: 10 }, { weight: 65, reps: 10 }, { weight: 65, reps: 9 }]), 1);
  assert.strictEqual(bestSetIndex([{ weight: 105, reps: 6 }, { weight: 105, reps: 6 }]), 0);
  // 95×8 (e1RM 120.3) beats 110×1 (113.7)
  assert.strictEqual(bestSetIndex([{ weight: 110, reps: 1 }, { weight: 95, reps: 8 }]), 1);
  // bodyweight work: most reps
  assert.strictEqual(bestSetIndex([{ weight: 0, reps: 8 }, { weight: 0, reps: 12 }]), 1);
  assert.strictEqual(bestSetIndex([]), -1);
});

test('PR = heaviest set beating every EARLIER workout, names matched ignoring case', async () => {
  const { buildShareModel, priorMaxWeight } = await load();
  assert.strictEqual(priorMaxWeight('Bench Press', today, history), 200);   // "bench press" counts, "later" doesn't
  const m = buildShareModel(today, history, 'alex_lifts', NOW);
  const [bench, incline, ohp] = m.exercises;
  assert.strictEqual(bench.pr, 3);       // 205×5, not 205×4
  assert.strictEqual(incline.pr, -1);    // 65 < earlier 70
  assert.strictEqual(ohp.pr, -1);        // 110 ties earlier 110: not a record
  assert.strictEqual(incline.best, 1);   // 65×10
});

test('an exercise done for the first time is not a PR', async () => {
  const { buildShareModel } = await load();
  const m = buildShareModel(today, [today], 'u', NOW);
  assert.ok(m.exercises.every(e => e.pr === -1));
});

test('model: blank sets and empty exercises are dropped; totals and dates', async () => {
  const { buildShareModel, hasShareableSets } = await load();
  const s = sess('b', '2026-11-21T18:02:00', [
    ['Squat', [{ weight: '225.00', reps: 5 }, { weight: null, reps: null }]],
    ['Empty', [{ weight: null, reps: null }]],
  ]);
  const m = buildShareModel(s, [s], 'me', NOW);
  assert.deepStrictEqual(m.exercises.map(e => e.name), ['Squat']);
  assert.deepStrictEqual(m.exercises[0].sets, [{ weight: 225, reps: 5 }]);
  assert.strictEqual(m.setCount, 1);
  assert.strictEqual(m.volume, 1125);
  assert.strictEqual(m.dateLong, 'Saturday, Nov 21');
  assert.strictEqual(m.dateShort, 'Sat, Nov 21');
  assert.strictEqual(m.duration, '1 h 12 min');
  assert.strictEqual(hasShareableSets(s), true);
  assert.strictEqual(hasShareableSets(sess('e', '2026-11-21T18:02:00', [['X', [{ weight: null, reps: null }]]])), false);
  // a different year shows the year
  assert.strictEqual(buildShareModel(sess('y', '2025-03-02T10:00:00', []), [], 'me', NOW).dateShort, 'Sun, Mar 2, 2025');
});

test('caption: date · sets · the PR (or how many)', async () => {
  const { buildShareModel, shareCaption } = await load();
  assert.strictEqual(shareCaption(buildShareModel(today, history, 'u', NOW)), 'Sat, Nov 21 · 13 sets · new Bench Press PR 205×5');
  assert.strictEqual(shareCaption(buildShareModel(today, [today], 'u', NOW)), 'Sat, Nov 21 · 13 sets');
  const two = [...history, sess('old3', '2026-11-01T18:00:00', [['Incline DB Press', sets([50, 10])]])]
    .map(s => s.id === 'old1' ? sess('old1', s.startedAt, [['Bench Press', sets([200, 3])]]) : s);
  assert.strictEqual(shareCaption(buildShareModel(today, two, 'u', NOW)), 'Sat, Nov 21 · 13 sets · 2 new PRs');
  const one = sess('o', '2026-11-21T18:02:00', [['Squat', sets([225, 5])]]);
  assert.match(shareCaption(buildShareModel(one, [one], 'u', NOW)), / · 1 set$/);
});

test('fmtWeight / fmtDuration / file name', async () => {
  const { fmtWeight, fmtDuration, shareFileName } = await load();
  assert.strictEqual(fmtWeight(22.5), '22.5');
  assert.strictEqual(fmtWeight(135), '135');
  assert.strictEqual(fmtWeight(0), 'BW');
  assert.strictEqual(fmtDuration('2026-11-21T18:00:00Z', '2026-11-21T18:48:00Z'), '48 min');
  assert.strictEqual(fmtDuration('2026-11-21T18:00:00Z', '2026-11-21T20:00:00Z'), '2 h');
  assert.strictEqual(fmtDuration('2026-11-21T18:00:00Z', null), '');
  assert.strictEqual(shareFileName({ startedAt: '2026-11-21T18:02:00' }), 'liftlog-2026-11-21.png');
});

// Rough text metrics: condensed display face ~0.45em/char, mono 0.6em/char.
const measure = (t, font, spacing = 0) => {
  const px = Number(/([\d.]+)px/.exec(font)[1]);
  return [...String(t)].length * px * (/Mono/.test(font) ? 0.6 : 0.45) + spacing * [...String(t)].length;
};
const inBounds = (layout) => layout.items.filter(i => i.kind === 'text').every(i =>
  i.left >= 66 - 0.5 && i.left + i.w <= layout.width - 66 + 0.5 && i.y > 0 && i.y <= layout.height);

test('layout: a normal workout is exactly 1080×1350 and nothing leaves the card', async () => {
  const { buildShareModel, layoutCard } = await load();
  const l = layoutCard(buildShareModel(today, history, 'alex_lifts', NOW), measure);
  assert.strictEqual(l.width, 1080);
  assert.strictEqual(l.height, 1350);
  assert.ok(inBounds(l));
  const texts = l.items.filter(i => i.kind === 'text').map(i => i.text);
  for (const t of ['LIFTLOG', '@alex_lifts', 'Saturday, Nov 21', 'best set', 'personal record', 'PR', '205', '×5']) {
    assert.ok(texts.includes(t), t);
  }
  assert.ok(texts.includes('1 h 12 min, 13 sets, 9,640 lb lifted'));
  // PR set amber, best set mint
  const amber = l.items.filter(i => i.kind === 'text' && i.color === '#f0a030').map(i => i.text);
  assert.deepStrictEqual(amber, ['205']);
});

test('layout: a long workout (12 exercises × 8 sets, long names) grows taller and wraps sets 5 per line', async () => {
  const { buildShareModel, layoutCard, SETS_PER_LINE } = await load();
  const exs = Array.from({ length: 12 }, (_, i) => [
    i === 0 ? 'Single Arm Cable Rear Delt Fly With A Very Long Name Indeed' : i === 1 ? 'Supercalifragilisticexpialidociousdeadlift' : `Exercise ${i}`,
    sets(...Array.from({ length: 8 }, (_, k) => [100 + k * 5 + (i === 2 ? 1000 : 0), 10])),
  ]);
  const long = sess('L', '2026-11-21T18:02:00', exs);
  const l = layoutCard(buildShareModel(long, [long], 'a_really_long_username_here', NOW), measure);
  assert.strictEqual(l.width, 1080);
  assert.ok(l.height > 1350, `height ${l.height}`);
  assert.ok(inBounds(l));
  // every row's sets fit in the 570px set area: centres in at most SETS_PER_LINE columns
  const weightXs = new Set(l.items.filter(i => i.kind === 'text' && /^\d/.test(i.text) && /Barlow/.test(i.font) && i.font.startsWith('600')).map(i => i.x));
  assert.strictEqual(weightXs.size, SETS_PER_LINE);
  // the key is the last thing, below every row
  const key = l.items.find(i => i.text === 'personal record');
  assert.ok(l.items.filter(i => i.kind === 'line').every(i => i.y < key.y - 27));
});

test('index.html: share button next to edit, after finishing, and font loading', async () => {
  assert.match(html, /<button class="mini-btn accent" onclick="shareWorkout\(/);
  assert.match(html, /justFinishedId = sess\.id/);
  assert.match(html, /err\.name === 'AbortError'\) return true/);
  assert.doesNotMatch(html, /fonts\.googleapis/);
  assert.match(html, /css\/fonts\.css\?v=dev/);
});
