// Unit tests for the frontend's debounced set-save queue
// (frontend/js/saveQueue.js, a browser ES module with no dependencies).
const { test, mock, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.resolve(__dirname, '../../frontend/js/saveQueue.js')).href);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
afterEach(() => mock.restoreAll());

function recorder({ failTimes = 0 } = {}) {
  const sent = [];
  let failures = failTimes;
  const send = async (target, fields) => {
    if (failures > 0) { failures--; throw new Error('offline'); }
    sent.push({ target, fields });
  };
  return { sent, send };
}

test('a scheduled edit is sent once after the delay', async () => {
  const { createSaveQueue } = await load();
  const { sent, send } = recorder();
  const q = createSaveQueue(send, 20);
  q.schedule('s1', { sessionId: 'A', exId: 'e', setId: 's1' }, { reps: '5' });
  assert.strictEqual(sent.length, 0);
  await sleep(50);
  assert.deepStrictEqual(sent, [{ target: { sessionId: 'A', exId: 'e', setId: 's1' }, fields: { reps: '5' } }]);
  assert.strictEqual(q.size, 0);
});

test('edits to one set within the delay are merged, not lost', async () => {
  const { createSaveQueue } = await load();
  const { sent, send } = recorder();
  const q = createSaveQueue(send, 20);
  q.schedule('s1', { sessionId: 'A' }, { reps: '5' });
  q.schedule('s1', { sessionId: 'A' }, { weight: '225' });
  q.schedule('s1', { sessionId: 'A' }, { weight: '225.5' });
  await sleep(50);
  assert.deepStrictEqual(sent.map(x => x.fields), [{ reps: '5', weight: '225.5' }]);
});

test('flushAll sends pending edits immediately, awaits them, and the timer does not resend', async () => {
  const { createSaveQueue } = await load();
  const { sent, send } = recorder();
  const q = createSaveQueue(send, 600);
  q.schedule('s1', { sessionId: 'A' }, { reps: '8' });
  q.schedule('s2', { sessionId: 'A' }, { weight: '100' });
  assert.strictEqual(await q.flushAll(), true);
  assert.strictEqual(sent.length, 2);         // already done when flushAll resolves
  await sleep(20);
  assert.strictEqual(sent.length, 2);
  assert.strictEqual(q.size, 0);
});

// The FINISH data-loss bug: the save used to read the global `active` when the
// timer fired, which FINISH had set to null by then.
test('the target is captured at schedule time, so later app-state changes do not matter', async () => {
  const { createSaveQueue } = await load();
  const { sent, send } = recorder();
  const q = createSaveQueue(send, 20);
  let active = { id: 'sess1' };
  q.schedule('s1', { sessionId: active.id, exId: 'e', setId: 's1' }, { reps: '5' });
  active = null;   // FINISH
  await q.flushAll();
  assert.strictEqual(active, null);
  assert.strictEqual(sent[0].target.sessionId, 'sess1');
});

test('a failed send reports false and keeps the edit for the next flush', async () => {
  const { createSaveQueue } = await load();
  mock.method(console, 'error', () => {});
  const { sent, send } = recorder({ failTimes: 1 });
  const q = createSaveQueue(send, 600);
  q.schedule('s1', { sessionId: 'A' }, { reps: '5' });
  assert.strictEqual(await q.flushAll(), false);
  assert.deepStrictEqual(q.pendingFields('s1'), { reps: '5' });
  assert.strictEqual(await q.flushAll(), true);
  assert.deepStrictEqual(sent.map(x => x.fields), [{ reps: '5' }]);
});

test('an edit made while a failing send is in flight is merged into the retry', async () => {
  const { createSaveQueue } = await load();
  mock.method(console, 'error', () => {});
  const { sent, send } = recorder({ failTimes: 1 });
  const q = createSaveQueue(send, 600);
  q.schedule('s1', { sessionId: 'A' }, { reps: '5' });
  const flushing = q.flushAll();
  q.schedule('s1', { sessionId: 'A' }, { weight: '135' });
  assert.strictEqual(await flushing, false);
  assert.deepStrictEqual(q.pendingFields('s1'), { reps: '5', weight: '135' });
  assert.strictEqual(await q.flushAll(), true);
  assert.deepStrictEqual(sent.map(x => x.fields), [{ reps: '5', weight: '135' }]);
});

