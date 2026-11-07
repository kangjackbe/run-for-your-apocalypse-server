// Run For Your Apocalypse — login + ranking + save server
// Node.js, zero external dependencies (built-in http / crypto / fs only).
// No npm install required. Data stored in data.json on disk (JSON file store).
// Run:  node server.js          (default port 3000, set PORT env to change)
// Test: curl http://localhost:3000/api/health
//
// Security notes:
// - Passwords are stored as salted scrypt hashes. Plaintext is NEVER stored.
// - Admin cannot read original passwords. Password recovery = reset only
//   (there is no "find my password" endpoint; a reset endpoint can be added
//   later with a verified reset flow).
// - Login returns a random token (not a JWT). Tokens expire after 30 days.
// - No IP addresses are logged or stored. No other users' personal data
//   is exposed: the public ranking list only shows nickname + score.
// - Ranking submissions are validated and capped (top 100 kept per query,
//   max 1000 entries stored total).

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_FILE = path.join(__dirname, 'data.json');
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_RANKING_STORED = 1000;
const MAX_RANKING_RETURNED = 100;

// ---- tiny JSON store -------------------------------------------------------
let db = { users: [], tokens: [], ranking: [] }; // users: {id,nickname,passHash,salt,createdAt,save}
// save: {coins,ownedSkins,equippedSkin,class,weapon,upgrades,worldProgress,bgmOwned,bgmEquipped,updatedAt}

function loadDb() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (raw && typeof raw === 'object') {
        db.users = Array.isArray(raw.users) ? raw.users : [];
        db.tokens = Array.isArray(raw.tokens) ? raw.tokens : [];
        db.ranking = Array.isArray(raw.ranking) ? raw.ranking : [];
      }
    }
  } catch (e) {
    console.error('Failed to load data.json, starting empty:', e.message);
  }
  // Drop expired tokens on load.
  const now = Date.now();
  db.tokens = db.tokens.filter((t) => t.expiresAt > now);
}

function saveDb() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE);
}

loadDb();

// ---- helpers ---------------------------------------------------------------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 200 * 1024) { // 200 KB cap
        req.destroy();
        reject(new Error('body too large'));
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function newToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.tokens.push({ token, userId, expiresAt: Date.now() + TOKEN_TTL_MS });
  // Keep token list bounded.
  if (db.tokens.length > 5000) db.tokens = db.tokens.slice(-5000);
  saveDb();
  return token;
}

function authUser(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/.exec(h);
  if (!m) return null;
  const t = db.tokens.find((x) => x.token === m[1]);
  if (!t || t.expiresAt <= Date.now()) return null;
  return db.users.find((u) => u.id === t.userId) || null;
}

function validNickname(n) {
  return typeof n === 'string' && n.trim().length >= 2 && n.trim().length <= 16;
}
function validPassword(p) {
  return typeof p === 'string' && p.length >= 4 && p.length <= 64;
}

// Simple in-memory login rate limit: max 10 failed attempts per nickname
// per 10 minutes. (Resets on server restart; good enough for a small game.)
const loginFails = new Map(); // nickname -> {count, firstAt}
function loginBlocked(nickname) {
  const e = loginFails.get(nickname);
  if (!e) return false;
  if (Date.now() - e.firstAt > 10 * 60 * 1000) { loginFails.delete(nickname); return false; }
  return e.count >= 10;
}
function recordLoginFail(nickname) {
  const now = Date.now();
  const e = loginFails.get(nickname);
  if (!e || now - e.firstAt > 10 * 60 * 1000) loginFails.set(nickname, { count: 1, firstAt: now });
  else e.count += 1;
}

// ---- save-data validation --------------------------------------------------
const CLASSES = ['melee', 'ranged', 'mid'];
const UPGRADE_KEYS = ['hp', 'attack', 'defense', 'moveSpeed', 'attackSpeed', 'crit'];

