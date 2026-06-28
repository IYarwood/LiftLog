const { test } = require('node:test');
const assert = require('node:assert');
const bcrypt = require('bcryptjs');
const { createUser } = require('../src/scripts/create-user');

test('createUser lowercases, hashes, and inserts', async () => {
  const calls = [];
  const fakePool = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/SELECT 1 FROM users/.test(sql)) return { rows: [] };
      return { rows: [] };
    },
  };
  const username = await createUser(fakePool, 'Ian', 'secret');
  assert.strictEqual(username, 'ian');
  const insert = calls.find(c => /INSERT INTO users/.test(c.sql));
  assert.strictEqual(insert.params[0], 'ian');
  assert.notStrictEqual(insert.params[1], 'secret');
  assert.strictEqual(await bcrypt.compare('secret', insert.params[1]), true);
});

test('createUser rejects a duplicate username', async () => {
  const fakePool = {
    query: async (sql) =>
      /SELECT 1 FROM users/.test(sql) ? { rows: [{ '?column?': 1 }] } : { rows: [] },
  };
  await assert.rejects(() => createUser(fakePool, 'ian', 'x'), /already exists/);
});

test('createUser rejects missing arguments', async () => {
  const fakePool = { query: async () => ({ rows: [] }) };
  await assert.rejects(() => createUser(fakePool, '', ''), /Usage/);
});