test('drop cancels a pending save', async () => {
  const { createSaveQueue } = await load();
  const { sent, send } = recorder();
  const q = createSaveQueue(send, 20);
  q.schedule('s1', { sessionId: 'A' }, { reps: '5' });
  q.drop('s1');
  await sleep(50);
  assert.strictEqual(await q.flushAll(), true);
  assert.strictEqual(sent.length, 0);
  assert.strictEqual(q.pendingFields('s1'), null);
});

// ─── Permanent failures must never block FINISH ───────────────────────────────
const httpErr = (status) => Object.assign(new Error('HTTP ' + status), { status });

test('a 4xx is reported once and NOT retried; flushAll succeeds', async () => {
  const { createSaveQueue } = await load();
  const rejected = [];
  let calls = 0;
  const q = createSaveQueue(async () => { calls++; throw httpErr(400); }, 600,
    { onRejected: (t, f, err) => rejected.push([t.setId, f, err.status]) });
  q.schedule('s1', { setId: 's1' }, { weight: '12345' });
  assert.strictEqual(await q.flushAll(), true);
  assert.strictEqual(await q.flushAll(), true);
  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(rejected, [['s1', { weight: '12345' }, 400]]);
  assert.strictEqual(q.size, 0);
});

// Tester's case: exercise deleted from another tab while an edit is pending.
// This tab still shows it, so the save is attempted and gets a 404.
test('exercise deleted in another tab: the 404 is dropped and FINISH can proceed', async () => {
  const { createSaveQueue } = await load();
  let calls = 0;
  const q = createSaveQueue(async () => { calls++; throw httpErr(404); }, 600, { onRejected: () => {} });
  q.schedule('s1', { sessionId: 'A', exId: 'gone', setId: 's1' }, { reps: '5' });
  for (let tap = 0; tap < 3; tap++) assert.strictEqual(await q.flushAll(), true);   // every FINISH tap
  assert.strictEqual(calls, 1);
});

test('5xx / network errors are still retried', async () => {
  const { createSaveQueue } = await load();
  mock.method(console, 'error', () => {});
  let fail = true;
  const q = createSaveQueue(async () => { if (fail) throw httpErr(503); }, 600);
  q.schedule('s1', { setId: 's1' }, { reps: '5' });
  assert.strictEqual(await q.flushAll(), false);
  fail = false;
  assert.strictEqual(await q.flushAll(), true);
});

test('drop() while a send is in flight: its failure is not requeued (removed exercise)', async () => {
  const { createSaveQueue } = await load();
  mock.method(console, 'error', () => {});
  let rejectSend;
  const q = createSaveQueue(() => new Promise((_, rej) => { rejectSend = rej; }), 600);
  q.schedule('s1', { setId: 's1' }, { reps: '5' });
  const flushing = q.flushAll();
  await sleep(5);
  q.drop('s1');                         // user tapped × on the exercise
  rejectSend(new Error('network'));     // even a retryable failure
  assert.strictEqual(await flushing, true);
  assert.strictEqual(q.size, 0);
});

test('dropWhere removes saves whose target no longer exists', async () => {
  const { createSaveQueue } = await load();
  const { sent, send } = recorder();
  const q = createSaveQueue(send, 600);
  q.schedule('s1', { exId: 'keep', setId: 's1' }, { reps: '1' });
  q.schedule('s2', { exId: 'gone', setId: 's2' }, { reps: '2' });
  assert.strictEqual(q.dropWhere(t => t.exId === 'gone'), 1);
  await q.flushAll();
  assert.deepStrictEqual(sent.map(x => x.target.setId), ['s1']);
});

// ─── In-flight sends (review round 3) ─────────────────────────────────────────
test('flushAll waits for a send the timer already started', async () => {
  const { createSaveQueue } = await load();
  let landed = false;
  const q = createSaveQueue(async () => { await sleep(60); landed = true; }, 5);
  q.schedule('s1', { setId: 's1' }, { reps: '5' });
  await sleep(20);                        // timer fired; nothing pending, send in flight
  assert.strictEqual(q.size, 0);
  assert.strictEqual(await q.flushAll(), true);
  assert.strictEqual(landed, true);       // FINISH / reload only proceed after it landed
});

