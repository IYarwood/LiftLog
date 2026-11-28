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

test('fieldSaveValue: valid → value, blank → null (clear), invalid → undefined (send nothing)', async () => {
  const { fieldSaveValue } = await frontend('setFields.js');
  assert.strictEqual(fieldSaveValue('weight', '225.5'), '225.5');
  assert.strictEqual(fieldSaveValue('reps', '8'), '8');
  assert.strictEqual(fieldSaveValue('reps', '0'), '0');
  assert.strictEqual(fieldSaveValue('weight', ''), null);
  assert.strictEqual(fieldSaveValue('weight', '22555'), undefined);
  assert.strictEqual(fieldSaveValue('weight', '12345'), undefined);
  assert.strictEqual(fieldSaveValue('reps', '1.5'), undefined);
  assert.strictEqual(fieldSaveValue('reps', '-1'), undefined);
});

test('client and server agree on which values are valid', async () => {
  const { setFieldError } = await frontend('setFields.js');
  const cases = {
    reps: ['0', '1', '9999', '10000', '1.5', '-1', '1e3', 'abc', '0x10', '+5', ' 8 '],
    weight: ['0', '225', '225.5', '102.25', '9999.99', '9999.995', '10000', '12345', '-5', '1e3', 'abc',
      '0x10', '0b11', '+5', '.5', '225.', '.', '1.2.3', 'Infinity'],
  };
  for (const [field, vals] of Object.entries(cases)) {
    for (const v of vals) {
      const clientOk = !setFieldError(field, v);
      const serverOk = !parseSetFields({ [field]: v }).error;
      assert.strictEqual(clientOk, serverOk, `${field}=${v}: client ${clientOk}, server ${serverOk}`);
    }
  }
});