function sanitiseSave(input) {
  if (!input || typeof input !== 'object') return null;
  const out = {
    coins: 0, ownedSkins: [], equippedSkin: null, class: null, weapon: null,
    upgrades: { hp: 0, attack: 0, defense: 0, moveSpeed: 0, attackSpeed: 0, crit: 0 },
    worldProgress: {}, bgmOwned: [], bgmEquipped: {}, updatedAt: new Date().toISOString(),
  };
  if (Number.isFinite(input.coins)) out.coins = Math.max(0, Math.min(999999999, Math.floor(input.coins)));
  if (Array.isArray(input.ownedSkins)) out.ownedSkins = input.ownedSkins.filter((s) => typeof s === 'string').slice(0, 100);
  if (typeof input.equippedSkin === 'string') out.equippedSkin = input.equippedSkin.slice(0, 64);
  // Class is fixed at first selection: only accept it if the account has
  // no class yet, or it matches the stored one. Otherwise keep stored.
  if (typeof input.class === 'string' && CLASSES.includes(input.class)) out.class = input.class;
  if (typeof input.weapon === 'string') out.weapon = input.weapon.slice(0, 64);
  if (input.upgrades && typeof input.upgrades === 'object') {
    for (const k of UPGRADE_KEYS) {
      if (Number.isFinite(input.upgrades[k])) {
        out.upgrades[k] = Math.max(0, Math.min(100, Math.floor(input.upgrades[k])));
      }
    }
  }
  if (input.worldProgress && typeof input.worldProgress === 'object') {
    for (const [k, v] of Object.entries(input.worldProgress)) {
      if (typeof k === 'string' && k.length <= 32 && Number.isFinite(v)) {
        out.worldProgress[k] = Math.max(0, Math.min(100, Math.floor(v)));
      }
    }
  }
  if (Array.isArray(input.bgmOwned)) out.bgmOwned = input.bgmOwned.filter((s) => typeof s === 'string').slice(0, 50);
  if (input.bgmEquipped && typeof input.bgmEquipped === 'object') {
    for (const slot of ['base', 'battle']) {
      if (typeof input.bgmEquipped[slot] === 'string') out.bgmEquipped[slot] = input.bgmEquipped[slot].slice(0, 64);
    }
  }
  return out;
}

// Public view of a user (never includes passHash / salt).
function publicUser(u) {
  return { id: u.id, nickname: u.nickname, createdAt: u.createdAt };
}

