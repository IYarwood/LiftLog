# LiftLog — Claude Code Handoff

## What this is
A personal workout tracker web app migrated from a browser artifact (localStorage) to a self-hosted VPS app. The UI is a single vanilla HTML file — no framework, no build step. The backend is Express + PostgreSQL.

## Workflow
- **Local (Windows):** develop here, push to GitHub
- **VPS (Hostinger Ubuntu):** `git pull` + `pm2 restart` to deploy
- **Claude Code:** runs locally, reads this file, implements features, commits

## Repo structure
```
liftlog/
├── frontend/
│   └── index.html          # Full app UI — vanilla JS, no build step
├── backend/
│   ├── package.json
│   ├── .env.example        # Copy to .env on VPS, fill in DB password
│   ├── schema.sql          # Run ONCE on VPS to create tables + seed exercises
│   └── src/
│       ├── index.js        # Express entry point (port 3001)
│       ├── db/
│       │   └── pool.js     # pg Pool singleton
│       └── routes/
│           ├── exercises.js # GET/POST/DELETE /api/exercises
│           └── sessions.js  # All session/exercise/set routes
├── ecosystem.config.js     # PM2 config
├── deploy.sh               # Run on VPS after git pull
└── Caddyfile.snippet       # Already applied to /etc/caddy/Caddyfile on VPS
```

## Stack
- **Frontend:** Single `index.html` served as a static file by Caddy
- **Backend:** Node.js + Express (no TypeScript)
- **Database:** PostgreSQL installed directly on VPS (not Docker)
- **Process manager:** PM2
- **Reverse proxy:** Caddy
- **Domain:** `liftlog.ianyarwood.com` (A record → VPS IP already set in Squarespace DNS)

## VPS context
- Hostinger VPS running Ubuntu
- Deploy path: `/var/work/LiftLog`
- Caddy config: `/etc/caddy/Caddyfile` — already configured for `liftlog.ianyarwood.com`
- PM2 and Caddy are installed and running

---

## One-time VPS setup (already done or do manually via SSH — NOT Claude Code's job)

These steps are done once by hand over SSH. Claude Code does not need to do these.

```bash
# 1. Clone the repo
mkdir -p /var/work
cd /var/work
git clone https://github.com/IYarwood/LiftLog.git
cd LiftLog

# 2. Install backend dependencies
cd backend && npm install --omit=dev && cd ..

# 3. Set up environment
cp backend/.env.example backend/.env
nano backend/.env
# Set: DATABASE_URL=postgresql://postgres:YOURPASSWORD@localhost:5432/liftlog

# 4. Create DB and run schema (ONE TIME ONLY)
sudo -u postgres psql -c "CREATE DATABASE liftlog;"
sudo -u postgres psql -d liftlog -f /var/work/LiftLog/backend/schema.sql

# 5. Start with PM2
pm2 start ecosystem.config.js
pm2 save
pm2 startup  # follow the printed command to enable on reboot

# 6. Reload Caddy (Caddyfile.snippet already applied)
sudo systemctl reload caddy
```

### Verify it's working
```bash
curl https://liftlog.ianyarwood.com/api/health
# → {"ok":true}

curl https://liftlog.ianyarwood.com/api/exercises
# → ["Bench Press","Squat", ...]
```

---

## Ongoing deploy workflow (after initial setup)

On the VPS via SSH:
```bash
cd /var/work/LiftLog
./deploy.sh
```

`deploy.sh` does: un-stamp asset versions → `git pull` → `stamp-assets.sh` → `npm install` → `pm2 restart liftlog`

### Frontend cache-busting
`index.html`, `login.html` and `js/auth.js` reference `api.js` / `auth.js` /
`auth.css` with `?v=dev`. `stamp-assets.sh` (run by `deploy.sh`) rewrites that
to `?v=<git short SHA>` so Safari fetches fresh copies after every deploy.
After a deploy those three files show as modified in `git status` — expected;
`deploy.sh` resets them before the next pull. A new script/stylesheet/import
should use `?v=dev` and be listed in `stamp-assets.sh`.

---

