const { test } = require('node:test');
const assert = require('node:assert');

process.env.JWT_SECRET = 'test-secret';
const requireAuth = require('../src/middleware/auth');
const { signToken } = require('../src/auth/tokens');

function mockRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

test('calls next and sets req.userId for a valid token', () => {
  const token = signToken({ userId: 42, username: 'ian' });
  const req = { headers: { authorization: `Bearer ${token}` } };
  const res = mockRes();
  let nextCalled = false;
  requireAuth(req, res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true);
  assert.strictEqual(req.userId, 42);
  assert.strictEqual(req.username, 'ian');
});

test('responds 401 when the Authorization header is missing', () => {
  const req = { headers: {} };
  const res = mockRes();
  let nextCalled = false;
  requireAuth(req, res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 401);
});

test('responds 401 for an invalid token', () => {
  const req = { headers: { authorization: 'Bearer garbage' } };
  const res = mockRes();
  let nextCalled = false;
  requireAuth(req, res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 401);
});