// ---- routes ----------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (req.method === 'OPTIONS') { sendJson(res, 204, {}); return; }

  try {
    // GET /api/health
    if (req.method === 'GET' && p === '/api/health') {
      return sendJson(res, 200, { ok: true, users: db.users.length, ranking: db.ranking.length });
    }

    // POST /api/signup  {nickname, password}
    if (req.method === 'POST' && p === '/api/signup') {
      const b = await readBody(req);
      if (!validNickname(b.nickname)) return sendJson(res, 400, { ok: false, error: 'nickname must be 2-16 characters' });
      if (!validPassword(b.password)) return sendJson(res, 400, { ok: false, error: 'password must be 4-64 characters' });
      const nickname = b.nickname.trim();
      if (db.users.some((u) => u.nickname.toLowerCase() === nickname.toLowerCase())) {
        return sendJson(res, 409, { ok: false, error: 'nickname already taken' });
      }
      const salt = crypto.randomBytes(16).toString('hex');
      const user = {
        id: crypto.randomUUID(),
        nickname,
        passHash: hashPassword(b.password, salt),
        salt,
        createdAt: new Date().toISOString(),
        save: null,
      };
      db.users.push(user);
      const token = newToken(user.id);
      return sendJson(res, 201, { ok: true, token, user: publicUser(user) });
    }

    // POST /api/login  {nickname, password}
    if (req.method === 'POST' && p === '/api/login') {
      const b = await readBody(req);
      if (!validNickname(b.nickname) || !validPassword(b.password)) {
        return sendJson(res, 400, { ok: false, error: 'nickname and password required' });
      }
      const nickname = b.nickname.trim();
      if (loginBlocked(nickname)) {
        return sendJson(res, 429, { ok: false, error: 'too many failed attempts, try again later' });
      }
      const user = db.users.find((u) => u.nickname.toLowerCase() === nickname.toLowerCase());
      const ok = user && crypto.timingSafeEqual(
        Buffer.from(hashPassword(b.password, user.salt), 'hex'),
        Buffer.from(user.passHash, 'hex'),
      );
      if (!ok) {
        recordLoginFail(nickname);
        return sendJson(res, 401, { ok: false, error: 'wrong nickname or password' });
      }
      loginFails.delete(nickname);
      const token = newToken(user.id);
      return sendJson(res, 200, { ok: true, token, user: publicUser(user) });
    }

    // POST /api/save  (auth) {save: {...}}
    if (req.method === 'POST' && p === '/api/save') {
      const user = authUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'login required' });
      const b = await readBody(req);
      const clean = sanitiseSave(b.save);
      if (!clean) return sendJson(res, 400, { ok: false, error: 'save data required' });
      // Class lock-in: once set, it cannot change.
      if (user.save && user.save.class) clean.class = user.save.class;
      user.save = clean;
      saveDb();
      return sendJson(res, 200, { ok: true, save: user.save });
    }

    // GET /api/load  (auth)
    if (req.method === 'GET' && p === '/api/load') {
      const user = authUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'login required' });
      return sendJson(res, 200, { ok: true, user: publicUser(user), save: user.save });
    }

    // POST /api/ranking/submit  (auth) {mode, survivalSeconds, kills, stage, world}
    if (req.method === 'POST' && p === '/api/ranking/submit') {
      const user = authUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'login required' });
      const b = await readBody(req);
      const survivalSeconds = Number.isFinite(b.survivalSeconds) ? Math.max(0, Math.min(24 * 3600, Math.floor(b.survivalSeconds))) : 0;
      const kills = Number.isFinite(b.kills) ? Math.max(0, Math.min(1000000, Math.floor(b.kills))) : 0;
      const stage = Number.isFinite(b.stage) ? Math.max(0, Math.min(100, Math.floor(b.stage))) : 0;
      const world = typeof b.world === 'string' ? b.world.slice(0, 32) : 'forest';
      const mode = b.mode === 'endless' ? 'endless' : 'stages';
      if (survivalSeconds === 0 && kills === 0) {
        return sendJson(res, 400, { ok: false, error: 'nothing to record' });
      }
      db.ranking.push({
        id: crypto.randomUUID(), userId: user.id, nickname: user.nickname,
        mode, world, survivalSeconds, kills, stage, date: new Date().toISOString(),
      });
      // Keep only the best entries per (mode, world) is overkill; just cap total.
      db.ranking.sort((a, b) => (b.survivalSeconds - a.survivalSeconds) || (b.kills - a.kills));
      if (db.ranking.length > MAX_RANKING_STORED) db.ranking = db.ranking.slice(0, MAX_RANKING_STORED);
      saveDb();
      return sendJson(res, 201, { ok: true });
    }

    // GET /api/ranking?mode=endless&world=forest&limit=100  (public)
    if (req.method === 'GET' && p === '/api/ranking') {
      const mode = url.searchParams.get('mode') || 'endless';
      const world = url.searchParams.get('world') || '';
      const limit = Math.max(1, Math.min(MAX_RANKING_RETURNED, parseInt(url.searchParams.get('limit') || '100', 10) || 100));
      let list = db.ranking.filter((r) => r.mode === mode);
      if (world) list = list.filter((r) => r.world === world);
      list = list.slice(0, limit).map((r) => ({
        nickname: r.nickname, world: r.world, survivalSeconds: r.survivalSeconds,
        kills: r.kills, stage: r.stage, date: r.date,
      }));
      return sendJson(res, 200, { ok: true, mode, ranking: list });
    }

    return sendJson(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    console.error(e);
    return sendJson(res, 500, { ok: false, error: e.message || 'server error' });
  }
});

server.listen(PORT, () => {
  console.log(`Run For Your Apocalypse server listening on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/api/health`);
});