test('flushAll reports an in-flight send that fails, and keeps it for retry', async () => {
  const { createSaveQueue } = await load();
  mock.method(console, 'error', () => {});
  let fail = true;
  const q = createSaveQueue(async () => { await sleep(40); if (fail) throw new Error('offline'); }, 5);
  q.schedule('s1', { setId: 's1' }, { reps: '5' });
  await sleep(15);                        // in flight
  assert.strictEqual(await q.flushAll(), false);
  assert.deepStrictEqual(q.pendingFields('s1'), { reps: '5' });
  fail = false;
  assert.strictEqual(await q.flushAll(), true);
});

test('sends for one set run in order: a slow older send cannot land after a newer one', async () => {
  const { createSaveQueue } = await load();
  const server = [];
  const q = createSaveQueue(async (t, f) => { await sleep(f.reps === '5' ? 60 : 5); server.push(f.reps); }, 5);
  q.schedule('s1', { setId: 's1' }, { reps: '5' });
  await sleep(15);                        // reps=5 in flight (slow)
  q.schedule('s1', { setId: 's1' }, { reps: '55' });
  assert.strictEqual(await q.flushAll(), true);
  assert.deepStrictEqual(server, ['5', '55']);   // final server value is the newest
});

test('different sets are sent in parallel', async () => {
  const { createSaveQueue } = await load();
  const q = createSaveQueue(async () => { await sleep(50); }, 600);
  q.schedule('a', { setId: 'a' }, { reps: '1' });
  q.schedule('b', { setId: 'b' }, { reps: '2' });
  const t0 = Date.now();
  await q.flushAll();
  assert.ok(Date.now() - t0 < 95, 'took ' + (Date.now() - t0) + 'ms');
});

// ─── Stale failures never overwrite newer edits (review round 3) ──────────────
test('A (reps=5) fails slowly while B (reps=55) succeeds: 5 is not requeued', async () => {
  const { createSaveQueue } = await load();
  mock.method(console, 'error', () => {});
  const server = [];
  const q = createSaveQueue(async (t, f) => {
    if (f.reps === '5') { await sleep(40); throw new Error('timeout'); }
    server.push(f.reps);
  }, 5);
  q.schedule('s1', { setId: 's1' }, { reps: '5' });
  await sleep(15);                                   // A in flight
  q.schedule('s1', { setId: 's1' }, { reps: '55' });
  await sleep(15);                                   // B fired, queued behind A
  assert.strictEqual(await q.flushAll(), true);      // nothing left to retry
  assert.strictEqual(q.pendingFields('s1'), null);
  await q.flushAll();
  assert.deepStrictEqual(server, ['55']);            // 5 never sent over 55
});

test('a failed send keeps only the fields nobody edited since', async () => {
  const { createSaveQueue } = await load();
  mock.method(console, 'error', () => {});
  const server = [];
  let failNext = true;
  const q = createSaveQueue(async (t, f) => {
    await sleep(30);
    if (failNext) { failNext = false; throw new Error('offline'); }
    server.push(f);
  }, 5);
  q.schedule('s1', { setId: 's1' }, { reps: '5', weight: '100' });
  await sleep(10);                                   // in flight, will fail
  q.schedule('s1', { setId: 's1' }, { reps: '6' });  // newer reps, weight untouched
  await sleep(10);                                   // reps=6 fired, chained
  assert.strictEqual(await q.flushAll(), false);     // weight=100 still unsaved
  assert.deepStrictEqual(q.pendingFields('s1'), { weight: '100' });
  assert.strictEqual(await q.flushAll(), true);
  assert.deepStrictEqual(server, [{ reps: '6' }, { weight: '100' }]);
});

