// Cloud saves v2 inside the R2Budget Durable Object (single global instance = quota authority).
// Spec: RetroHub/docs/CLOUD_SAVES_V2.md. Everything here is SYNCHRONOUS SQL (no awaits), so each op runs atomically
// with respect to every other op on the DO. The Worker (saves_v2.js) does the R2 I/O around these ops.
//
// Tables (all uid scoped; uid is always the authenticated account, usernames/PCs map to it elsewhere):
//   devices(uid,dev,name,first,last_seen)          max 8 per account
//   games(uid,gkey,played_at,device,pin,lease_*,rev)
//   vers(uid,gkey,path,ver,sha,size,stored,enc,mtime,dev,ts,class,rkey,state,prot)   state cur|prev|evicted
//   tickets(id,uid,exp,body)                       plan -> blob PUTs -> commit
// accts gains: vused vprot rev day a_ops b_ops v2 active. files gains: dead (blob/object deleted in R2 next).
// Blobs are content addressed per account: saves/<uid>/o/<plain sha>[.z]. They are rows of `files` too, so the
// weekly reconcile, st.total and the global storage guard keep working unchanged.

import {
  ACCOUNT_CAP, PROT_CAP, POOL_TIGHT, POOL_FULL, DAY_PUTS, DAY_GETS, IDLE_LARGE_DAYS, IDLE_ALL_DAYS, HEX64, DEV_RE, LEASE_SECS,
  CLASSES, classifyPath, isProtectedClass, keepVersions, splitV1Key, poolState, largeCap, pickEvictions, fairShare,
  globalEvictions, leaseHeld, secondsToUtcMidnight, cleanKey, cleanGame, cleanDeviceName,
} from "./saves_pool.js";

export const SCHEMA = 2;
export const MAX_BLOB = 16 * 1024 * 1024;
const TICKET_SECS = 600;
const B64_RE = /^[A-Za-z0-9+/]{1,4096}={0,2}$/;

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
let curD = null;   // the DO instance serving the current (synchronous) op, so ok replies can carry its pending R2 deletes
const J = (o) => {
  if (o.r === "ok" && curD && curD.pendingDels && curD.pendingDels.length && !o.dels) { o = { ...o, dels: curD.pendingDels }; curD.pendingDels = []; }
  return new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
};
const E = (status, code, extra = {}) => J({ r: "err", status, code, ...extra });
export const isBlobKey = (rkey) => /\/o\/[0-9a-f]{64}(\.z)?$/.test(rkey);
const blobKey = (uid, sha, enc) => `saves/${uid}/o/${sha}${enc === "deflate" ? ".z" : ""}`;
class Rollback extends Error { constructor(why, extra = {}) { super(why); this.why = why; this.extra = extra; } }

