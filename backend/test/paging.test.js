const { test } = require('node:test');
const assert = require('node:assert');
const { parsePage, isCursorTs } = require('../src/db/paging');

test('parsePage accepts a cursor in the exact format the server issues', () => {
  const p = parsePage({ before: '2026-11-18T23:12:14.690888Z|_demo_legday' });
  assert.deepStrictEqual(p.before, { ts: '2026-11-18T23:12:14.690888Z', id: '_demo_legday' });
});

test('parsePage rejects malformed or impossible cursor timestamps', () => {
  for (const bad of [
    '2020|x', '1|x', '0|x', 'June 5|x', '2026-02-30T00:00:00Z|x',
    '2026-02-30T00:00:00.000000Z|x', '2026-13-01T00:00:00.000000Z|x',
    '2026-01-01T24:00:00.000000Z|x', '2026-01-01T00:60:00.000000Z|x',
    '2026-01-01T00:00:00.000Z|x', '2026-01-01 00:00:00.000000Z|x',
    '2026-01-01T00:00:00.000000+00:00|x', '2026-01-01T00:00:00.000000Z|',
    '|x', 'garbage',
  ]) {
    assert.deepStrictEqual(parsePage({ before: bad }), { error: 'invalid cursor' }, bad);
  }
  assert.strictEqual(isCursorTs('2024-02-29T12:00:00.000001Z'), true);   // leap day is real
  assert.strictEqual(isCursorTs('2025-02-29T12:00:00.000001Z'), false);
});
