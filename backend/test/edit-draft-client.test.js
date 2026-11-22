// Editing a FINISHED workout: nothing is autosaved; typed values stay in a local
// draft (frontend/js/editDraft.js) and only "done" sends the changed fields.
// Live workouts keep their autosave (frontend/js/saveQueue.js, unchanged).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.resolve(__dirname, '../../frontend/js/editDraft.js')).href);
const html = fs.readFileSync(path.resolve(__dirname, '../../frontend/index.html'), 'utf8');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// The stored workout (server values): Bench 5×190, 5×195; Row 8×140
const stored = () => ({
  id: 'w', exercises: [
    { id: 'bench', name: 'Bench Press', sets: [{ id: 'b1', reps: 5, weight: 190 }, { id: 'b2', reps: 5, weight: 195 }] },
    { id: 'row', name: 'Barbell Row', sets: [{ id: 'r1', reps: 8, weight: 140 }] },
  ],
});
const set = (w, id) => w.exercises.flatMap(e => e.sets).find(s => s.id === id);

test('makeDraft copies sets: typing into the draft never touches the stored copy', async () => {
  const { makeDraft } = await load();
  const orig = stored();
  const d = makeDraft(orig);
  set(d, 'b1').weight = '100';
  d.exercises[0].sets.push({ id: 'x' });
  assert.strictEqual(set(orig, 'b1').weight, 190);
  assert.strictEqual(orig.exercises[0].sets.length, 2);
});

test('no changes → nothing to send', async () => {
  const { makeDraft, draftChanges, hasDraftChanges } = await load();
  const d = makeDraft(stored());
  set(d, 'b1').weight = '190';      // inputs hold strings; same value
  set(d, 'b2').weight = '195.00';
  assert.deepStrictEqual(draftChanges(stored(), d), { patches: [], invalid: [] });
  assert.strictEqual(hasDraftChanges(stored(), d), false);
});

test('done sends only the changed fields, one patch per changed set', async () => {
  const { makeDraft, draftChanges } = await load();
  const d = makeDraft(stored());
  set(d, 'b1').weight = '192.5';                 // weight only
  set(d, 'r1').reps = '10'; set(d, 'r1').weight = '145';
  assert.deepStrictEqual(draftChanges(stored(), d), {
    patches: [
      { exId: 'bench', setId: 'b1', fields: { weight: 192.5 } },
      { exId: 'row', setId: 'r1', fields: { reps: 10, weight: 145 } },
    ],
    invalid: [],
  });
});

test('the 190 → 1-0-0 (pause) → 00 case: nothing is sent while typing, and 10000 blocks done', async () => {
  const { makeDraft, draftChanges, hasDraftChanges } = await load();
  const d = makeDraft(stored());
  for (const v of ['', '1', '10', '100']) set(d, 'b1').weight = v;
  await sleep(700);                                 // longer than the old 600ms autosave
  for (const v of ['1000', '10000']) set(d, 'b1').weight = v;
  const { patches, invalid } = draftChanges(stored(), d);
  assert.deepStrictEqual(patches, []);
  assert.deepStrictEqual(invalid.map(i => i.setId), ['b1']);
  assert.match(invalid[0].message, /Weight must be/);
  assert.strictEqual(hasDraftChanges(stored(), d), true);   // leaving asks before discarding
});

test('invalid values block done (reps 2.5 / weight 10000 / negative / text)', async () => {
  const { makeDraft, draftChanges } = await load();
  for (const [f, v] of [['reps', '2.5'], ['weight', '10000'], ['reps', '-1'], ['weight', 'abc']]) {
    const d = makeDraft(stored());
    set(d, 'b2')[f] = v;
    set(d, 'b1').reps = '6';                  // a valid change elsewhere is not sent either
    const r = draftChanges(stored(), d);
    assert.deepStrictEqual(r.invalid.map(i => i.setId), ['b2'], `${f}=${v}`);
  }
});

test('blanking a stored value blocks done (fix it or delete the set); a new blank set is fine', async () => {
  const { makeDraft, draftChanges } = await load();
  const d = makeDraft(stored());
  set(d, 'b1').reps = '';
  let r = draftChanges(stored(), d);
  assert.deepStrictEqual(r.invalid, [{ exId: 'bench', setId: 'b1', message: 'Enter a value or delete the set.' }]);

  // A set added in edit mode is stored as blanks: left blank → nothing; filled → sent.
  const orig = stored(); orig.exercises[0].sets.push({ id: 'n', reps: null, weight: null });
  const d2 = makeDraft(orig);
  set(d2, 'n').reps = ''; set(d2, 'n').weight = '';
  assert.deepStrictEqual(draftChanges(orig, d2), { patches: [], invalid: [] });
  set(d2, 'n').reps = '3'; set(d2, 'n').weight = '200';
  r = draftChanges(orig, d2);
  assert.deepStrictEqual(r.patches, [{ exId: 'bench', setId: 'n', fields: { reps: 3, weight: 200 } }]);
});

// ── index.html wiring: edit mode can't send on typing or on leaving ─────────
function fnBody(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  let i = html.indexOf(') {', start) + 2, depth = 0;   // body brace, not a default param's {}
  for (let j = i; j < html.length; j++) {
    if (html[j] === '{') depth++;
    if (html[j] === '}' && --depth === 0) return html.slice(i, j + 1);
  }
  throw new Error('unbalanced');
}

test('typing in edit mode only changes the draft (no PATCH, no queue)', () => {
  const body = fnBody('editSetField');
  assert.doesNotMatch(body, /PATCH|POST|schedule|flush|Saves\./);
  assert.match(body, /editDraft/);
});

test('leaving edit mode discards the draft (confirm if changed) and sends nothing', () => {
  const show = fnBody('showView');
  const leave = show.slice(show.indexOf("currentView === 'session-detail'"), show.indexOf("document.querySelectorAll('.view')"));
  assert.match(leave, /hasDraftChanges/);
  assert.match(leave, /confirm\(/);
  assert.match(leave, /stopEditing\(\)/);
  assert.doesNotMatch(leave, /PATCH|flush|refresh/);
  assert.doesNotMatch(fnBody('stopEditing'), /PATCH|flush/);
  assert.doesNotMatch(html, /editSaves/);    // the edit-mode autosave queue is gone
});

test('done is the only place edit-mode field changes are sent, and only after validation', () => {
  const done = fnBody('doneEditing');
  assert.ok(done.indexOf('draftChanges(') < done.indexOf('PATCH('), 'validates before sending');
  assert.match(done, /if \(invalid\.length\)[\s\S]*?return;/);
  assert.match(done, /pch\.fields/);
});

test('live workouts still autosave through the queue (PR #10 unchanged)', () => {
  assert.match(fnBody('updateSetField'), /setSaves\.schedule\(setId, \{ sessionId: active\.id, exId, setId \}, \{ \[field\]: fieldSaveValue\(field, val\) \}\)/);
});
