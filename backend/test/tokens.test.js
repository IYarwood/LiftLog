const { test } = require('node:test');
const assert = require('node:assert');

process.env.JWT_SECRET = 'test-secret';
const { signToken, verifyToken } = require('../src/auth/tokens');

test('signToken then verifyToken round-trips the payload', () => {
  const token = signToken({ userId: 7, username: 'ian' });
  const decoded = verifyToken(token);
  assert.strictEqual(decoded.userId, 7);
  assert.strictEqual(decoded.username, 'ian');
});

test('verifyToken throws on a tampered token', () => {
  assert.throws(() => verifyToken('not-a-real-token'));
});
