const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const sql = fs.readFileSync(path.resolve(__dirname, '../schema.sql'), 'utf8');

test('schema creates users table idempotently', () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS users/);
  assert.match(sql, /username TEXT NOT NULL UNIQUE/);
  assert.match(sql, /password_hash TEXT NOT NULL/);
});

test('schema adds nullable user_id to sessions, idempotently and indexed', () => {
  assert.match(sql, /ALTER TABLE sessions\s+ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions\(user_id\)/);
});