## User accounts migration (one-time, on the VPS)

Run these **in order** — the owner account must exist before its sessions can be backfilled:

```bash
cd /var/work/LiftLog
git pull
cd backend && npm install            # pulls in bcryptjs, jsonwebtoken

# 1. Add a JWT secret to backend/.env (one line):
echo "JWT_SECRET=$(openssl rand -hex 32)" >> .env

# 2. Apply idempotent schema changes (safe to re-run):
sudo -u postgres psql -d liftlog -f schema.sql

# 3. Create the owner account:
node src/scripts/create-user.js ian <password>

# 4. Backfill existing sessions to the owner:
node src/scripts/backfill-owner.js ian

# 5. Restart:
pm2 restart liftlog
```

### Verify
```bash
# login returns a token
curl -s -X POST https://liftlog.ianyarwood.com/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"ian","password":"<password>"}'

# sessions now require auth (401 without a token)
curl -s -o /dev/null -w '%{http_code}\n' https://liftlog.ianyarwood.com/api/sessions   # → 401

# exercises stay public
curl -s https://liftlog.ianyarwood.com/api/exercises   # → ["Bench Press", ...]
```

---

## Claude Code's job

Claude Code works **locally** only. Its responsibilities:
- Implement features, fix bugs, write code
- Run and test the backend locally if needed (`node backend/src/index.js`)
- Commit and push to GitHub
- Never SSH into the VPS or run deploy steps

---

## Database schema

Four tables (see `backend/schema.sql` for full DDL):
- `exercises` — library of exercise names (seeded with 15 defaults)
- `sessions` — workout sessions (started_at, finished_at)
- `session_exercises` — exercises within a session, ordered by `position`
- `sets` — individual sets (reps, weight, saved_at), ordered by `position`

Client generates all IDs (`uid()` → random string). `saved_at` is null until the user taps "save" on a set.

---

## API contract

All routes under `/api`. Caddy proxies `/api/*` to `localhost:3001`.

### Auth
| Method | Path | Body | Notes |
|--------|------|------|-------|
| POST | `/api/auth/login` | `{ username, password }` | → `{ token, username }` or 401 (generic) |
| GET | `/api/auth/me` | — | Bearer token → `{ username }` or 401 |

All `/api/sessions/*` routes now require `Authorization: Bearer <token>`.
`/api/exercises` and `/api/health` remain public.

### Exercises
| Method | Path | Body | Notes |
|--------|------|------|-------|
| GET | `/api/exercises` | — | Returns `string[]` |
| POST | `/api/exercises` | `{ name }` | → `{ ok, name }`; **409** `{ error, name }` if the name exists ignoring case (`name` = existing library spelling) |
| DELETE | `/api/exercises/:name` | — | Removes from library |

### Sessions
| Method | Path | Body | Notes |
|--------|------|------|-------|
| GET | `/api/sessions` | — | All completed sessions, full shape |
| GET | `/api/sessions/active` | — | In-progress session or `null` |
| GET | `/api/sessions/:id` | — | Single session, full shape |
| POST | `/api/sessions` | `{ id, startedAt }` | Start session |
| PATCH | `/api/sessions/:id/finish` | — | Sets finished_at = NOW() |
| POST | `/api/sessions/:id/exercises` | `{ id, name }` | Add exercise to session. Position = last + 1 (server-assigned; a sent `position` is ignored). **409** `{ error, id, name }` if the session already has that name ignoring case; re-sending the same `{ id, name }` is a 200 no-op |
| DELETE | `/api/sessions/:id/exercises/:exId` | — | Remove exercise |
| POST | `/api/sessions/:id/exercises/:exId/sets` | `{ id }` | Add empty set. Position = last + 1 (server-assigned) |
| PATCH | `/api/sessions/:id/exercises/:exId/sets/:setId` | `{ reps?, weight?, savedAt? }` | Update set fields. Omitted field = unchanged; `null` (or `''`) = clear. reps 0–9999 whole, weight 0–9999.99, else **400** |
| DELETE | `/api/sessions/:id/exercises/:exId/sets/:setId` | — | Remove set |
| DELETE | `/api/sessions/:id` | — | Delete a whole workout (owner only; a finished one only inside the edit window) |

