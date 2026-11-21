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

test('schema creates friendships table idempotently', () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS friendships/);
  assert.match(sql, /requester_id INTEGER NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(sql, /addressee_id INTEGER NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(sql, /CHECK \(status IN \('pending', 'accepted'\)\)/);
  assert.match(sql, /CHECK \(requester_id <> addressee_id\)/);
});

test('schema enforces one friendship row per unordered pair, idempotently', () => {
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_friendships_pair\s+ON friendships \(LEAST\(requester_id, addressee_id\), GREATEST\(requester_id, addressee_id\)\)/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_friendships_addressee/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_sessions_user_finished/);
});

test('friends migration matches the friendships section of schema.sql', () => {
  const mig = fs.readFileSync(path.resolve(__dirname, '../migrations/2026-11-21-friends.sql'), 'utf8');
  const stmts = mig.replace(/--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean);
  assert.ok(stmts.length >= 4);
  const norm = (s) => s.replace(/--.*$/gm, '').replace(/\s+/g, ' ');
  for (const stmt of stmts) assert.ok(norm(sql).includes(norm(stmt)), `schema.sql is missing: ${stmt.slice(0, 60)}`);
  for (const stmt of stmts) assert.match(stmt, /IF NOT EXISTS/);   // idempotent
});
