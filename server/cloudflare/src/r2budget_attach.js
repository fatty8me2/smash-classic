// DM attachments (RetroHub Plan 4, lane p4-social): a screenshot, a challenge save state or a hack patch that one friend
// sends another. The DM row only carries a reference {id,name,size,sha,kind,expires}; the bytes live in R2 under
// saves/<sender>/a/<id> and are tracked in the R2Budget `files` table like every other object, so the global 7 GB guard,
// the weekly reconcile, the pending-upload TTL and the free deletes all keep working unchanged.
//
// FREE-TIER RULES (hard):
//   - 8 MB per file, 7-day TTL. Expired rows are deleted LAZILY: every attachment op (and nothing else) sweeps up to 8 expired
//     rows and returns their R2 keys to delete (free op). No cron, no alarm.
//   - Counted inside the sender's existing 50 MB account pool (recomputeUsage adds the live attachment bytes), plus its own
//     ceilings: 24 MB of live attachments per sender, 40 uploads per sender per rolling day, 8 recipients per file.
//   - One upload = 1 Class A op, one download = 1 Class B op, both reserved in the global budget before the R2 call.
//     An identical file (same sha) already sent by the same sender and still live is NOT uploaded again: the new
//     recipients are just added (zero R2 ops).
//   - Pool pressure: "full" refuses new attachments, "tight" only allows files up to 2 MB.
//   - Every op goes through enter(): REQ_BUDGET share, daily rows/reads/ms guard, revoked devices. The DO rows written
//     are metered by the usual d.q().
// Wire (all through the R2Budget DO, called by saves_v2.js and friends.js):
//   v2_attach_begin   {uid,dev,to:[uid],kind,name,sha,len}    -> {id,rkey,tok,mtime,expires} | {reuse:true,id,expires,...}
//   v2_attach_commit  {uid,id,size}                            -> {id,name,size,sha,kind,expires}
//   v2_attach_abort   {uid,id}
//   v2_attach_check   {id,from,to}   (UserHub, before it stores the DM) -> canonical {id,name,size,sha,kind,expires}
//   v2_attach_get     {uid,dev,id}                             -> {rkey,rawEtag,...} for the recipient only
import { enter, cfg, E, sec, markDead, recomputeUsage, rollDay, getAcct } from "./r2budget_v2.js";
import { HEX64, MB, poolState, secondsToUtcMidnight } from "./saves_pool.js";

export const ATTACH_MAX = 8 * MB;
export const ATTACH_TTL_S = 7 * 24 * 3600;
export const ATTACH_KINDS = ["shot", "state", "patch"];
export const ATTACH_MAX_TO = 8;
const UID_RE = /^[a-z2-7]{26}$/;
const ID_RE = /^[0-9a-f]{32}$/;
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
const J = (o) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
const limits = (d) => ({
  max: num(d.env.ATTACH_MAX, ATTACH_MAX), ttl: num(d.env.ATTACH_TTL_S, ATTACH_TTL_S),
  pool: num(d.env.ATTACH_POOL_MAX, 24 * MB), perDay: num(d.env.ATTACH_DAY_MAX, 40), tightMax: num(d.env.ATTACH_TIGHT_MAX, 2 * MB),
  sweep: num(d.env.ATTACH_SWEEP, 8),
});

export function initAttach(d) {
  const s = d.sql;
  s.exec(`CREATE TABLE IF NOT EXISTS attach (id TEXT PRIMARY KEY, uid TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL,
    sha TEXT NOT NULL, rkey TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL, live INTEGER NOT NULL DEFAULT 0)`);
  s.exec(`CREATE INDEX IF NOT EXISTS attach_uid ON attach(uid, sha)`);
  s.exec(`CREATE INDEX IF NOT EXISTS attach_exp ON attach(expires)`);
  s.exec(`CREATE TABLE IF NOT EXISTS attach_to (id TEXT NOT NULL, rcpt TEXT NOT NULL, PRIMARY KEY(id, rcpt))`);
}

