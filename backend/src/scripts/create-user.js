const bcrypt = require('bcryptjs');

async function createUser(pool, usernameRaw, password) {
  if (!usernameRaw || !password) {
    throw new Error('Usage: create-user.js <username> <password>');
  }
  const username = usernameRaw.toLowerCase();

  const existing = await pool.query('SELECT 1 FROM users WHERE username = $1', [username]);
  if (existing.rows.length) {
    throw new Error(`User "${username}" already exists`);
  }

  const passwordHash = await bcrypt.hash(password, 10);
  await pool.query(
    'INSERT INTO users (username, password_hash) VALUES ($1, $2)',
    [username, passwordHash]
  );
  return username;
}

module.exports = { createUser };

// CLI: node src/scripts/create-user.js <username> <password>
if (require.main === module) {
  require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
  const pool = require('../db/pool');
  const [, , username, password] = process.argv;
  createUser(pool, username, password)
    .then((u) => { console.log(`Created user "${u}"`); })
    .catch((err) => { console.error(err.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