**Edit window.** The writes above (add/remove exercise, add/edit/remove set, delete workout)
also work on a FINISHED workout, but only for its owner and only within
`EDIT_WINDOW_DAYS` (7, `backend/src/db/editWindow.js`) of `finished_at`. After that they
return **403** `{ error: "Editing closed: ...", code: "edit_window_closed" }`. In-progress
workouts are never limited. Any write to a finished workout sets `sessions.edited_at`
(shown as an "edited" tag in the detail view, the feed and on strength-board PRs).
`PATCH /finish` on an already-finished workout is a 200 no-op (it no longer moves `finished_at`).
Session shape gains `editedAt` (null if never edited) and `editableUntil`.
The edit UI never autosaves set values: typed changes live in a local draft
(`frontend/js/editDraft.js`) and only **done** sends them, one PATCH per changed set with only
the changed fields, after validation. Leaving without done discards the draft (confirm if
changed). Add/delete set, remove exercise and delete workout are immediate. A PATCH that would
clear reps/weight (null) on a finished workout is a 400. Live workouts keep the autosave queue.

### Session shape returned by API
```json
{
  "id": "_abc123",
  "startedAt": "2025-01-15T14:30:00.000Z",
  "finishedAt": "2025-01-15T15:45:00.000Z",
  "exercises": [
    {
      "id": "_def456",
      "name": "Bench Press",
      "sets": [
        { "id": "_ghi789", "reps": 8, "weight": 185, "savedAt": "2025-01-15T14:35:00.000Z" }
      ]
    }
  ]
}
```

---

## Known gotchas
- `GET /api/sessions/active` must be registered BEFORE `GET /api/sessions/:id` in the router — already handled correctly in `sessions.js`.
- `updateSetField` debounces API calls by 600ms to avoid hammering the server on every keystroke — intentional. The queue lives in `frontend/js/saveQueue.js`: it captures the target ids at edit time and merges a set's fields. `finishSession` and `reloadActive` await `setSaves.flushAll()` first, so nothing typed just before FINISH is lost.
- Exercise names can contain spaces/apostrophes. DELETE uses `:name` as a URL param — `encodeURIComponent` on frontend (done), `req.params.name` in query (done).
- `exerciseStats` computes PR/avg from the in-memory `sessions` array. Stats for the active session won't include the current workout — by design.

---

## MVP cuts (intentional, add later)
- No signup, password reset, or token refresh — username/password login only. Exercise library remains shared.
- No data export
- No exercise reordering within a session
- No editing of completed sessions
- No rep/weight units toggle (lbs only)

---

## Friends migration (one-time, on the VPS)

Adds the `friendships` table + indexes. Idempotent (`IF NOT EXISTS` everywhere), safe to re-run.
Uses the standalone migration file rather than re-running `schema.sql`, so the
default-exercise seed doesn't re-add library exercises that were removed.

```bash
cd /var/work/LiftLog
git pull
cd backend
set -a; . ./.env; set +a                       # DATABASE_URL (prod DB needs the password)
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/2026-11-21-friends.sql
psql "$DATABASE_URL" -c '\d friendships'       # verify
pm2 restart liftlog
```

Note: `npm test` includes integration tests that write to the DB; they skip
themselves unless `DATABASE_URL` names a `*_test` database. Never run them on prod.

---

## Case-insensitive exercise names migration (one-time, on the VPS)

Adds a unique index on `lower(exercises.name)` so the shared library can't hold
"Squat" and "squat" side by side (the API returns 409 for both exact and
case-variant duplicates). Idempotent, safe to re-run. Back up first.

```bash
cd /var/work/LiftLog
git pull
cd backend
set -a; . ./.env; set +a
pg_dump "$DATABASE_URL" -Fc -f ~/liftlog-$(date +%F-%H%M).dump      # backup
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/2026-11-22-exercise-name-ci-unique.sql
psql "$DATABASE_URL" -c '\d exercises'      # expect idx_exercises_name_lower UNIQUE (lower(name))
pm2 restart liftlog
```

