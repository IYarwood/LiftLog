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
