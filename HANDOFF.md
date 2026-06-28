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
- Deploy path: `/var/www/liftlog`
- Caddy config: `/etc/caddy/Caddyfile` — already configured for `liftlog.ianyarwood.com`
- PM2 and Caddy are installed and running

---

## One-time VPS setup (already done or do manually via SSH — NOT Claude Code's job)

These steps are done once by hand over SSH. Claude Code does not need to do these.

```bash
# 1. Clone the repo
mkdir -p /var/www
cd /var/www
git clone https://github.com/YOUR_USERNAME/liftlog.git
cd liftlog

# 2. Install backend dependencies
cd backend && npm install --omit=dev && cd ..

# 3. Set up environment
cp backend/.env.example backend/.env
nano backend/.env
# Set: DATABASE_URL=postgresql://postgres:YOURPASSWORD@localhost:5432/liftlog

# 4. Create DB and run schema (ONE TIME ONLY)
sudo -u postgres psql -c "CREATE DATABASE liftlog;"
sudo -u postgres psql -d liftlog -f /var/www/liftlog/backend/schema.sql

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
cd /var/www/liftlog
./deploy.sh
```

`deploy.sh` does: `git pull` → `npm install` → `pm2 restart liftlog`

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

### Exercises
| Method | Path | Body | Notes |
|--------|------|------|-------|
| GET | `/api/exercises` | — | Returns `string[]` |
| POST | `/api/exercises` | `{ name }` | Upserts (ON CONFLICT DO NOTHING) |
| DELETE | `/api/exercises/:name` | — | Removes from library |

### Sessions
| Method | Path | Body | Notes |
|--------|------|------|-------|
| GET | `/api/sessions` | — | All completed sessions, full shape |
| GET | `/api/sessions/active` | — | In-progress session or `null` |
| GET | `/api/sessions/:id` | — | Single session, full shape |
| POST | `/api/sessions` | `{ id, startedAt }` | Start session |
| PATCH | `/api/sessions/:id/finish` | — | Sets finished_at = NOW() |
| POST | `/api/sessions/:id/exercises` | `{ id, name, position }` | Add exercise to session |
| DELETE | `/api/sessions/:id/exercises/:exId` | — | Remove exercise |
| POST | `/api/sessions/:id/exercises/:exId/sets` | `{ id, position }` | Add empty set |
| PATCH | `/api/sessions/:id/exercises/:exId/sets/:setId` | `{ reps?, weight?, savedAt? }` | Update set fields |
| DELETE | `/api/sessions/:id/exercises/:exId/sets/:setId` | — | Remove set |

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
- `updateSetField` debounces API calls by 600ms to avoid hammering the server on every keystroke — intentional.
- Exercise names can contain spaces/apostrophes. DELETE uses `:name` as a URL param — `encodeURIComponent` on frontend (done), `req.params.name` in query (done).
- `exerciseStats` computes PR/avg from the in-memory `sessions` array. Stats for the active session won't include the current workout — by design.

---

## MVP cuts (intentional, add later)
- No auth — personal tool, VPS is the only access point
- No data export
- No exercise reordering within a session
- No editing of completed sessions
- No rep/weight units toggle (lbs only)