### If it fails with "exercises has names that differ only by case"
The guard aborts before creating anything and lists the clashing names. Find them with:

```sql
SELECT lower(name) AS key, array_agg(name ORDER BY created_at) AS variants
  FROM exercises GROUP BY lower(name) HAVING count(*) > 1;
```

Then, for each group, keep one spelling and rename or delete the others (with the
owner's say-so — the library is shared). Logged workouts store the name as text
(`session_exercises.name`), so deleting a library row never touches history.
Re-run the migration afterwards.

---

## Leaderboards

Tab **RANKS** (5th bottom tab) → page with a Weekly | Monthly | Strength segmented control.
No new tables, indexes or migrations: computed on the fly (small data).

Who's on a board: the viewer + **accepted** friends only (same rule as `/api/feed`).
What counts: **finished** sessions only. All under `requireAuth`.

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/leaderboard/weekly?offset=0` | Points board, Monday 00:00 reset. `offset=-1` = last week (0 to -520) |
| GET | `/api/leaderboard/monthly?offset=0` | Points board, 1st 00:00 reset |
| GET | `/api/leaderboard/strength` | One row per exercise anyone on the board has done, with its holder |
| GET | `/api/leaderboard/strength/:exercise` | Everyone's best for one exercise (name matched ignoring case); 404 if nobody on the board did it |

Scoring constants live in `backend/src/leaderboard/points.js` (timezone, caps, 25% guard,
rep range). Timezone defaults to `America/New_York`; set `LEADERBOARD_TZ=<IANA zone>` in
`backend/.env` (and `pm2 restart`) to change it without a code change.

- **Progress:** per exercise (case-insensitive), best e1RM = weight × (1 + reps/30) from
  sets with 1–12 reps and weight > 0, this period vs the 8 weeks before the period
  started. Points = round(% gain × 10), min 0, cap 50/week or 100/month per exercise.
  No baseline → 0 (sets the baseline). Gain > 25% → 0 (ignored as a likely typo).
  All progress points together are capped at `PROGRESS_TOTAL_CAP` = 150/week, 400/month
  (`progressRaw` / `progress` / `progressCapped` in the API; "capped" line in the UI).
- **Consistency:** 10 pts per distinct local day with a finished workout that logged at
  least one set with reps ≥ 1; cap 4 days/week, 16 days/month.
- **Strength:** heaviest weight (reps ≥ 1, weight > 0); tiebreak more reps, then earliest
  finished session. e1RM is shown only for ≤ 12 reps and never used for ranking.
  Bodyweight sets (weight 0) don't appear.
  **Crown guard** (`CROWN_MAX_JUMP_PCT` = 50), judged per WORKOUT: take each user's best
  lift per workout; a workout's best only ranks if a DIFFERENT workout's best is within 50%
  of it, either way (so 2250 typed for all 3 sets of one workout can't back itself up, and a
  bogus 9999 can't back up a bogus 2250). The user's ranked lift is their heaviest backed-up
  workout best; the ones above it come back in `unverified` (greyed out in the UI). A user
  with one workout of an exercise has no ranked entry yet; an exercise may have `holder: null`.

---

## Edited-workouts migration (one-time, on the VPS)

Adds the nullable `sessions.edited_at` column. Idempotent, safe to re-run, and harmless
to the old code, so apply it BEFORE deploying: the new code reads the column (the
leaderboard strength query fails without it). Same statement as
`backend/migrations/2026-11-23-session-edited-at.sql`, inlined because that file only
arrives with the pull that `deploy.sh` does.

```bash
cd /var/work/LiftLog
set -a; . backend/.env; set +a
pg_dump "$DATABASE_URL" -Fc -f ~/liftlog-$(date +%F-%H%M).dump      # backup
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c 'ALTER TABLE sessions ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;'
psql "$DATABASE_URL" -c '\d sessions'     # expect: edited_at | timestamp with time zone
./deploy.sh                                 # pull, stamp, npm install, pm2 restart liftlog
```
