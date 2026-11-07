# Run For Your Apocalypse — Server

Login + ranking + save server for the game **Run For Your Apocalypse**
(static site: https://kangjackbe.github.io/run-for-your-apocalypse/).

Scope: **login + ranking + save only. No realtime multiplayer.**

## What it does

| Feature | How |
|---|---|
| Signup / login | Nickname (unique, 2–16 chars) + password (4–64 chars). Passwords are stored as salted scrypt hashes — plaintext is never stored, and the admin cannot read originals. Password recovery = reset only (no "find my password" endpoint). |
| Save | Per-account profile save: coins, owned/equipped skins, class (fixed at first selection — the server refuses to change it once set), weapon, permanent upgrades (HP / attack / defense / move speed / attack speed / crit), world progress, owned/equipped BGM. |
| Ranking | Endless-mode records: survival time, kills, stage, world, nickname, date. Public top-100 list. Only nickname + score are exposed — no personal data. |
| Auth | Login returns a random token (30-day expiry), sent as `Authorization: Bearer <token>`. |
| Safety | Login rate limit (10 failed attempts per nickname / 10 min), input validation + caps on all fields, 200 KB request-body cap, no IP logging or tracking. |

## Tech

- **Node.js, zero external dependencies** — built-in `http` / `crypto` / `fs` only. No `npm install` needed.
- **Storage: `data.json` on disk** (JSON file store, created automatically on first write). Chosen over SQLite because it needs no native module and no dependency — the whole server is one file. Good for a small game; if the player base grows, move to a real database later.
- Files: `server.js` (the whole server), `data.json` (created at runtime — do not commit real player data), `CLIENT_INTEGRATION.md` (how the game calls this API).

## Run locally

```bash
node server.js
# Run For Your Apocalypse server listening on port 3000
# Health: http://localhost:3000/api/health
```

Change the port with the `PORT` environment variable:

```bash
PORT=8080 node server.js
```

Requires Node 18+ (`crypto.randomUUID` / `scryptSync`).

## API spec

Base URL locally: `http://localhost:3000`. All responses are JSON with `{ok: true/false, ...}`.

### GET /api/health

```bash
curl http://localhost:3000/api/health
# {"ok":true,"users":0,"ranking":0}
```

### POST /api/signup

```bash
curl -X POST http://localhost:3000/api/signup \
  -H 'Content-Type: application/json' \
  -d '{"nickname":"jackbe","password":"hunter2-choose-a-strong-one"}'
# 201 {"ok":true,"token":"<hex token>","user":{"id":"...","nickname":"jackbe","createdAt":"..."}}
```

Errors: `400` bad nickname/password, `409` nickname already taken.

### POST /api/login

```bash
curl -X POST http://localhost:3000/api/login \
  -H 'Content-Type: application/json' \
  -d '{"nickname":"jackbe","password":"hunter2-choose-a-strong-one"}'
# 200 {"ok":true,"token":"<hex token>","user":{...}}
```

Errors: `400` missing fields, `401` wrong nickname/password, `429` too many failed attempts.

Save the token (e.g. in the game's local storage) and send it as
`Authorization: Bearer <token>` on the endpoints below.

### POST /api/save — auth required

```bash
curl -X POST http://localhost:3000/api/save \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer <token>" \
  -d '{"save":{"coins":1250,"ownedSkins":["male-basic","angel-male"],"equippedSkin":"angel-male","class":"melee","weapon":"blue-sword","upgrades":{"hp":3,"attack":2,"defense":1,"moveSpeed":0,"attackSpeed":1,"crit":0},"worldProgress":{"forest":42,"sea":0},"bgmOwned":["battle-2"],"bgmEquipped":{"base":"base-1","battle":"battle-2"}}}'
# 200 {"ok":true,"save":{...sanitised save...}}
```

The server sanitises and caps every field. If the account already has a
class, the submitted class is ignored — class is fixed at first selection.

### GET /api/load — auth required

```bash
curl http://localhost:3000/api/load -H "Authorization: Bearer <token>"
# 200 {"ok":true,"user":{...},"save":{...} }   (save is null for a new account)
```

### POST /api/ranking/submit — auth required

```bash
curl -X POST http://localhost:3000/api/ranking/submit \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer <token>" \
  -d '{"mode":"endless","world":"forest","survivalSeconds":487,"kills":312,"stage":12}'
# 201 {"ok":true}
```

`mode` is `endless` (ranking mode) or `stages` (100-stage progression).

### GET /api/ranking — public

```bash
curl 'http://localhost:3000/api/ranking?mode=endless&world=forest&limit=10'
# 200 {"ok":true,"mode":"endless","ranking":[{"nickname":"jackbe","world":"forest","survivalSeconds":487,"kills":312,"stage":12,"date":"..."}]}
```

`mode` defaults to `endless`, `world` is an optional filter, `limit` is 1–100 (default 100).

## Deploy on Render (free tier) — user does this themselves

The server is a plain Node app with no build step, so it fits Render's free
Web Service tier. **Muse does not log in or deploy for you — do these steps
yourself in your own browser:**

1. Push this folder to a GitHub repo (e.g. `run-for-your-apocalypse-server`, public or private).
2. Go to https://dashboard.render.com → **New + → Web Service** → connect the repo.
3. Settings: **Runtime: Node**, **Build Command:** *(leave empty)*, **Start Command:** `node server.js`.
4. Free plan: pick the **Free** instance type. Note Render's free tier sleeps after inactivity and has limited hours — the first request after sleep takes ~30–60 s to wake up. The game client must handle that (see `CLIENT_INTEGRATION.md`: fall back to session-only storage while the server wakes).
5. After deploy, copy the service URL (e.g. `https://run-for-your-apocalypse-server.onrender.com`) and put it in the game's `SERVER_URL` config.
6. **Data warning:** Render free instances have an ephemeral filesystem — `data.json` is lost when the instance restarts/redeploys. That is fine for testing. For real persistent data, add a Render persistent disk (paid) or move storage to a managed database later. Do not treat free-tier data as permanent.
7. Set a `PORT` if needed — Render provides `PORT` automatically and the server already reads it.

## Local test results (2026-11-07, this machine)

Ran the server on port 3000 and exercised the full flow with curl:
signup → login → save → load → ranking submit → ranking list → health.
All steps passed; see the test log in the build report. Wrong-password login
correctly returned 401, and unauthenticated save/load correctly returned 401.

## What this server does NOT do

- No realtime multiplayer (out of scope — chosen scope is login + ranking + save).
- No password recovery by email (no email is collected; recovery = reset only, to be added with a verified flow if needed).
- No payment / cash shop (in-game coins only).
- No tracking of visitors' IPs or identifiers.
