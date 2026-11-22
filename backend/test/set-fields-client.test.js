// Tests for the frontend's set-value rules (frontend/js/setFields.js) and how
// they drive the save queue (frontend/js/saveQueue.js) while the user types.
// Includes the tester's round-4 repros: an invalid value must never leave the
// previous (valid) keystroke queued or stored.
const { test, mock, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { parseSetFields } = require('../src/validation/setFields');

const frontend = (f) => import(pathToFileURL(path.resolve(__dirname, '../../frontend/js', f)).href);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
afterEach(() => mock.restoreAll());

test('fieldSaveValue: valid → value, blank → null (clear), invalid → null (clear)', async () => {
  const { fieldSaveValue } = await frontend('setFields.js');
  assert.strictEqual(fieldSaveValue('weight', '225.5'), '225.5');
  assert.strictEqual(fieldSaveValue('reps', '8'), '8');
  assert.strictEqual(fieldSaveValue('reps', '0'), '0');
  assert.strictEqual(fieldSaveValue('weight', ''), null);
  assert.strictEqual(fieldSaveValue('weight', '22555'), null);
  assert.strictEqual(fieldSaveValue('weight', '12345'), null);
  assert.strictEqual(fieldSaveValue('reps', '1.5'), null);
  assert.strictEqual(fieldSaveValue('reps', '-1'), null);
});

test('client and server agree on which values are valid', async () => {
  const { setFieldError } = await frontend('setFields.js');
  const cases = {
    reps: ['0', '1', '9999', '10000', '1.5', '-1', '1e3', 'abc'],
    weight: ['0', '225', '225.5', '102.25', '9999.99', '9999.995', '10000', '12345', '-5', '1e3', 'abc'],
  };
  for (const [field, vals] of Object.entries(cases)) {
    for (const v of vals) {
      const clientOk = !setFieldError(field, v);
      const serverOk = !parseSetFields({ [field]: v }).error;
      assert.strictEqual(clientOk, serverOk, `${field}=${v}: client ${clientOk}, server ${serverOk}`);
    }
  }
});

// What the app does on each keystroke: updateSetField schedules
// fieldSaveValue(field, value) for that field.
async function harness({ delay = 20, sendImpl } = {}) {
  const { createSaveQueue } = await frontend('saveQueue.js');
  const { fieldSaveValue } = await frontend('setFields.js');
  const server = { reps: null, weight: null };
  const sends = [];
  const q = createSaveQueue(async (t, fields) => {
    if (sendImpl) await sendImpl(fields);
    sends.push(fields);
    Object.assign(server, fields);
  }, delay);
  const target = { sessionId: 'A', exId: 'e', setId: 's1' };
  const type = async (field, text, gap = 0) => {
    for (let i = 1; i <= text.length; i++) {
      q.schedule('s1', target, { [field]: fieldSaveValue(field, text.slice(0, i)) });
      if (gap) await sleep(gap);
    }
  };
  const clear = (field) => q.schedule('s1', target, { [field]: fieldSaveValue(field, '') });
  return { q, server, sends, type, clear };
}

test('repro 1: typing 22555 (fast) stores nothing, not 2255', async () => {
  const h = await harness();
  await h.type('weight', '22555');
  assert.strictEqual(await h.q.flushAll(), true);
  assert.strictEqual(h.server.weight, null);
  assert.ok(!h.sends.some(f => f.weight === '2255'), JSON.stringify(h.sends));
});

test('repro 1, typed slowly: 2255 was saved during a pause, then 22555 clears it', async () => {
  const h = await harness({ delay: 10 });
  await h.type('weight', '2255', 30);        // each keystroke saved
  assert.strictEqual(h.server.weight, '2255');
  await h.type('weight', '22555');           // the extra "5" makes it invalid
  await h.q.flushAll();
  assert.strictEqual(h.server.weight, null);
});

test('repro 2: typing 12345 then clearing the field stores null, not 1234', async () => {
  const h = await harness();
  await h.type('weight', '12345');
  h.clear('weight');
  await h.q.flushAll();
  assert.strictEqual(h.server.weight, null);
  assert.ok(!h.sends.some(f => f.weight === '1234'), JSON.stringify(h.sends));
});

test('reps 1.5 stores nothing, not 1', async () => {
  const h = await harness();
  await h.type('reps', '1.5');
  await h.q.flushAll();
  assert.strictEqual(h.server.reps, null);
});

test('the earlier valid value failing in flight is not retried once the field went invalid', async () => {
  mock.method(console, 'error', () => {});
  let failFirst = true;
  const h = await harness({
    delay: 5,
    sendImpl: async (fields) => {
      await sleep(30);
      if (failFirst) { failFirst = false; throw new Error('offline'); }
    },
  });
  await h.type('weight', '2255');
  await sleep(15);                            // "2255" in flight, about to fail
  await h.type('weight', '22555');
  assert.strictEqual(await h.q.flushAll(), true);
  assert.strictEqual(h.server.weight, null);
  assert.ok(!h.sends.some(f => f.weight === '2255'), JSON.stringify(h.sends));
});

test('a valid value typed after an invalid one is saved normally', async () => {
  const h = await harness();
  await h.type('weight', '22555');
  h.clear('weight');
  await h.type('weight', '225');
  await h.q.flushAll();
  assert.strictEqual(h.server.weight, '225');
});