test('a failure while a newer edit is still queued: the newer value wins, in the same flush', async () => {
  const { createSaveQueue } = await load();
  mock.method(console, 'error', () => {});
  const server = [];
  let failNext = true;
  const q = createSaveQueue(async (t, f) => {
    await sleep(20);
    if (failNext) { failNext = false; throw new Error('offline'); }
    server.push(f);
  }, 600);
  q.schedule('s1', { setId: 's1' }, { reps: '5' });
  const flushing = q.flushAll();
  await sleep(5);
  q.schedule('s1', { setId: 's1' }, { reps: '55' });   // typed during the flush (600ms timer)
  assert.strictEqual(await flushing, true);              // 5 superseded; 55 sent by this flush
  assert.strictEqual(q.size, 0);
  assert.deepStrictEqual(server, [{ reps: '55' }]);
});

// ─── saveSet ordering (review round 4) ────────────────────────────────────────
// saveSet does: drop(setId); await flush(setId); then its own PATCH.
test('drop + flush waits for the in-flight save, so a following direct save lands last', async () => {
  const { createSaveQueue } = await load();
  const server = [];
  const q = createSaveQueue(async (t, f) => { await sleep(50); server.push(f); }, 5);
  q.schedule('s1', { setId: 's1' }, { reps: '5' });
  await sleep(15);                               // debounced save in flight (slow)
  q.schedule('s1', { setId: 's1' }, { reps: '6' });   // still queued
  q.drop('s1');                                  // Save button pressed
  await q.flush('s1');                           // waits for the in-flight one only
  server.push({ reps: 6, savedAt: 'now' });      // saveSet's own PATCH
  await sleep(80);
  assert.deepStrictEqual(server, [{ reps: '5' }, { reps: 6, savedAt: 'now' }]);
  assert.strictEqual(q.size, 0);                 // the queued "6" was dropped, not sent
});

test('flush on a key with nothing pending or in flight resolves immediately', async () => {
  const { createSaveQueue } = await load();
  const q = createSaveQueue(async () => {}, 600);
  await q.flush('nothing');
});

// p-liftlog-220144: SAVE used to read the inputs before awaiting the in-flight
// as-you-type save, so a keystroke made during that wait was neither in the
// full PATCH nor kept on screen.
test('saveNow reads the values only after the in-flight save has landed', async () => {
  const { createSaveQueue, saveNow } = await load();
  const server = {};
  let release;
  const gate = new Promise(r => { release = r; });
  const q = createSaveQueue(async (t, f) => { await gate; Object.assign(server, f); }, 1000);
  const state = { weight: '22' };
  const target = { sessionId: 'A', exId: 'e', setId: 's1' };
  q.schedule('s1', target, { weight: state.weight });
  q.flush('s1');                                  // as-you-type save now in flight
  const sentFull = [];
  const done = saveNow(q, 's1', () => ({ weight: state.weight }), async (v) => { sentFull.push(v); Object.assign(server, v); });
  await sleep(5);
  state.weight = '225';                           // typed while that save is in flight
  q.schedule('s1', target, { weight: state.weight });
  release();
  const vals = await done;
  assert.deepStrictEqual(vals, { weight: '225' });
  assert.deepStrictEqual(sentFull, [{ weight: '225' }]);
  assert.strictEqual(server.weight, '225');
  assert.strictEqual(q.size, 0, 'the queued edit is covered by the full save, not resent');
  await sleep(20);
  assert.strictEqual(server.weight, '225');
});

test('saveNow: read() returning null sends nothing and keeps queued edits', async () => {
  const { createSaveQueue, saveNow } = await load();
  const { sent, send } = recorder();
  const q = createSaveQueue(send, 1000);
  const t = { sessionId: 'A', exId: 'e', setId: 's1' };
  let full = 0;
  const p = saveNow(q, 's1', () => { q.schedule('s1', t, { weight: null }); return null; }, async () => { full++; });
  assert.strictEqual(await p, null);
  assert.strictEqual(full, 0);
  assert.strictEqual(q.size, 1);
  q.drop('s1');
});

test('saveNow: a failing send rejects so the caller can requeue', async () => {
  const { createSaveQueue, saveNow } = await load();
  const q = createSaveQueue(async () => {}, 1000);
  await assert.rejects(saveNow(q, 's1', () => ({ reps: 5 }), async () => { throw new Error('offline'); }), /offline/);
});
