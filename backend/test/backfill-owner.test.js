const { test } = require('node:test');
const assert = require('node:assert');
const { backfillOwner } = require('../src/scripts/backfill-owner');

test('backfillOwner assigns unowned sessions to the user', async () => {
  const calls = [];
  const fakePool = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/SELECT id FROM users/.test(sql)) return { rows: [{ id: 5 }] };
      return { rowCount: 3 };
    },
  };
  const count = await backfillOwner(fakePool, 'Ian');
  assert.strictEqual(count, 3);
  const update = calls.find(c => /UPDATE sessions/.test(c.sql));
  assert.match(update.sql, /user_id IS NULL/);
  assert.deepStrictEqual(update.params, [5]);
});

test('backfillOwner is safe with zero sessions', async () => {
  const fakePool = {
    query: async (sql) =>
      /SELECT id FROM users/.test(sql) ? { rows: [{ id: 5 }] } : { rowCount: 0 },
  };
  assert.strictEqual(await backfillOwner(fakePool, 'ian'), 0);
});

test('backfillOwner rejects an unknown user', async () => {
  const fakePool = { query: async () => ({ rows: [] }) };
  await assert.rejects(() => backfillOwner(fakePool, 'ghost'), /not found/);
});
