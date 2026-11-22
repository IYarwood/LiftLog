const { test } = require('node:test');
const assert = require('node:assert');
const { toWeight } = require('../src/db/hydrate');

test('toWeight turns NUMERIC strings into plain numbers', () => {
  assert.strictEqual(toWeight('225.00'), 225);
  assert.strictEqual(toWeight('225.50'), 225.5);
  assert.strictEqual(toWeight('102.25'), 102.25);
  assert.strictEqual(toWeight('0.00'), 0);
  assert.strictEqual(toWeight(null), null);
  assert.strictEqual(JSON.stringify({ w: toWeight('225.00') }), '{"w":225}');
});
