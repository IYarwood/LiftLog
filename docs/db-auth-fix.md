# Database Auth Fix — June 2026

## Problem

The backend was failing on every request to `/api/exercises` (and all other DB-backed routes) with:

```
Error: SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string
```

followed by:

```
FATAL: Peer authentication failed for user "postgres"  (code 28000)
```

## Root Causes

### 1. `ecosystem.config.js` — wrong `env_file` path

```js
// before
env_file: './backend/env',

// after
env_file: './backend/.env',
```

The missing dot meant PM2 could never find the env file, so `DATABASE_URL` was `undefined` when the process started.

### 2. `backend/src/index.js` — `dotenv.config()` used wrong working directory

PM2 sets `cwd` to `/var/work/LiftLog`, but the `.env` file lives at `backend/.env`. Without an explicit path, dotenv searched the project root and found nothing.

```js
// before
require('dotenv').config();

// after
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
```

`__dirname` here is `backend/src`, so `../` resolves correctly to `backend/.env` regardless of the process working directory.

### 3. `backend/src/db/pool.js` — redundant `dotenv.config()` removed

`pool.js` had its own `require('dotenv').config()` call. Since `index.js` is the entry point and runs first, this call was always redundant. Removed to avoid confusion.

### 4. `pg_hba.conf` — peer auth blocked app connections

The app process runs as OS user `root` but connects to PostgreSQL as DB user `postgres`. PostgreSQL's peer authentication rejects this because the OS username must match the DB username.

Added a targeted `scram-sha-256` rule for the `liftlog` database **before** the existing peer rules, so the app authenticates with a password while the `postgres` OS user retains password-free maintenance access:

```
# /etc/postgresql/16/main/pg_hba.conf

# App connection: password auth for liftlog database
local   liftlog         postgres                                scram-sha-256

# Database administrative login by Unix domain socket (unchanged)
local   all             postgres                                peer
local   all             all                                     peer
```

Rule order matters — PostgreSQL uses the first match.

### 5. `pg_hba.conf` — file ownership blocked config reloads

The file had `root:root` ownership. The `postgres` OS user couldn't read it, so `pg_reload_conf()` returned success but silently kept the old in-memory rules.

```bash
chown root:postgres /etc/postgresql/16/main/pg_hba.conf
chmod 640 /etc/postgresql/16/main/pg_hba.conf
```

### 6. `backend/.env` — password added to `DATABASE_URL`

```
DATABASE_URL=postgresql://postgres:<password>@/liftlog?host=/var/run/postgresql
```

The postgres DB user already had a password set; it just wasn't being passed in the connection string.

## Files Changed

| File | Change |
|---|---|
| `ecosystem.config.js` | Fixed `env_file` path typo |
| `backend/src/index.js` | Explicit dotenv path via `__dirname` |
| `backend/src/db/pool.js` | Removed redundant `dotenv.config()` |
| `backend/.env` | Added password to `DATABASE_URL` (not committed) |
| `/etc/postgresql/16/main/pg_hba.conf` | Added `scram-sha-256` rule; fixed ownership |
| `.gitignore` | Added to exclude `.env` and `node_modules/` |