// What the app does on each keystroke: updateSetField calls
// queueSetFields(queue, setId, target, { [field]: value }).
async function harness({ delay = 20, sendImpl, stored = {} } = {}) {
  const { createSaveQueue } = await frontend('saveQueue.js');
  const { fieldSaveValue, queueSetFields } = await frontend('setFields.js');
  const server = { reps: null, weight: null, ...stored };
  const sends = [];
  const q = createSaveQueue(async (t, fields) => {
    if (sendImpl) await sendImpl(fields);
    sends.push(fields);
    Object.assign(server, fields);
  }, delay);
  const target = { sessionId: 'A', exId: 'e', setId: 's1' };
  const type = async (field, text, gap = 0) => {
    for (let i = 1; i <= text.length; i++) {
      queueSetFields(q, 's1', target, { [field]: text.slice(0, i) });
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

test('repro 1, typed slowly: 2255 was saved during a pause; 22555 sends nothing more', async () => {
  const h = await harness({ delay: 10 });
  await h.type('weight', '2255', 30);        // each keystroke saved
  assert.strictEqual(h.server.weight, '2255');
  const before = h.sends.length;
  h.sends.length = 0;
  await h.type('weight', '22555');           // the extra "5" makes it invalid
  await h.q.flushAll();
  assert.ok(before > 0);
  assert.deepStrictEqual(h.sends.filter(f => f.weight !== '2' && f.weight !== '22' && f.weight !== '225' && f.weight !== '2255'), []);
  assert.ok(!h.sends.some(f => f.weight === null), 'invalid never clears');
});

// Tester FAIL on PR #15: an invalid value used to be saved as null, wiping a
// stored weight. Invalid input must send nothing and keep what's stored.
test('typing 1,000 or 22,5,5 over a stored 225.5 keeps 225.5 (red, nothing sent)', async () => {
  const { setFieldError, WEIGHT_FORMAT_MSG } = await frontend('setFields.js');
  for (const text of ['1,000', '22,5,5']) {
    const h = await harness({ stored: { weight: 225.5 } });
    await h.type('weight', text);            // fast: earlier keystrokes still queued
    assert.strictEqual(await h.q.flushAll(), true);
    assert.strictEqual(h.server.weight, 225.5, text);
    assert.deepStrictEqual(h.sends, [], text);
    assert.strictEqual(setFieldError('weight', text), WEIGHT_FORMAT_MSG);
  }
});

test('emptying the field on purpose still clears the stored value', async () => {
  const h = await harness({ stored: { weight: 225.5 } });
  h.clear('weight');
  await h.q.flushAll();
  assert.strictEqual(h.server.weight, null);
});

test('an invalid value only unschedules its own field', async () => {
  const h = await harness({ stored: { weight: 225.5, reps: 3 } });
  await h.type('reps', '8');
  await h.type('weight', '1e3');
  await h.q.flushAll();
  assert.deepStrictEqual([h.server.reps, h.server.weight], ['8', 225.5]);
});

test('error text: format problems say how to write it, range problems give the range', async () => {
  const { setFieldError } = await frontend('setFields.js');
  assert.strictEqual(setFieldError('weight', '1,000'), 'Use a number like 225 or 225.5.');
  assert.strictEqual(setFieldError('weight', 'abc'), 'Use a number like 225 or 225.5.');
  assert.strictEqual(setFieldError('weight', '12345'), 'Weight must be from 0 to 9999.99 lb.');
  assert.strictEqual(setFieldError('reps', 'abc'), 'Reps must be a whole number, like 8.');
  assert.strictEqual(setFieldError('reps', '1.5'), 'Reps must be a whole number from 0 to 9999.');
});

test('non-decimal forms are rejected on both sides: 1e3, 0x10, 0b11, +5', async () => {
  const { setFieldError } = await frontend('setFields.js');
  for (const v of ['1e3', '0x10', '0b11', '+5', '-5', 'Infinity']) {
    assert.notStrictEqual(setFieldError('weight', v), '', v);
    assert.ok(parseSetFields({ weight: v }).error, v);
    assert.ok(parseSetFields({ reps: v }).error, v);
  }
  // real numbers (JSON) are still fine on the server
  assert.deepStrictEqual(parseSetFields({ reps: 8, weight: 225.5 }).fields, { reps: 8, weight: 225.5 });
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

// p-liftlog-094112: a comma decimal ("225,5", or "225," half-typed) used to
// reach the app as "" from a type="number" input, clearing the stored weight
// with no red highlight. The inputs are type="text" now, and a decimal comma
// is accepted.
test('comma decimal: parsed, sent with a dot, never treated as blank', async () => {
  const { fieldSaveValue, setFieldError, setFieldNumber, normalizeSetInput } = await frontend('setFields.js');
  assert.strictEqual(setFieldError('weight', '225,5'), '');
  assert.strictEqual(setFieldError('weight', '225,'), '');
  assert.strictEqual(setFieldError('weight', '102,25'), '');
  assert.strictEqual(fieldSaveValue('weight', '225,5'), '225.5');
  assert.strictEqual(fieldSaveValue('weight', '225,'), '225.');
  assert.strictEqual(setFieldNumber('225,5'), 225.5);
  assert.strictEqual(setFieldNumber('225,'), 225);
  assert.strictEqual(setFieldNumber(' '), null);
  // What the client sends must be accepted by the server as the same number.
  assert.deepStrictEqual(parseSetFields({ weight: fieldSaveValue('weight', '225,5') }).fields, { weight: 225.5 });
  assert.deepStrictEqual(parseSetFields({ weight: fieldSaveValue('weight', '225,') }).fields, { weight: 225 });
  // Not a decimal comma → invalid (red), not silently misread.
  for (const v of ['1,000', '22,5,5', ',', '2.5,5']) {
    assert.notStrictEqual(setFieldError('weight', v), '', v);
    assert.strictEqual(fieldSaveValue('weight', v), undefined, v);
  }
  assert.notStrictEqual(setFieldError('reps', '8,5'), '');
  assert.strictEqual(normalizeSetInput('8'), '8');
});

test('typing "225,5" over a stored weight ends with 225.5 stored, never cleared', async () => {
  const { createSaveQueue } = await frontend('saveQueue.js');
  const { fieldSaveValue } = await frontend('setFields.js');
  const server = { weight: 200 };
  const q = createSaveQueue(async (t, f) => { Object.assign(server, parseSetFields(f).fields); }, 5);
  const target = { sessionId: 'A', exId: 'e', setId: 's1' };
  for (const text of ['2', '22', '225', '225,', '225,5']) {
    q.schedule('s1', target, { weight: fieldSaveValue('weight', text) });
    if (text === '225,') { await q.flushAll(); assert.strictEqual(server.weight, 225); }
  }
  await q.flushAll();
  assert.strictEqual(server.weight, 225.5);
});

test('edit draft: a comma decimal is a change to 225.5, not a blank', async () => {
  const { draftChanges } = await frontend('editDraft.js');
  const orig = { exercises: [{ id: 'e', sets: [{ id: 's', reps: 5, weight: 200 }] }] };
  const draft = { exercises: [{ id: 'e', sets: [{ id: 's', reps: 5, weight: '225,5' }] }] };
  assert.deepStrictEqual(draftChanges(orig, draft), { patches: [{ exId: 'e', setId: 's', fields: { weight: 225.5 } }], invalid: [] });
});