export function cleanAttachName(raw) {
  const s = String(raw ?? "").replace(/[\p{C}\p{Zl}\p{Zp}\\/:*?"<>|]/gu, "").replace(/\s+/g, " ").trim();
  return Array.from(s).slice(0, 64).join("") || "file";
}

// Delete expired rows (and never-committed uploads older than an hour). Returns the R2 keys to delete. Bounded, lazy.
function sweep(d, nowS, dels, limit) {
  const rows = d.q(`SELECT id,uid,rkey FROM attach WHERE expires<=? OR (live=0 AND created<?) ORDER BY expires LIMIT ?`, nowS, nowS - 3600, limit);
  const touched = new Set();
  for (const r of rows) {
    markDead(d, r.rkey, nowS, dels);
    d.q(`DELETE FROM attach WHERE id=?`, r.id);
    d.q(`DELETE FROM attach_to WHERE id=?`, r.id);
    touched.add(r.uid);
  }
  for (const u of touched) recomputeUsage(d, u);
  return rows.length;
}
const withDels = (o, dels) => J(dels.length ? { ...o, dels } : o);
const meta = (r) => ({ id: r.id, name: r.name, size: r.size, sha: r.sha, kind: r.kind, expires: r.expires * 1000 });

function opBegin(d, q, now) {
  const e = enter(d, q, now, { write: true, cost: 4 }); if (e.res) return e.res;
  const { uid, a, c, nowS } = e;
  const L = limits(d);
  const dels = [];
  sweep(d, nowS, dels, L.sweep);
  const to = [...new Set(Array.isArray(q.to) ? q.to.filter((u) => typeof u === "string" && UID_RE.test(u) && u !== uid) : [])];
  if (!to.length || to.length > ATTACH_MAX_TO) return E(400, "bad-recipient");
  if (!ATTACH_KINDS.includes(q.kind)) return E(400, "bad-kind");
  if (!HEX64.test(q.sha || "")) return E(400, "bad-sha");
  const len = Number(q.len);
  if (!Number.isInteger(len) || len <= 0) return E(400, "bad-body", { why: "empty" });
  if (len > L.max) return E(413, "attachment-too-large", { max: L.max });
  const name = cleanAttachName(q.name);

  // same file already sent by this account and still live: just add recipients (zero R2 ops)
  const dup = d.q(`SELECT * FROM attach WHERE uid=? AND sha=? AND kind=? AND live=1 AND expires>? AND size=? LIMIT 1`, uid, q.sha, q.kind, nowS + 3600, len)[0];
  if (dup) {
    const have = new Set(d.q(`SELECT rcpt FROM attach_to WHERE id=?`, dup.id).map((r) => r.rcpt));
    for (const t of to) if (!have.has(t)) { if (have.size >= 16) return E(400, "bad-recipient", { why: "too-many" }); d.q(`INSERT OR IGNORE INTO attach_to(id,rcpt) VALUES(?,?)`, dup.id, t); have.add(t); }
    return withDels({ r: "ok", reuse: true, ...meta(dup) }, dels);
  }

  const cs = d.caps();
  const pstate = poolState(d.st.total, cs.storage, c.tight, c.full);
  if (pstate === "full") return E(507, "cloud-saves-full");
  if (pstate === "tight" && len > L.tightMax) return E(507, "attachment-pool-tight", { max: L.tightMax });
  if (d.st.total + len > cs.storage) return E(507, "cloud-saves-full");
  const live = d.q(`SELECT COALESCE(SUM(size),0) s, COUNT(*) n FROM attach WHERE uid=? AND expires>?`, uid, nowS)[0];
  if (live.s + len > L.pool) return E(507, "attachment-pool-full", { used: live.s, max: L.pool });
  const day = d.q(`SELECT COUNT(*) n FROM attach WHERE uid=? AND created>?`, uid, nowS - 86400)[0].n;
  if (day >= L.perDay) return E(429, "attachment-daily-limit", { retryAfter: secondsToUtcMidnight(now) });
  const used = recomputeUsage(d, uid).used;
  if (used + len > c.accountCap) return E(507, "quota-exceeded", { used, quota: c.accountCap });
  rollDay(d, a);
  if (a.a_ops + 1 > c.dayPuts) return E(429, "account-daily-limit", { retryAfter: secondsToUtcMidnight(now) });
  if (d.spend(1, 0)) return E(429, "cloud-saves-paused", { retryAfter: 3600 });
  d.q(`UPDATE accts SET a_ops=a_ops+1 WHERE uid=?`, uid);

  const id = crypto.randomUUID().replace(/-/g, "");
  const rkey = `saves/${uid}/a/${id}`;
  const tok = now * 1000 + Math.floor(Math.random() * 1000);
  const expires = nowS + L.ttl;
  d.q(`INSERT INTO files(rkey,uid,size,pend,pts) VALUES(?,?,0,?,?)`, rkey, uid, len, tok);
  d.adj(uid, len, 1);
  d.q(`INSERT INTO attach(id,uid,kind,name,size,sha,rkey,created,expires,live) VALUES(?,?,?,?,?,?,?,?,?,0)`, id, uid, q.kind, name, len, q.sha, rkey, nowS, expires);
  for (const t of to) d.q(`INSERT INTO attach_to(id,rcpt) VALUES(?,?)`, id, t);
  recomputeUsage(d, uid);
  return withDels({ r: "ok", id, rkey, tok, mtime: String(nowS), expires: expires * 1000 }, dels);
}

function opCommit(d, q, now) {
  d.roll();
  if (!ID_RE.test(q.id || "")) return E(400, "bad-body");
  const r = d.q(`SELECT * FROM attach WHERE id=? AND uid=?`, q.id, q.uid)[0];
  if (!r) return E(404, "not-found");
  d.q(`UPDATE attach SET live=1, size=? WHERE id=?`, Number.isInteger(q.size) && q.size > 0 ? q.size : r.size, q.id);
  recomputeUsage(d, q.uid);
  return J({ r: "ok", ...meta({ ...r, size: Number.isInteger(q.size) && q.size > 0 ? q.size : r.size }) });
}

function opAbort(d, q, now) {
  d.roll();
  if (!ID_RE.test(q.id || "")) return J({ r: "ok" });
  const r = d.q(`SELECT * FROM attach WHERE id=? AND uid=? AND live=0`, q.id, q.uid)[0];
  if (r) { d.q(`DELETE FROM attach WHERE id=?`, q.id); d.q(`DELETE FROM attach_to WHERE id=?`, q.id); recomputeUsage(d, q.uid); }
  return J({ r: "ok" });
}

// The UserHub of the sender asks before it stores a DM that carries an attachment: the metadata is taken from here, never from the client.
function opCheck(d, q, now) {
  d.roll();
  if (!ID_RE.test(q.id || "")) return E(400, "bad-body");
  const nowS = sec(now);
  const r = d.q(`SELECT * FROM attach WHERE id=? AND uid=? AND live=1`, q.id, q.from)[0];
  if (!r || r.expires <= nowS) return E(404, "attachment-gone");
  if (!UID_RE.test(q.to || "") || !d.q(`SELECT 1 x FROM attach_to WHERE id=? AND rcpt=?`, q.id, q.to)[0]) return E(403, "not-recipient");
  return J({ r: "ok", ...meta(r) });
}

function opGet(d, q, now) {
  const e = enter(d, q, now, { cost: 4 }); if (e.res) return e.res;
  const { uid, a, c, nowS } = e;
  if (!ID_RE.test(q.id || "")) return E(400, "bad-key");
  const dels = [];
  const r = d.q(`SELECT * FROM attach WHERE id=? AND live=1`, q.id)[0];
  // not found and "not yours" look the same: nobody learns that an id exists
  if (!r || !d.q(`SELECT 1 x FROM attach_to WHERE id=? AND rcpt=?`, q.id, uid)[0]) { sweep(d, nowS, dels, limits(d).sweep); return E(404, "not-found"); }
  if (r.expires <= nowS) { sweep(d, nowS, dels, limits(d).sweep); return E(410, "attachment-expired"); }
  const f = d.q(`SELECT etag,dead FROM files WHERE rkey=?`, r.rkey)[0];
  if (!f || !f.etag || f.dead != null) return E(404, "not-found");
  rollDay(d, a);
  if (a.b_ops + 1 > c.dayGets) return E(429, "account-daily-limit", { retryAfter: secondsToUtcMidnight(now) });
  if (d.spend(0, 1)) return E(429, "cloud-saves-paused", { retryAfter: 3600 });
  d.q(`UPDATE accts SET b_ops=b_ops+1 WHERE uid=?`, uid);
  return J({ r: "ok", rkey: r.rkey, rawEtag: f.etag, ...meta(r) });
}

export function attachHandle(d, q, now) {
  const nowS = sec(now);
  switch (q.op) {
    case "v2_attach_begin": return opBegin(d, q, now);
    case "v2_attach_commit": return opCommit(d, q, now);
    case "v2_attach_abort": return opAbort(d, q, now);
    case "v2_attach_check": return opCheck(d, q, now);
    case "v2_attach_get": return opGet(d, q, now);
    case "v2_attach_sweep": {   // the Worker confirms nothing here; a sweep only happens inside other attach ops
      const dels = []; sweep(d, nowS, dels, limits(d).sweep); return withDels({ r: "ok" }, dels);
    }
    // test hooks (BUDGET_TEST=1 only; the Worker never forwards them otherwise)
    case "test_v2_attach_age": d.q(`UPDATE attach SET expires=1 WHERE id=?`, q.id); return J({ r: "ok" });
    case "test_v2_attach_rows": return J({ r: "ok", attach: d.q(`SELECT id,uid,kind,size,live,expires FROM attach ORDER BY created`), to: d.q(`SELECT * FROM attach_to`),
      files: d.q(`SELECT rkey,size,dead FROM files WHERE rkey LIKE '%/a/%' ORDER BY rkey`), acct: getAcct(d, q.uid || "") });
    default: return null;
  }
}