// ---- schema ----
export function initV2(d) {
  const s = d.sql;
  s.exec(`CREATE TABLE IF NOT EXISTS devices (uid TEXT NOT NULL, dev TEXT NOT NULL, name TEXT NOT NULL, first INTEGER NOT NULL, last_seen INTEGER NOT NULL, PRIMARY KEY(uid,dev))`);
  // devices a PC owner signed out from another PC (Settings > Account > Linked PCs). The account secret is shared by all its PCs,
  // so a revoked device id is refused (401 device-revoked) until that PC makes itself a new device id ("Sign in again").
  s.exec(`CREATE TABLE IF NOT EXISTS revoked (uid TEXT NOT NULL, dev TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(uid,dev))`);
  s.exec(`CREATE TABLE IF NOT EXISTS games (uid TEXT NOT NULL, gkey TEXT NOT NULL, played_at INTEGER NOT NULL DEFAULT 0, device TEXT NOT NULL DEFAULT '',
    pin INTEGER NOT NULL DEFAULT 0, lease_dev TEXT, lease_since INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0, rev INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(uid,gkey))`);
  s.exec(`CREATE TABLE IF NOT EXISTS vers (uid TEXT NOT NULL, gkey TEXT NOT NULL, path TEXT NOT NULL, ver INTEGER NOT NULL, sha TEXT NOT NULL, size INTEGER NOT NULL,
    stored INTEGER NOT NULL, enc TEXT NOT NULL DEFAULT 'none', mtime INTEGER NOT NULL DEFAULT 0, dev TEXT NOT NULL DEFAULT '', ts INTEGER NOT NULL DEFAULT 0,
    class TEXT NOT NULL, rkey TEXT, state TEXT NOT NULL, prot INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(uid,gkey,path,ver))`);
  s.exec(`CREATE INDEX IF NOT EXISTS vers_rkey ON vers(uid,rkey)`);
  s.exec(`CREATE TABLE IF NOT EXISTS tickets (id TEXT PRIMARY KEY, uid TEXT NOT NULL, exp INTEGER NOT NULL, body TEXT NOT NULL)`);
  const cur = s.exec(`SELECT v FROM meta WHERE k='schema'`).toArray()[0];
  if (!cur || Number(cur.v) < SCHEMA) {      // migration tag: one-time column adds on the pre-v2 tables
    const add = (t, def) => { try { s.exec(`ALTER TABLE ${t} ADD COLUMN ${def}`); } catch { /* already there */ } };
    for (const c of ["vused INTEGER NOT NULL DEFAULT 0", "vprot INTEGER NOT NULL DEFAULT 0", "rev INTEGER NOT NULL DEFAULT 0", "day TEXT NOT NULL DEFAULT ''",
      "a_ops INTEGER NOT NULL DEFAULT 0", "b_ops INTEGER NOT NULL DEFAULT 0", "v2 INTEGER NOT NULL DEFAULT 0", "active INTEGER NOT NULL DEFAULT 0"]) add("accts", c);
    add("files", "dead INTEGER");
    s.exec(`INSERT INTO meta(k,v) VALUES('schema',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, String(SCHEMA));
  }
}

// ---- config / small helpers ----
const cfg = (d) => ({
  accountCap: num(d.env.ACCOUNT_CAP, ACCOUNT_CAP), protCap: num(d.env.PROT_CAP, PROT_CAP),
  tight: num(d.env.POOL_TIGHT, POOL_TIGHT), full: num(d.env.POOL_FULL, POOL_FULL),
  dayPuts: num(d.env.DAY_PUT_MAX, DAY_PUTS), dayGets: num(d.env.DAY_GET_MAX, DAY_GETS),
  maxVers: num(d.env.MAX_VERS, 4000), maxPaths: num(d.env.MAX_PATHS, 600), maxGames: num(d.env.MAX_GAMES, 300),
});
const poolOf = (d, c) => {
  const storage = d.caps().storage;
  return { state: poolState(d.st.total, storage, c.tight, c.full), frac: storage > 0 ? d.st.total / storage : 1, storage };
};
const sec = (now) => Math.floor(now / 1000);
const uuid = () => crypto.randomUUID().replace(/-/g, "");

function getAcct(d, uid) {
  let a = d.q(`SELECT * FROM accts WHERE uid=?`, uid)[0];
  if (!a) { d.q(`INSERT INTO accts(uid,used,n) VALUES(?,0,0)`, uid); a = d.q(`SELECT * FROM accts WHERE uid=?`, uid)[0]; }
  return a;
}
function rollDay(d, a) {
  if (a.day !== d.st.day) { d.q(`UPDATE accts SET day=?, a_ops=0, b_ops=0 WHERE uid=?`, d.st.day, a.uid); a.day = d.st.day; a.a_ops = 0; a.b_ops = 0; }
}
function liveRef(d, uid, rkey) { return d.q(`SELECT 1 FROM vers WHERE uid=? AND rkey=? AND state<>'evicted' LIMIT 1`, uid, rkey).length > 0; }
function blobSize(d, rkey) { const r = d.q(`SELECT size FROM files WHERE rkey=?`, rkey)[0]; return r ? r.size : 0; }

// Mark an R2 object as dead (index row kept until the Worker confirms the delete with v2_del_done).
function markDead(d, rkey, nowS, dels) {
  d.q(`UPDATE files SET dead=? WHERE rkey=? AND dead IS NULL AND pend IS NULL`, nowS, rkey);
  dels.push(rkey);
}
function freeIfUnref(d, uid, rkey, nowS, dels) {
  if (!rkey || liveRef(d, uid, rkey)) return 0;
  const sz = blobSize(d, rkey);
  markDead(d, rkey, nowS, dels);
  return sz;
}

function recomputeUsage(d, uid) {
  const rows = d.q(`SELECT rkey, MAX(stored) s, MAX(prot) p FROM vers WHERE uid=? AND state<>'evicted' AND rkey IS NOT NULL GROUP BY rkey`, uid);
  let used = 0, prot = 0;
  for (const r of rows) { used += r.s; if (r.p) prot += r.s; }
  d.q(`UPDATE accts SET vused=?, vprot=? WHERE uid=?`, used, prot, uid);
  return { used, prot };
}
function bumpRev(d, uid) {
  d.q(`UPDATE accts SET rev=rev+1 WHERE uid=?`, uid);
  return d.q(`SELECT rev FROM accts WHERE uid=?`, uid)[0].rev;
}
function touchGame(d, uid, gkey, rev, fields = {}) {
  d.q(`INSERT INTO games(uid,gkey,played_at,device,rev) VALUES(?,?,0,'',?) ON CONFLICT(uid,gkey) DO UPDATE SET rev=excluded.rev`, uid, gkey, rev);
  if (fields.played_at != null) d.q(`UPDATE games SET played_at=MAX(played_at,?) WHERE uid=? AND gkey=?`, fields.played_at, uid, gkey);
  if (fields.device != null) d.q(`UPDATE games SET device=? WHERE uid=? AND gkey=?`, fields.device, uid, gkey);
}
function devNames(d, uid) {
  const m = new Map();
  for (const r of d.q(`SELECT dev,name FROM devices WHERE uid=?`, uid)) m.set(r.dev, r.name);
  return m;
}
function seen(d, uid, dev, nowS) {
  if (dev) d.q(`UPDATE devices SET last_seen=? WHERE uid=? AND dev=? AND last_seen<?`, nowS, uid, dev, nowS - 60);
}

// ---- common entry: flags, saves request share, daily guard, v1 conversion ----
function enter(d, q, now, o = {}) {
  d.roll();
  if (d.env.SAVES_V2 === "0") return { res: E(503, "cloud-saves-disabled") };
  const cap = num(d.env.DAILY_REQ_CAP, 100_000) * 0.35;      // saves get at most 35% of the daily request units
  if (d.st.su_day !== d.st.day) { d.st.su_day = d.st.day; d.st.su = 0; }
  d.st.su = (d.st.su || 0) + (o.cost ?? 3); d.mark();
  if (!o.status && d.st.su > cap) return { res: E(429, "cloud-saves-busy-today", { retryAfter: 3600 }) };
  if (!o.status && d.over()) return { res: E(429, "cloud-saves-busy-today", { retryAfter: 3600 }) };
  if (o.write && d.locked(now)) return { res: E(409, "busy", { retryAfter: 5 }) };
  const uid = q.uid;
  if (q.dev && d.q(`SELECT 1 x FROM revoked WHERE uid=? AND dev=?`, uid, q.dev)[0]) return { res: E(401, "device-revoked") };
  let a = getAcct(d, uid);
  if (!a.v2) a = migrate(d, a, now);
  return { uid, a, c: cfg(d), nowS: sec(now) };
}

// ---- v1 -> v2 conversion (zero R2 ops) ----
function migrate(d, a, now) {
  const uid = a.uid, nowS = sec(now), c = cfg(d);
  const rows = d.q(`SELECT rkey,size,sha,mtime FROM files WHERE uid=? AND etag IS NOT NULL AND pend IS NULL AND dead IS NULL`, uid);
  const prefix = `saves/${uid}/`;
  const rev = a.rev + 1;
  d.ctx.storage.transactionSync(() => {
    for (const r of rows) {
      if (isBlobKey(r.rkey)) continue;
      const key = r.rkey.slice(prefix.length);
      const { gkey, path } = splitV1Key(key);
      const cls = classifyPath(path, r.size), prot = isProtectedClass(cls, r.size) ? 1 : 0;
      const mt = Number(r.mtime) || 0;
      d.q(`INSERT OR IGNORE INTO vers(uid,gkey,path,ver,sha,size,stored,enc,mtime,dev,ts,class,rkey,state,prot) VALUES(?,?,?,1,?,?,?,'none',?,'',?,?,?,'cur',?)`,
        uid, gkey, path, r.sha || "0".repeat(64), r.size, r.size, mt, nowS, cls, r.rkey, prot);
      d.q(`INSERT INTO games(uid,gkey,played_at,rev) VALUES(?,?,?,?) ON CONFLICT(uid,gkey) DO UPDATE SET played_at=MAX(played_at,excluded.played_at)`, uid, gkey, mt, rev);
    }
    d.q(`UPDATE accts SET v2=1, rev=?, active=? WHERE uid=?`, rev, nowS, uid);
  });
  a.v2 = 1; a.rev = rev;
  const u = recomputeUsage(d, uid);
  // old 200 MB accounts against the new caps: large items go (least recently played first), protected data stays
  const dels = [];
  const p = poolOf(d, c);
  const lc = largeCap(p.state, u.prot, c.accountCap, p.frac);
  const need = Math.max(u.used - c.accountCap, u.used - u.prot - lc);
  if (need > 0) makeRoom(d, uid, need, null, nowS, dels, [], rev);
  recomputeUsage(d, uid);
  d.pendingDels = (d.pendingDels || []).concat(dels);
  return getAcct(d, uid);
}

// ---- eviction ----
function largeItems(d, uid) {
  return d.q(`SELECT v.gkey game, v.path, v.class cls, v.mtime, v.stored, COALESCE(g.played_at,0) playedAt, COALESCE(g.pin,0) pin
    FROM vers v LEFT JOIN games g ON g.uid=v.uid AND g.gkey=v.gkey WHERE v.uid=? AND v.state='cur' AND v.prot=0 AND v.rkey IS NOT NULL`, uid);
}
// Turn the newest row of a path into a tombstone ("evicted": bytes gone, row kept so the client knows why).
function evictPath(d, uid, gkey, path, nowS, dels) {
  const rows = d.q(`SELECT ver,rkey FROM vers WHERE uid=? AND gkey=? AND path=? ORDER BY ver DESC`, uid, gkey, path);
  if (!rows.length) return 0;
  d.q(`DELETE FROM vers WHERE uid=? AND gkey=? AND path=? AND ver<>?`, uid, gkey, path, rows[0].ver);
  d.q(`UPDATE vers SET state='evicted', rkey=NULL WHERE uid=? AND gkey=? AND path=? AND ver=?`, uid, gkey, path, rows[0].ver);
  let freed = 0;
  for (const rk of new Set(rows.map((r) => r.rkey).filter(Boolean))) freed += freeIfUnref(d, uid, rk, nowS, dels);
  return freed;
}
function makeRoom(d, uid, need, protectGame, nowS, dels, evictedOut, rev) {
  let left = need;
  for (let pass = 0; pass < 3 && left > 0; pass++) {
    const { picked } = pickEvictions(largeItems(d, uid), left, protectGame);
    if (!picked.length) break;
    let freed = 0;
    for (const it of picked) {
      freed += evictPath(d, uid, it.game, it.path, nowS, dels);
      evictedOut.push({ game: it.game, path: it.path });
      touchGame(d, uid, it.game, rev);
    }
    left -= freed;
  }
  recomputeUsage(d, uid);
  return left <= 0;
}

// ---- entries for the wire ----
function wireVer(r, names) {
  return { ver: r.ver, sha: r.sha, size: r.size, stored: r.stored, enc: r.enc, mtime: r.mtime, dev: r.dev, devName: names.get(r.dev) || "", ts: r.ts, class: r.class };
}
function curEntry(r, names) { return r ? { ...wireVer(r, names), cloud: r.state === "evicted" ? "evicted" : "synced" } : null; }

function accountBlock(d, uid, a, c) {
  const p = poolOf(d, c);
  const cs = d.caps();
  return {
    used: a.vused, protUsed: a.vprot, cap: c.accountCap, protCap: c.protCap,
    largeCap: largeCap(p.state, a.vprot, c.accountCap, p.frac),
    devices: d.q(`SELECT COUNT(*) n FROM devices WHERE uid=?`, uid)[0].n,
    pool: p.state, paused: d.over() || d.st.a >= cs.a || d.st.b >= cs.b,
  };
}

// ---- ops ----
function opStatus(d, q, now) {
  const e = enter(d, q, now, { status: true, cost: 2 }); if (e.res) return e.res;
  return J({ r: "ok", rev: e.a.rev, account: accountBlock(d, e.uid, e.a, e.c), limits: { maxBlob: MAX_BLOB, planFiles: 200, putsPerDay: e.c.dayPuts, getsPerDay: e.c.dayGets } });
}

function opManifest(d, q, now) {
  const e = enter(d, q, now, { cost: 2 }); if (e.res) return e.res;
  const { uid, a, c, nowS } = e;
  const since = Number.isFinite(Number(q.since)) && q.since !== "" && q.since != null ? Number(q.since) : -1;
  const gfilter = q.game ? cleanGame(q.game) : null;
  if (q.game && !gfilter) return E(400, "bad-key");
  const full = since < 0 || since > a.rev;
  const names = devNames(d, uid);
  let games = d.q(`SELECT * FROM games WHERE uid=?${gfilter ? " AND gkey=?" : ""}${full ? "" : " AND rev>?"} ORDER BY gkey`, ...[uid, ...(gfilter ? [gfilter] : []), ...(full ? [] : [since])]);
  const vrows = d.q(`SELECT * FROM vers WHERE uid=?${gfilter ? " AND gkey=?" : ""} ORDER BY gkey,path,ver DESC`, ...[uid, ...(gfilter ? [gfilter] : [])]);
  const byGame = new Map();
  for (const r of vrows) { if (!byGame.has(r.gkey)) byGame.set(r.gkey, new Map()); const m = byGame.get(r.gkey); if (!m.has(r.path)) m.set(r.path, []); m.get(r.path).push(r); }
  const out = {};
  for (const g of games) {
    const files = {};
    for (const [path, rows] of byGame.get(g.gkey) || []) {
      const live = rows.filter((r) => r.state !== "evicted");
      files[path] = { cur: rows[0].ver, cloud: rows[0].state === "evicted" ? "evicted" : "synced", vers: live.map((r) => wireVer(r, names)) };
    }
    out[g.gkey] = { playedAt: g.played_at, device: names.get(g.device) || "", pin: !!g.pin, rev: g.rev, files };
    if (g.lease_dev && g.lease_until > nowS) out[g.gkey].lease = { dev: g.lease_dev, name: names.get(g.lease_dev) || "", since: g.lease_since, until: g.lease_until };
  }
  if (a.active < nowS - 86400) d.q(`UPDATE accts SET active=? WHERE uid=?`, nowS, uid);
  seen(d, uid, q.dev, nowS);
  return J({ r: "ok", rev: a.rev, full, account: accountBlock(d, uid, a, c), games: out });
}

function opDevice(d, q, now) {
  const e = enter(d, q, now, { write: false, cost: 2 }); if (e.res) return e.res;
  const { uid, nowS } = e;
  const b = q.body || {};
  if (typeof b.dev !== "string" || !DEV_RE.test(b.dev)) return E(400, "bad-body");
  const name = cleanDeviceName(b.name);
  const have = d.q(`SELECT dev FROM devices WHERE uid=? AND dev=?`, uid, b.dev)[0];
  if (have) d.q(`UPDATE devices SET name=?, last_seen=? WHERE uid=? AND dev=?`, name, nowS, uid, b.dev);
  else {
    const all = d.q(`SELECT dev,last_seen FROM devices WHERE uid=? ORDER BY last_seen ASC`, uid);
    if (all.length >= 8) {
      if (all[0].last_seen > nowS - 86400) return E(403, "device-limit", { max: 8 });   // all eight active in the last day
      d.q(`DELETE FROM devices WHERE uid=? AND dev=?`, uid, all[0].dev);
      d.q(`UPDATE games SET lease_dev=NULL, lease_until=0 WHERE uid=? AND lease_dev=?`, uid, all[0].dev);
    }
    d.q(`INSERT INTO devices(uid,dev,name,first,last_seen) VALUES(?,?,?,?,?)`, uid, b.dev, name, nowS, nowS);
  }
  const devices = d.q(`SELECT dev,name,first,last_seen FROM devices WHERE uid=? ORDER BY first`, uid).map((r) => ({ dev: r.dev, name: r.name, first: r.first, lastSeen: r.last_seen }));
  return J({ r: "ok", devices });
}

const MAX_REVOKED = 64;   // remembered revoked device ids per account (oldest forgotten first)
const devList = (d, uid, cur) => d.q(`SELECT dev,name,first,last_seen FROM devices WHERE uid=? ORDER BY first, rowid`, uid)
  .map((r) => ({ dev: r.dev, name: r.name, first: r.first, lastSeen: r.last_seen, current: r.dev === cur }));

// GET /saves/v2/devices: the PCs on this account (name, last seen). One cheap read; the hub asks once when Settings > Account opens.
function opDevices(d, q, now) {
  const e = enter(d, q, now, { cost: 2 }); if (e.res) return e.res;
  seen(d, e.uid, q.dev, e.nowS);
  return J({ r: "ok", devices: devList(d, e.uid, q.dev), max: 8 });
}

// POST /saves/v2/device/revoke {dev}: sign another PC out. The calling PC (X-RH-Device) can never revoke itself.
function opDeviceRevoke(d, q, now) {
  const e = enter(d, q, now, { write: false, cost: 2 }); if (e.res) return e.res;
  const { uid, nowS } = e;
  const b = q.body || {};
  if (!q.dev || !DEV_RE.test(q.dev)) return E(400, "bad-device");
  if (typeof b.dev !== "string" || !DEV_RE.test(b.dev)) return E(400, "bad-body");
  if (b.dev === q.dev) return E(400, "cannot-revoke-self");
  if (!d.q(`SELECT 1 x FROM devices WHERE uid=? AND dev=?`, uid, b.dev)[0]) return E(404, "not-found");
  d.ctx.storage.transactionSync(() => {
    d.q(`DELETE FROM devices WHERE uid=? AND dev=?`, uid, b.dev);
    d.q(`UPDATE games SET lease_dev=NULL, lease_until=0 WHERE uid=? AND lease_dev=?`, uid, b.dev);
    d.q(`INSERT OR REPLACE INTO revoked(uid,dev,at) VALUES(?,?,?)`, uid, b.dev, nowS);
    d.q(`DELETE FROM revoked WHERE uid=? AND dev NOT IN (SELECT dev FROM revoked WHERE uid=? ORDER BY at DESC, dev LIMIT ?)`, uid, uid, MAX_REVOKED);
  });
  return J({ r: "ok", devices: devList(d, uid, q.dev) });
}

// ---- plan ----
function parsePlan(b) {
  if (!b || typeof b !== "object") return null;
  const game = cleanGame(b.game);
  if (!game || b.mode !== "rw" || !Array.isArray(b.files) || b.files.length > 200) return null;
  const played = Number(b.played_at);
  if (!Number.isFinite(played) || played < 0) return null;
  const seenPaths = new Set(), files = [];
  for (const f of b.files) {
    if (!f || typeof f !== "object") return null;
    const path = cleanKey(f.path, false);
    const size = Number(f.size), stored = Number(f.stored), mtime = Number(f.mtime), base = f.base == null ? 0 : Number(f.base);
    if (!path || seenPaths.has(path) || typeof f.sha !== "string" || !HEX64.test(f.sha)) return null;
    if (![size, stored, mtime, base].every((n) => Number.isInteger(n) && n >= 0)) return null;
    const enc = f.enc == null ? "none" : f.enc;
    if (enc !== "none" && enc !== "deflate") return null;
    if (enc === "none" && stored !== size) return null;
    seenPaths.add(path);
    files.push({ path, sha: f.sha, size, stored, enc, mtime, base });
  }
  return { game, played, files };
}

function curRow(d, uid, gkey, path) {
  return d.q(`SELECT * FROM vers WHERE uid=? AND gkey=? AND path=? ORDER BY ver DESC LIMIT 1`, uid, gkey, path)[0] || null;
}

function opPlan(d, q, now) {
  const e = enter(d, q, now, { write: true }); if (e.res) return e.res;
  const { uid, a, c, nowS } = e;
  const P = parsePlan(q.body);
  if (!P) return E(400, "bad-plan");
  rollDay(d, a);
  const names = devNames(d, uid);
  const pool = poolOf(d, c);
  const lcap = largeCap(pool.state, a.vprot, c.accountCap, pool.frac);
  const counts = d.q(`SELECT (SELECT COUNT(*) FROM vers WHERE uid=?) v, (SELECT COUNT(DISTINCT gkey||'/'||path) FROM vers WHERE uid=?) p, (SELECT COUNT(*) FROM games WHERE uid=?) g,
    (SELECT COUNT(*) FROM games WHERE uid=? AND gkey=?) hg`, uid, uid, uid, uid, P.game)[0];
  const outs = P.files.map((f) => ({ path: f.path, f, cls: classifyPath(f.path, f.size) }));
  let newPaths = 0;
  const results = [], accepted = [], uploads = new Set();
  const evictable = largeItems(d, uid).filter((i) => i.game !== P.game).reduce((s, i) => s + i.stored, 0);
  let evictLeft = evictable, runUsed = a.vused, runProt = a.vprot, runLarge = a.vused - a.vprot;
  let protSkips = 0, other = 0;
  // protected first, then large newest first
  const order = [...outs].sort((x, y) => {
    const px = isProtectedClass(x.cls, x.f.size) ? 0 : 1, py = isProtectedClass(y.cls, y.f.size) ? 0 : 1;
    return px - py || y.f.mtime - x.f.mtime;
  });
  const resMap = new Map();
  for (const o of order) {
    const f = o.f, prot = isProtectedClass(o.cls, f.size);
    const cur = curRow(d, uid, P.game, f.path);
    const res = { path: f.path, class: o.cls };
    resMap.set(f.path, res);
    if (cur && cur.state !== "evicted" && cur.sha === f.sha) { Object.assign(res, { action: "same", ver: cur.ver }); other++; continue; }
    if ((cur ? cur.ver : 0) !== f.base) { Object.assign(res, { action: "conflict", current: curEntry(cur, names) }); other++; continue; }
    if (f.stored > MAX_BLOB) { Object.assign(res, { action: "skip", reason: "too-large" }); other++; continue; }
    if (!cur) {
      if (counts.p + newPaths >= c.maxPaths) { Object.assign(res, { action: "skip", reason: "too-many-files" }); other++; continue; }
      newPaths++;
    }
    const rkey = blobKey(uid, f.sha, f.enc);
    const row = d.q(`SELECT size,etag,pend,dead FROM files WHERE rkey=?`, rkey)[0];
    const exists = !!(row && row.etag && row.pend == null && row.dead == null);
    const refd = exists && liveRef(d, uid, rkey);
    const stored = exists ? row.size : f.stored;
    const added = refd || uploads.has(rkey) ? 0 : stored;   // bytes this file adds to the account
    if (prot) {
      let need = runUsed + added - c.accountCap;
      if (runProt + added > c.protCap || need > evictLeft) {
        Object.assign(res, { action: "skip", reason: "too-big-protected" }); protSkips++; continue;
      }
      if (need > 0) { evictLeft -= need; runUsed -= need; runLarge -= need; }
    } else {
      if (pool.state === "full") { Object.assign(res, { action: "skip", reason: "over-cap" }); other++; continue; }
      const need = Math.max(runUsed + added - c.accountCap, runLarge + added - lcap, 0);
      if (need > evictLeft || added > c.accountCap) { Object.assign(res, { action: "skip", reason: "over-cap" }); other++; continue; }
      if (need > 0) { evictLeft -= need; runUsed -= need; runLarge -= need; }
    }
    runUsed += added; if (prot) runProt += added; else runLarge += added;
    const act = exists || uploads.has(rkey) ? "have" : "upload";
    if (act === "upload") uploads.add(rkey);
    Object.assign(res, { action: act, sha: f.sha, stored, enc: rkey.endsWith(".z") ? "deflate" : "none" });
    accepted.push({ path: f.path, sha: f.sha, size: f.size, stored, enc: res.enc, mtime: f.mtime, cls: o.cls, base: f.base, rkey, st: act });
  }
  results.push(...P.files.map((f) => resMap.get(f.path)));
  if (protSkips && !other && !accepted.length) return E(507, "too-big-protected", { files: results });
  if (!counts.hg && counts.g >= c.maxGames && accepted.length) return E(507, "too-many-files", { max: c.maxGames });
  if (counts.v + accepted.length > c.maxVers) return E(507, "too-many-files", { max: c.maxVers });
  // global + per-account guards for the blobs that still have to travel
  const upN = uploads.size;
  if (upN) {
    const cs = d.caps();
    let bytes = 0;
    for (const x of accepted) if (x.st === "upload") bytes += x.stored;
    if (a.a_ops + upN > c.dayPuts) return E(429, "account-daily-limit", { retryAfter: secondsToUtcMidnight(now) });
    if (d.st.a + upN > cs.a) return E(429, "cloud-saves-paused", { retryAfter: 3600 });
    if (d.st.total + bytes > cs.storage) return E(507, "cloud-saves-full");
  }
  let ticket = null;
  if (accepted.length) {
    d.q(`DELETE FROM tickets WHERE exp<?`, nowS);
    ticket = uuid() + uuid().slice(0, 8);
    d.q(`INSERT INTO tickets(id,uid,exp,body) VALUES(?,?,?,?)`, ticket, uid, nowS + TICKET_SECS, JSON.stringify({ game: P.game, played: P.played, items: accepted }));
  }
  seen(d, uid, q.dev, nowS);
  return J({ r: "ok", rev: a.rev, ticket, expires: ticket ? nowS + TICKET_SECS : 0, files: results, account: { used: a.vused, pool: pool.state } });
}

// ---- blob upload (begin; commit/abort reuse put_commit / put_abort) ----
function opBlobBegin(d, q, now) {
  const e = enter(d, q, now, { write: true, cost: 4 }); if (e.res) return e.res;
  const { uid, a, c, nowS } = e;
  if (!HEX64.test(q.sha || "") || !/^[A-Za-z0-9]{16,80}$/.test(q.ticket || "")) return E(400, "bad-sha");
  const t = d.q(`SELECT * FROM tickets WHERE id=? AND uid=?`, q.ticket, uid)[0];
  if (!t || t.exp < nowS) return E(409, "ticket-expired");
  const body = JSON.parse(t.body);
  const item = body.items.find((i) => i.sha === q.sha);
  if (!item) return E(400, "bad-sha", { why: "not-in-ticket" });
  const row = d.q(`SELECT * FROM files WHERE rkey=?`, item.rkey)[0];
  if (row && row.dead != null) return E(409, "busy", { retryAfter: 5 });
  if (row && row.pend != null) { d.expirePending(now); const r2 = d.q(`SELECT * FROM files WHERE rkey=?`, item.rkey)[0]; if (r2 && r2.pend != null) return E(409, "busy", { retryAfter: 5 }); }
  const row2 = d.q(`SELECT * FROM files WHERE rkey=?`, item.rkey)[0];
  if (row2 && row2.etag) return J({ r: "unchanged", size: row2.size });
  if (q.len !== item.stored) return E(400, "bad-body", { why: "size-mismatch", expected: item.stored });
  const cs = d.caps();
  rollDay(d, a);
  if (a.a_ops + 1 > c.dayPuts) return E(429, "account-daily-limit", { retryAfter: secondsToUtcMidnight(now) });
  if (d.st.total + q.len > cs.storage) return E(507, "cloud-saves-full");
  if (d.spend(1, 0)) return E(429, "cloud-saves-paused", { retryAfter: 3600 });
  d.q(`UPDATE accts SET a_ops=a_ops+1 WHERE uid=?`, uid);
  const tok = now * 1000 + Math.floor(Math.random() * 1000);
  if (row2) d.q(`UPDATE files SET pend=?, pts=? WHERE rkey=?`, q.len, tok, item.rkey);
  else d.q(`INSERT INTO files(rkey,uid,size,pend,pts) VALUES(?,?,0,?,?)`, item.rkey, uid, q.len, tok);
  d.adj(uid, q.len, row2 ? 0 : 1);
  return J({ r: "ok", rkey: item.rkey, tok, mtime: String(nowS) });
}

// ---- commit ----
function applyItem(d, uid, gkey, it, dev, nowS, keep, dels) {
  const prot = isProtectedClass(it.cls, it.size) ? 1 : 0;
  const rows = d.q(`SELECT ver,rkey,state FROM vers WHERE uid=? AND gkey=? AND path=? ORDER BY ver DESC`, uid, gkey, it.path);
  const ver = (rows[0] ? rows[0].ver : 0) + 1;
  const before = liveRef(d, uid, it.rkey);
  d.q(`DELETE FROM vers WHERE uid=? AND gkey=? AND path=? AND state='evicted'`, uid, gkey, it.path);
  d.q(`UPDATE vers SET state='prev' WHERE uid=? AND gkey=? AND path=? AND state='cur'`, uid, gkey, it.path);
  d.q(`INSERT INTO vers(uid,gkey,path,ver,sha,size,stored,enc,mtime,dev,ts,class,rkey,state,prot) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'cur',?)`,
    uid, gkey, it.path, ver, it.sha, it.size, it.stored, it.enc, it.mtime, dev, nowS, it.cls, it.rkey, prot);
  const L = keep ?? keepVersions(!!prot);
  const all = d.q(`SELECT ver,rkey FROM vers WHERE uid=? AND gkey=? AND path=? ORDER BY ver DESC`, uid, gkey, it.path);
  let freed = 0;
  if (all.length > L) {
    const cut = all[L - 1].ver;
    const dropped = all.slice(L);
    d.q(`DELETE FROM vers WHERE uid=? AND gkey=? AND path=? AND ver<?`, uid, gkey, it.path, cut);
    for (const rk of new Set(dropped.map((r) => r.rkey).filter(Boolean))) freed += freeIfUnref(d, uid, rk, nowS, dels);
  }
  return { ver, prot, added: before ? 0 : it.stored, freed };
}

function opCommit(d, q, now) {
  const e = enter(d, q, now, { write: true }); if (e.res) return e.res;
  const { uid, c, nowS } = e;
  if (!/^[A-Za-z0-9]{16,80}$/.test(q.ticket || "")) return E(400, "bad-body");
  const t = d.q(`SELECT * FROM tickets WHERE id=? AND uid=?`, q.ticket, uid)[0];
  if (!t || t.exp < nowS) return E(409, "ticket-expired");
  const body = JSON.parse(t.body);
  if (body.done) return J({ r: "ok", ...body.done, replay: true });
  const gkey = body.game;
  let a = getAcct(d, uid);
  const names = devNames(d, uid);
  const dels = [], evicted = [], results = [];
  const items = [...body.items].sort((x, y) => {
    const px = isProtectedClass(x.cls, x.size) ? 0 : 1, py = isProtectedClass(y.cls, y.size) ? 0 : 1;
    return px - py || y.mtime - x.mtime;
  });
  const rev = a.rev + 1;
  let applied = 0;
  for (const it of items) {
    const cur = curRow(d, uid, gkey, it.path);
    if (cur && cur.state !== "evicted" && cur.sha === it.sha) { results.push({ path: it.path, ver: cur.ver, cloud: "synced", unchanged: true }); continue; }
    if ((cur ? cur.ver : 0) !== it.base) { results.push({ path: it.path, cloud: "conflict", current: curEntry(cur, names) }); continue; }
    const brow = d.q(`SELECT size,etag,pend,dead FROM files WHERE rkey=?`, it.rkey)[0];
    if (!brow || !brow.etag || brow.pend != null || brow.dead != null) { results.push({ path: it.path, cloud: "missing", reason: "blob-missing" }); continue; }
    const prot = isProtectedClass(it.cls, it.size);
    const pool = poolOf(d, c);
    if (!prot && pool.state === "full") { results.push({ path: it.path, cloud: "skipped", reason: "over-cap" }); continue; }
    it.stored = brow.size; it.enc = it.rkey.endsWith(".z") ? "deflate" : "none";
    let done = null;
    for (let attempt = 0; attempt < 2 && !done; attempt++) {
      a = getAcct(d, uid);
      const lc = largeCap(pool.state, a.vprot, c.accountCap, pool.frac);
      const mine = [];
      try {
        done = d.ctx.storage.transactionSync(() => {
          const r = applyItem(d, uid, gkey, it, q.dev || "", nowS, null, mine);
          const used = a.vused + r.added - r.freed, protU = a.vprot + (r.prot ? r.added - r.freed : 0);
          if (r.prot && protU > c.protCap) throw new Rollback("too-big-protected");
          if (!r.prot && used - protU > lc) throw new Rollback("over-cap", { need: used - protU - lc });
          if (used > c.accountCap) throw new Rollback(r.prot ? "too-big-protected" : "over-cap", { need: used - c.accountCap });
          d.q(`UPDATE accts SET vused=?, vprot=? WHERE uid=?`, used, protU, uid);
          return { ...r, mine };
        });
      } catch (err) {
        if (!(err instanceof Rollback)) throw err;
        const need = err.extra.need || 0;
        if (attempt === 0 && need > 0) { makeRoom(d, uid, need, gkey, nowS, dels, evicted, rev); continue; }   // evict others, retry once
        results.push({ path: it.path, cloud: "skipped", reason: err.why });
        break;
      }
    }
    if (done) { dels.push(...done.mine); applied++; results.push({ path: it.path, ver: done.ver, cloud: "synced" }); }
  }
  // enforcement: shrink this account's large pool to the pool state's cap, then global pressure
  a = getAcct(d, uid);
  const pool = poolOf(d, c);
  const lc = largeCap(pool.state, a.vprot, c.accountCap, pool.frac);
  if (a.vused - a.vprot > lc) makeRoom(d, uid, a.vused - a.vprot - lc, gkey, nowS, dels, evicted, rev);
  if (pool.state === "full") globalPressure(d, c, uid, gkey, nowS, dels, rev);
  recomputeUsage(d, uid);
  touchGame(d, uid, gkey, rev, { played_at: Math.min(body.played, nowS + 86400), device: q.dev || "" });
  if (applied || evicted.length) d.q(`UPDATE accts SET rev=?, active=? WHERE uid=?`, rev, nowS, uid);
  else d.q(`UPDATE accts SET active=? WHERE uid=?`, nowS, uid);
  seen(d, uid, q.dev, nowS);
  gcOrphans(d, uid, nowS, dels);
  idleSweep(d, c, nowS, dels);
  const out = { rev: applied || evicted.length ? rev : a.rev, results, evicted };
  if (!results.some((r) => r.cloud === "missing")) {   // a commit with missing blobs can be retried after the upload
    body.done = out;
    d.q(`UPDATE tickets SET body=? WHERE id=?`, JSON.stringify(body), q.ticket);
  }
  return J({ r: "ok", ...out, dels: outDels(d, uid, nowS, dels) });
}
function outDels(d, uid, nowS, dels) {
  const all = new Set([...dels, ...(d.pendingDels || []), ...oldDead(d, uid, nowS)]);
  d.pendingDels = [];
  return [...all];
}

function globalPressure(d, c, uid, gkey, nowS, dels, rev) {
  const storage = d.caps().storage;
  const pendingFree = dels.reduce((s, k) => s + blobSize(d, k), 0);
  const need = d.st.total - pendingFree - storage * c.full * 0.97;
  if (need <= 0) return;
  const nAcc = d.q(`SELECT COUNT(*) n FROM accts WHERE vused-vprot>0`)[0].n;
  const share = fairShare(storage, nAcc);
  const large = new Map(d.q(`SELECT uid,vused-vprot l FROM accts WHERE vused-vprot>?`, share).map((r) => [r.uid, r.l]));
  if (!large.size) return;
  const items = d.q(`SELECT v.uid uid, v.gkey game, v.path, v.class cls, v.mtime, v.stored, COALESCE(g.played_at,0) playedAt, COALESCE(g.pin,0) pin
    FROM vers v LEFT JOIN games g ON g.uid=v.uid AND g.gkey=v.gkey JOIN accts a ON a.uid=v.uid
    WHERE v.state='cur' AND v.prot=0 AND v.rkey IS NOT NULL AND a.vused-a.vprot>? ORDER BY COALESCE(g.played_at,0) ASC LIMIT 400`, share)
    .filter((i) => !(i.uid === uid && i.game === gkey));
  const { picked } = globalEvictions(items, large, share, need, 20);
  const touched = new Set();
  for (const it of picked) {
    evictPath(d, it.uid, it.game, it.path, nowS, dels);
    d.q(`INSERT INTO games(uid,gkey,rev) VALUES(?,?,0) ON CONFLICT(uid,gkey) DO NOTHING`, it.uid, it.game);
    touched.add(it.uid);
  }
  for (const u of touched) {
    const r = bumpRev(d, u);
    for (const it of picked) if (it.uid === u) d.q(`UPDATE games SET rev=? WHERE uid=? AND gkey=?`, r, u, it.game);
    recomputeUsage(d, u);
  }
}

// Blobs no version references any more (a crashed commit, an abandoned ticket) are collected after an hour.
function gcOrphans(d, uid, nowS, dels) {
  const rows = d.q(`SELECT rkey FROM files f WHERE f.uid=? AND f.rkey LIKE ? AND f.dead IS NULL AND f.pend IS NULL AND f.etag IS NOT NULL AND CAST(f.mtime AS INTEGER)<?
    AND NOT EXISTS (SELECT 1 FROM vers v WHERE v.uid=f.uid AND v.rkey=f.rkey AND v.state<>'evicted') AND NOT EXISTS (SELECT 1 FROM tickets t WHERE t.uid=f.uid AND t.exp>? AND instr(t.body, f.rkey)>0) LIMIT 20`,
    uid, `saves/${uid}/o/%`, nowS - 3600, nowS);
  for (const r of rows) markDead(d, r.rkey, nowS, dels);
}
function oldDead(d, uid, nowS) {   // delete confirmations that never arrived
  return d.q(`SELECT rkey FROM files WHERE uid=? AND dead IS NOT NULL AND dead<? LIMIT 20`, uid, nowS - 120).map((r) => r.rkey);
}

// Inactivity: large items of accounts idle 90 days go when the pool is tight/full, everything after 24 months.
export function idleSweep(d, c, nowS, dels, force = false) {
  if (!force && d.st.idle_at && nowS - d.st.idle_at < 3600) return;
  d.st.idle_at = nowS; d.mark();
  const p = poolOf(d, c);
  let budget = 200;
  const dayS = 86400;
  if (p.state !== "ok") {
    const idle = d.q(`SELECT uid FROM accts WHERE v2=1 AND active>0 AND active<? AND vused-vprot>0 LIMIT 50`, nowS - (num(d.env.IDLE_LARGE_DAYS, IDLE_LARGE_DAYS) * dayS));
    for (const r of idle) {
      if (budget <= 0) break;
      const items = largeItems(d, r.uid).slice(0, budget);
      if (!items.length) continue;
      const rev = bumpRev(d, r.uid);
      for (const it of items) { evictPath(d, r.uid, it.game, it.path, nowS, dels); touchGame(d, r.uid, it.game, rev); budget--; }
      recomputeUsage(d, r.uid);
    }
  }
  const dead = d.q(`SELECT uid FROM accts WHERE v2=1 AND active>0 AND active<? LIMIT 20`, nowS - (num(d.env.IDLE_ALL_DAYS, IDLE_ALL_DAYS) * dayS));
  for (const r of dead) removeAll(d, r.uid, nowS, dels);
}
function removeAll(d, uid, nowS, dels) {
  for (const v of d.q(`SELECT DISTINCT rkey FROM vers WHERE uid=? AND rkey IS NOT NULL`, uid)) markDead(d, v.rkey, nowS, dels);
  d.q(`DELETE FROM vers WHERE uid=?`, uid); d.q(`DELETE FROM games WHERE uid=?`, uid); d.q(`DELETE FROM devices WHERE uid=?`, uid); d.q(`DELETE FROM revoked WHERE uid=?`, uid);
  d.q(`DELETE FROM tickets WHERE uid=?`, uid);
  d.q(`UPDATE accts SET vused=0, vprot=0, rev=rev+1 WHERE uid=?`, uid);
}

// ---- blob download ----
function opBlobGet(d, q, now) {
  const e = enter(d, q, now, { cost: 4 }); if (e.res) return e.res;
  const { uid, a, c } = e;
  const g = cleanGame(q.game), path = cleanKey(q.path, false);
  if (!g || !path) return E(400, "bad-key");
  const ver = q.ver != null && q.ver !== "" ? Number(q.ver) : null;
  if (ver != null && !Number.isInteger(ver)) return E(400, "bad-key");
  const row = ver == null ? d.q(`SELECT * FROM vers WHERE uid=? AND gkey=? AND path=? AND state IN ('cur','evicted') ORDER BY ver DESC LIMIT 1`, uid, g, path)[0]
    : d.q(`SELECT * FROM vers WHERE uid=? AND gkey=? AND path=? AND ver=?`, uid, g, path, ver)[0];
  if (!row) return E(404, "not-found");
  if (row.state === "evicted" || !row.rkey) return E(404, "not-found", { evicted: true });
  const f = d.q(`SELECT etag,size,dead FROM files WHERE rkey=?`, row.rkey)[0];
  if (!f || !f.etag || f.dead != null) return E(404, "not-found");
  rollDay(d, a);
  if (a.b_ops + 1 > c.dayGets) return E(429, "account-daily-limit", { retryAfter: secondsToUtcMidnight(now) });
  if (d.spend(0, 1)) return E(429, "cloud-saves-paused", { retryAfter: 3600 });
  d.q(`UPDATE accts SET b_ops=b_ops+1 WHERE uid=?`, uid);
  return J({ r: "ok", rkey: row.rkey, rawEtag: f.etag, sha: row.sha, size: row.size, stored: row.stored, enc: row.enc, ver: row.ver, mtime: row.mtime });
}

// ---- restore ----
function opRestore(d, q, now) {
  const e = enter(d, q, now, { write: true }); if (e.res) return e.res;
  const { uid, a, nowS } = e;
  const b = q.body || {};
  const g = cleanGame(b.game), path = cleanKey(b.path, false);
  if (!g || !path || !Number.isInteger(b.ver) || !Number.isInteger(b.base ?? 0)) return E(400, "bad-body");
  const names = devNames(d, uid);
  const cur = curRow(d, uid, g, path);
  if ((cur ? cur.ver : 0) !== (b.base ?? 0)) return E(412, "conflict", { current: curEntry(cur, names) });
  const src = d.q(`SELECT * FROM vers WHERE uid=? AND gkey=? AND path=? AND ver=?`, uid, g, path, b.ver)[0];
  if (!src || src.state === "evicted" || !src.rkey) return E(404, "not-found");
  const dels = [];
  const rev = a.rev + 1;
  const it = { path, sha: src.sha, size: src.size, stored: src.stored, enc: src.enc, mtime: src.mtime, cls: src.class, rkey: src.rkey };
  d.ctx.storage.transactionSync(() => { applyItem(d, uid, g, it, q.dev || "", nowS, null, dels); });
  recomputeUsage(d, uid);
  d.q(`UPDATE accts SET rev=? WHERE uid=?`, rev, uid);
  touchGame(d, uid, g, rev);
  const nv = curRow(d, uid, g, path);
  return J({ r: "ok", rev, ver: nv.ver, dels: outDels(d, uid, nowS, dels) });
}

// ---- pin / remove ----
function opGame(d, q, now) {
  const e = enter(d, q, now, { write: true }); if (e.res) return e.res;
  const { uid, a, nowS } = e;
  const b = q.body || {};
  const g = cleanGame(b.game);
  if (!g || (b.pin != null && typeof b.pin !== "boolean") || (b.remove != null && typeof b.remove !== "boolean")) return E(400, "bad-body");
  const row = d.q(`SELECT * FROM games WHERE uid=? AND gkey=?`, uid, g)[0];
  if (!row) return E(404, "not-found");
  const rev = a.rev + 1, dels = [];
  if (b.remove) {
    for (const v of d.q(`SELECT DISTINCT rkey FROM vers WHERE uid=? AND gkey=? AND rkey IS NOT NULL`, uid, g)) markDead(d, v.rkey, nowS, dels);
    d.q(`DELETE FROM vers WHERE uid=? AND gkey=?`, uid, g);
    d.q(`UPDATE games SET pin=0, lease_dev=NULL, lease_until=0, rev=? WHERE uid=? AND gkey=?`, rev, uid, g);
  } else if (b.pin != null) {
    d.q(`UPDATE games SET pin=?, rev=? WHERE uid=? AND gkey=?`, b.pin ? 1 : 0, rev, uid, g);
  }
  recomputeUsage(d, uid);
  d.q(`UPDATE accts SET rev=? WHERE uid=?`, rev, uid);
  const u = d.q(`SELECT vused,vprot FROM accts WHERE uid=?`, uid)[0];
  return J({ r: "ok", rev, used: u.vused, dels: outDels(d, uid, nowS, dels) });
}

// ---- leases ----
function opLease(d, q, now) {
  const e = enter(d, q, now, { cost: 2, write: false }); if (e.res) return e.res;
  const { uid, a, c, nowS } = e;
  const b = q.body || {};
  const g = cleanGame(b.game);
  const act = q.action || "take";
  if (!g || !q.dev || !DEV_RE.test(q.dev)) return E(400, "bad-device");
  if (act === "take" && b.mode !== "rw" && b.mode !== "readonly") return E(400, "bad-body");
  const names = devNames(d, uid);
  const row = d.q(`SELECT * FROM games WHERE uid=? AND gkey=?`, uid, g)[0];
  const held = (r) => ({ dev: r.lease_dev, name: names.get(r.lease_dev) || "", since: r.lease_since, until: r.lease_until });
  if (act === "take" && b.mode === "readonly") return J({ r: "ok", lease: false });
  if (act === "release") {
    if (row && row.lease_dev === q.dev) { d.q(`UPDATE games SET lease_dev=NULL, lease_until=0, lease_since=0 WHERE uid=? AND gkey=?`, uid, g); }
    return J({ r: "ok" });
  }
  if (act === "beat") {
    if (!row) return E(404, "not-found");
    if (leaseHeld(row, q.dev, nowS)) return E(423, "lease-held", { held: held(row) });   // someone took over
    d.q(`UPDATE games SET lease_dev=?, lease_since=CASE WHEN lease_dev=? THEN lease_since ELSE ? END, lease_until=? WHERE uid=? AND gkey=?`, q.dev, q.dev, nowS, nowS + LEASE_SECS, uid, g);
    return J({ r: "ok", until: nowS + LEASE_SECS });
  }
  if (row && leaseHeld(row, q.dev, nowS) && !b.take) return E(423, "lease-held", { held: held(row) });
  if (!row && d.q(`SELECT COUNT(*) n FROM games WHERE uid=?`, uid)[0].n >= c.maxGames) return E(507, "too-many-files", { max: c.maxGames });
  const rev = bumpRev(d, uid);
  d.q(`INSERT INTO games(uid,gkey,played_at,device,lease_dev,lease_since,lease_until,rev) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(uid,gkey) DO UPDATE SET lease_dev=excluded.lease_dev, lease_since=excluded.lease_since, lease_until=excluded.lease_until, played_at=MAX(played_at,excluded.played_at), device=excluded.device, rev=excluded.rev`,
    uid, g, nowS, q.dev, q.dev, nowS, nowS + LEASE_SECS, rev);
  seen(d, uid, q.dev, nowS);
  return J({ r: "ok", lease: true, until: nowS + LEASE_SECS, tookOver: !!(row && row.lease_dev && row.lease_dev !== q.dev && row.lease_until > nowS) });
}

// ---- v1 write-through for migrated accounts ----
export function v1Written(d, uid, rkey, size, sha, mtime, now) {
  if (isBlobKey(rkey)) return;
  const a = d.q(`SELECT v2,rev FROM accts WHERE uid=?`, uid)[0];
  if (!a || !a.v2) return;
  const nowS = sec(now), key = rkey.slice(`saves/${uid}/`.length), { gkey, path } = splitV1Key(key);
  const mt = Number(mtime) || 0;
  const it = { path, sha, size, stored: size, enc: "none", mtime: mt, cls: classifyPath(path, size), rkey };
  const dels = [];
  d.ctx.storage.transactionSync(() => { applyItem(d, uid, gkey, it, "", nowS, 1, dels); });
  recomputeUsage(d, uid);
  const rev = bumpRev(d, uid);
  touchGame(d, uid, gkey, rev, { played_at: mt });
  d.pendingDels = (d.pendingDels || []).concat(dels);
}
export function v1Deleted(d, uid, rkey, now) {
  if (isBlobKey(rkey)) return;
  const a = d.q(`SELECT v2 FROM accts WHERE uid=?`, uid)[0];
  if (!a || !a.v2) return;
  const row = d.q(`SELECT gkey,path FROM vers WHERE uid=? AND rkey=? AND state<>'evicted' LIMIT 1`, uid, rkey)[0];
  if (!row) return;
  const dels = [];
  const olds = d.q(`SELECT DISTINCT rkey FROM vers WHERE uid=? AND gkey=? AND path=? AND rkey IS NOT NULL AND rkey<>?`, uid, row.gkey, row.path, rkey);
  d.q(`DELETE FROM vers WHERE uid=? AND gkey=? AND path=?`, uid, row.gkey, row.path);
  for (const o of olds) freeIfUnref(d, uid, o.rkey, sec(now), dels);
  recomputeUsage(d, uid);
  touchGame(d, uid, row.gkey, bumpRev(d, uid));
  d.pendingDels = (d.pendingDels || []).concat(dels);
}
// v1 puts/gets/deletes on a migrated account obey the v2 account cap too. Returns true when the write must be refused.
export function v1OverCap(d, uid, len, oldSize) {
  const a = d.q(`SELECT v2,vused FROM accts WHERE uid=?`, uid)[0];
  return !!(a && a.v2 && a.vused + len - oldSize > cfg(d).accountCap);
}
export const v1Accounts = (d, uid) => !!(d.q(`SELECT v2 FROM accts WHERE uid=?`, uid)[0] || {}).v2;

// ---- bookkeeping ops ----
function opDelDone(d, q, now) {
  for (const rkey of Array.isArray(q.rkeys) ? q.rkeys.slice(0, 200) : []) {
    const row = d.q(`SELECT * FROM files WHERE rkey=?`, rkey)[0];
    if (row && row.dead != null && row.pend == null) {
      d.adj(row.uid, -row.size, -1);
      d.q(`DELETE FROM files WHERE rkey=?`, rkey);
    }
  }
  return J({ r: "ok" });
}

export function v2Handle(d, q, now) {
  curD = d;
  try { return v2Switch(d, q, now); } finally { curD = null; }
}
function v2Switch(d, q, now) {
  switch (q.op) {
    case "v2_status": return opStatus(d, q, now);
    case "v2_manifest": return opManifest(d, q, now);
    case "v2_device": return opDevice(d, q, now);
    case "v2_devices": return opDevices(d, q, now);
    case "v2_device_revoke": return opDeviceRevoke(d, q, now);
    case "v2_plan": return opPlan(d, q, now);
    case "v2_blob_begin": return opBlobBegin(d, q, now);
    case "v2_commit": return opCommit(d, q, now);
    case "v2_blob_get": return opBlobGet(d, q, now);
    case "v2_restore": return opRestore(d, q, now);
    case "v2_game": return opGame(d, q, now);
    case "v2_lease": return opLease(d, q, now);
    case "v2_del_done": return opDelDone(d, q, now);
    // test hooks (BUDGET_TEST=1 only; the Worker never forwards them otherwise)
    case "test_v2_active": d.q(`UPDATE accts SET active=? WHERE uid=?`, Number(q.active) || 0, q.uid); return J({ r: "ok" });
    case "test_v2_sweep": { const dels = []; idleSweep(d, cfg(d), sec(now), dels, true); return J({ r: "ok", dels }); }
    case "test_v2_acct": return J({ r: "ok", acct: getAcct(d, q.uid), vers: d.q(`SELECT gkey,path,ver,state,class,rkey,stored FROM vers WHERE uid=? ORDER BY gkey,path,ver`, q.uid),
      files: d.q(`SELECT rkey,size,dead FROM files WHERE uid=? ORDER BY rkey`, q.uid) });
    case "test_v2_age_blobs": d.q(`UPDATE files SET mtime='1' WHERE uid=? AND rkey LIKE '%/o/%'`, q.uid); return J({ r: "ok" });
    case "test_v2_total": d.st.total = Number(q.total) || 0; d.mark(); return J({ r: "ok" });
    case "test_v2_expire_ticket": d.q(`UPDATE tickets SET exp=0 WHERE uid=?`, q.uid); return J({ r: "ok" });
    case "test_v2_lease_expire": d.q(`UPDATE games SET lease_until=1 WHERE uid=?`, q.uid); return J({ r: "ok" });
    default: return null;
  }
}
