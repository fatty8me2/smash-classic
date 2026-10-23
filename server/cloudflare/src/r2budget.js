// Global R2 free-tier budget guard + authoritative metadata index for cloud saves (src/saves.js).
//
// HARD RULE: cloud saves must never leave Cloudflare R2's free tier (10 GB-month storage, 1M Class A ops/month,
// 10M Class B ops/month, free egress). A SINGLE instance of this SQLite-backed Durable Object (id "global") sees
// every account's operation, so its counters are global. Hard caps sit at ~70% of the free tier:
//   storage 7 GB, Class A 700k / calendar month (UTC), Class B 7M / calendar month.
// (R2 pricing: Class A = PutObject, ListObjects, multipart...; Class B = GetObject, HeadObject; DeleteObject is free.)
//
// The index (table files) mirrors what is in the bucket, so listing, quota checks, preconditions and deletes need
// NO R2 call at all. Every R2 call the Worker does make is reserved here first (reserveB / put_begin). Accounting is
// optimistic and errs on the side of OVER-counting: a crashed upload leaves its bytes reserved (until the 5 minute
// pending expiry) and an op counted. A weekly reconcile (a few Class A list calls, only when the month is well within
// budget) re-syncs the index with the bucket. Callers must FAIL CLOSED when this DO errors.

import { DurableObject } from "cloudflare:workers";

const GB = 1024 * 1024 * 1024;
export const DEFAULT_CAPS = { storage: 7 * GB, a: 700_000, b: 7_000_000 };
const PENDING_TTL_MS = 5 * 60 * 1000;
const RECONCILE_EVERY_MS = 7 * 24 * 3600 * 1000;

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
const J = (o) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });

export class R2Budget extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS files (
      rkey TEXT PRIMARY KEY, uid TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0,
      etag TEXT, hetag TEXT, sha TEXT, mtime TEXT, pend INTEGER, pts INTEGER)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS files_uid ON files(uid)`);
  }

  caps() {
    const e = this.env;
    return { storage: num(e.BUDGET_STORAGE_MAX, DEFAULT_CAPS.storage), a: num(e.BUDGET_A_MAX, DEFAULT_CAPS.a), b: num(e.BUDGET_B_MAX, DEFAULT_CAPS.b) };
  }
  getMeta(k, d = 0) { const r = this.sql.exec(`SELECT v FROM meta WHERE k=?`, k).toArray()[0]; return r ? Number(r.v) : d; }
  setMeta(k, v) { this.sql.exec(`INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, k, String(v)); }
  getStr(k) { const r = this.sql.exec(`SELECT v FROM meta WHERE k=?`, k).toArray()[0]; return r ? r.v : ""; }
  setStr(k, v) { this.sql.exec(`INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, k, v); }

  month() {
    if (this.env.BUDGET_TEST === "1") { const m = this.getStr("test_month"); if (m) return m; }
    return new Date().toISOString().slice(0, 7);
  }
  // Roll the per-month counters over when the calendar month changes.
  rollMonth() {
    const m = this.month();
    if (this.getStr("month") !== m) { this.setStr("month", m); this.setMeta("a", 0); this.setMeta("b", 0); }
    return m;
  }
  total() { return this.getMeta("total", 0); }

  // Spend a/b ops if within the caps. Returns null when ok, else "paused".
  spend(a, b) {
    this.rollMonth();
    const c = this.caps();
    const ua = this.getMeta("a"), ub = this.getMeta("b");
    if (ua + a > c.a || ub + b > c.b) return "paused";
    if (a) this.setMeta("a", ua + a);
    if (b) this.setMeta("b", ub + b);
    return null;
  }

  eff(row) { return row ? (row.pend != null ? row.pend : row.size) : 0; }
  row(rkey) { return this.sql.exec(`SELECT * FROM files WHERE rkey=?`, rkey).toArray()[0] || null; }
  pub(row) { return { size: row.size, etag: row.hetag || row.etag, sha: row.sha || "", mtime: row.mtime || "0" }; }
  expirePending(now) {
    const stale = this.sql.exec(`SELECT * FROM files WHERE pend IS NOT NULL AND pts < ?`, now - PENDING_TTL_MS).toArray();
    for (const r of stale) this.abort(r.rkey);
  }
  abort(rkey) {
    const r = this.row(rkey);
    if (!r || r.pend == null) return;
    this.setMeta("total", Math.max(0, this.total() - (r.pend - r.size)));
    if (!r.etag) this.sql.exec(`DELETE FROM files WHERE rkey=?`, rkey);
    else this.sql.exec(`UPDATE files SET pend=NULL, pts=NULL WHERE rkey=?`, rkey);
  }

  async maybeReconcile() {
    const now = Date.now();
    const c = this.caps();
    const last = this.getMeta("last_reconcile_try");
    if (!last) { this.setMeta("last_reconcile_try", now); return; }   // fresh DO: first reconcile is a week away
    if (now - last < RECONCILE_EVERY_MS) return;
    if (this.getMeta("a") > c.a * 0.5 || this.getMeta("b") > c.b * 0.5) return;
    if (this.sql.exec(`SELECT 1 FROM files WHERE pend IS NOT NULL LIMIT 1`).toArray().length) return;
    this.setMeta("last_reconcile_try", now);          // set first: a failure is not retried in a loop
    if (!this.env.SAVES) return;
    const rows = [];
    let cursor, pages = 0;
    try {
      do {
        if (this.spend(1, 0)) return;
        const page = await this.env.SAVES.list({ prefix: "saves/", cursor, limit: 1000, include: ["customMetadata"] });
        pages++;
        for (const o of page.objects) {
          const uid = o.key.split("/")[1] || "";
          const cm = o.customMetadata || {};
          rows.push([o.key, uid, o.size, o.etag, o.httpEtag || o.etag, cm.sha || "", cm.mtime || "0"]);
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor && pages < 200);
    } catch { return; }
    if (cursor) return;                                // incomplete listing: keep the old index
    if (this.sql.exec(`SELECT 1 FROM files WHERE pend IS NOT NULL LIMIT 1`).toArray().length) return; // raced with an upload
    this.sql.exec(`DELETE FROM files`);
    let tot = 0;
    for (const r of rows) {
      this.sql.exec(`INSERT INTO files(rkey,uid,size,etag,hetag,sha,mtime) VALUES(?,?,?,?,?,?,?)`, ...r);
      tot += r[2];
    }
    this.setMeta("total", tot);
  }

  async fetch(request) {
    if (request.headers.get("x-rh-internal") !== "1") return new Response("no", { status: 403 });
    const q = await request.json();
    if (this.env.BUDGET_TEST === "1" && this.getStr("test_fail") === "1" && q.op !== "test_fail") throw new Error("budget test failure");
    const now = Date.now();
    const c = this.caps();
    const QUOTA = num(this.env.SAVES_QUOTA, 200 * 1024 * 1024);
    const MAXF = num(this.env.SAVES_MAX_FILES, 1500);

    switch (q.op) {
      case "list": {
        const files = this.sql.exec(`SELECT rkey,size,etag,hetag,sha,mtime FROM files WHERE uid=? AND etag IS NOT NULL ORDER BY rkey`, q.uid)
          .toArray().map((r) => ({ key: r.rkey.slice(`saves/${q.uid}/`.length), size: r.size, etag: r.hetag || r.etag, sha: r.sha || "", mtime: r.mtime || "0" }));
        return J({ r: "ok", files, used: files.reduce((s, f) => s + f.size, 0), quota: QUOTA });
      }
      case "get": {            // one Class B op (R2 get); the index supplies size/etag so no head is needed
        const row = this.row(q.rkey);
        if (!row || !row.etag) return J({ r: "none" });
        if (this.spend(0, 1)) return J({ r: "paused" });
        return J({ r: "ok", ...this.pub(row), rawEtag: row.etag });
      }
      case "put_begin": {
        this.expirePending(now);
        const row = this.row(q.rkey);
        const exists = !!(row && row.etag);
        if (row && row.pend != null) return J({ r: "busy" });
        if (q.ifNone === "*" && exists) return J({ r: "conflict", current: this.pub(row) });
        if (q.ifMatch && (!exists || (q.ifMatch !== row.etag && q.ifMatch !== row.hetag))) return J({ r: "conflict", current: exists ? this.pub(row) : null });
        if (exists && row.sha === q.sha && row.size === q.len) return J({ r: "unchanged", etag: row.hetag || row.etag });
        const old = exists ? row.size : 0;
        const used = this.sql.exec(`SELECT COALESCE(SUM(COALESCE(pend,size)),0) AS s, COUNT(*) AS n FROM files WHERE uid=?`, q.uid).toArray()[0];
        if (!exists && used.n >= MAXF) return J({ r: "toomany", max: MAXF });
        if (used.s - old + q.len > QUOTA) return J({ r: "quota", used: used.s, quota: QUOTA });
        if (this.total() + q.len - old > c.storage) return J({ r: "full" });
        if (this.spend(1, 0)) return J({ r: "paused" });
        await this.maybeReconcile();
        if (exists) this.sql.exec(`UPDATE files SET pend=?, pts=? WHERE rkey=?`, q.len, now, q.rkey);
        else this.sql.exec(`INSERT INTO files(rkey,uid,size,pend,pts) VALUES(?,?,0,?,?)`, q.rkey, q.uid, q.len, now);
        this.setMeta("total", this.total() + q.len - old);
        return J({ r: "ok", etag: exists ? row.etag : null });
      }
      case "put_commit":
        this.sql.exec(`UPDATE files SET size=?, pend=NULL, pts=NULL, etag=?, hetag=?, sha=?, mtime=? WHERE rkey=?`,
          q.size, q.etag, q.hetag, q.sha, q.mtime, q.rkey);
        return J({ r: "ok" });
      case "put_abort": this.abort(q.rkey); return J({ r: "ok" });
      case "del_check": {      // no R2 op; deletes stay possible even when the budget is exhausted (they free storage)
        const row = this.row(q.rkey);
        if (!row || !row.etag) return J({ r: "none" });
        if (q.ifMatch && q.ifMatch !== row.etag && q.ifMatch !== row.hetag) return J({ r: "conflict", current: this.pub(row) });
        return J({ r: "ok" });
      }
      case "del_commit": {
        const row = this.row(q.rkey);
        if (row) { this.setMeta("total", Math.max(0, this.total() - this.eff(row))); this.sql.exec(`DELETE FROM files WHERE rkey=?`, q.rkey); }
        return J({ r: "ok" });
      }
      case "status":
        this.rollMonth();
        return J({ r: "ok", month: this.month(), a: this.getMeta("a"), b: this.getMeta("b"), total: this.total(), caps: c });
      case "test_month": this.setStr("test_month", String(q.month || "")); return J({ r: "ok" });
      case "test_fail": this.setStr("test_fail", q.on ? "1" : ""); return J({ r: "ok" });
      default: return J({ r: "bad-op" });
    }
  }
}
