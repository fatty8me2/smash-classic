// Global R2 free-tier budget guard + authoritative metadata index for cloud saves (src/saves.js).
//
// HARD RULE: cloud saves must never leave Cloudflare's free tiers. R2: 10 GB-month storage, 1M Class A ops/month,
// 10M Class B ops/month. Durable Objects (free plan, SQLite): 100k rows written/day, 13,000 GB-s/day. A SINGLE
// instance of this DO (id "global") sees every account's operation. Hard caps sit at ~70% of the free tiers:
//   storage 7 GB, Class A 700k / UTC month, Class B 7M / UTC month, DO rows written 70k / UTC day.
// (R2 pricing: Class A = PutObject, ListObjects...; Class B = GetObject, HeadObject; DeleteObject is free.)
//
// The index (table files) mirrors the bucket, so list/quota/precondition/delete need NO R2 call. All counters live in
// ONE state row (a request writes at most one state row + one files row). There are no timers or alarms: the DO is
// only awake while a request runs, so it hibernates/evicts when idle (GB-s stays tiny).
//
// Accounting errs on OVER-counting. An upload is "pending" (files.pend/pts) between put_begin and put_commit. A
// pending row older than PENDING_TTL is aborted (bytes released) and the index marked dirty; if that upload's R2 put
// still completes later, put_commit re-applies the delta, so bytes are never untracked. A dirty index (or a weekly
// timer) triggers a reconcile (list of the bucket, a few Class A ops) while writes answer "busy".
// Callers must FAIL CLOSED when this DO errors.

import { DurableObject } from "cloudflare:workers";

const GB = 1024 * 1024 * 1024;
export const DEFAULT_CAPS = { storage: 7 * GB, a: 700_000, b: 7_000_000, rows: 70_000 };
const RECONCILE_EVERY_MS = 7 * 24 * 3600 * 1000;
const RECONCILE_MIN_GAP_MS = 3600 * 1000;
const RECONCILE_LOCK_MS = 120 * 1000;

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
    this.sql.exec(`CREATE INDEX IF NOT EXISTS files_pend ON files(pts) WHERE pend IS NOT NULL`);   // pending scans touch only pending rows
    this.sql.exec(`CREATE TABLE IF NOT EXISTS accts (uid TEXT PRIMARY KEY, used INTEGER NOT NULL, n INTEGER NOT NULL)`);
    const r = this.sql.exec(`SELECT v FROM meta WHERE k='st'`).toArray()[0];
    this.st = Object.assign({ month: "", day: "", a: 0, b: 0, total: 0, rows: 0, reads: 0, ms: 0, last_try: 0, dirty: 0, recent_expire: 0,
      lock_until: 0, test_month: "", test_day: "", test_fail: 0, test_commit_fail: 0 }, r ? JSON.parse(r.v) : {});
    this.stDirty = false;
  }
  // Every SQL statement goes through q(): the REAL rowsWritten / rowsRead are charged to the daily counters.
  q(sql, ...args) {
    const c = this.sql.exec(sql, ...args);
    const rows = c.toArray();
    this.st.reads += c.rowsRead; this.st.rows += c.rowsWritten;
    if (c.rowsWritten) this.mark();
    return rows;
  }
  save() {
    if (!this.stDirty) return;
    this.stDirty = false;
    const c = this.sql.exec(`INSERT INTO meta(k,v) VALUES('st',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, JSON.stringify(this.st));
    c.toArray(); this.st.rows += c.rowsWritten;     // counted in memory; persisted by the next save
  }
  mark() { this.stDirty = true; }

  caps() {
    const e = this.env;
    return { storage: num(e.BUDGET_STORAGE_MAX, DEFAULT_CAPS.storage), a: num(e.BUDGET_A_MAX, DEFAULT_CAPS.a),
      b: num(e.BUDGET_B_MAX, DEFAULT_CAPS.b), rows: num(e.DAILY_ROWS_MAX, DEFAULT_CAPS.rows),
      reads: num(e.DAILY_READS_MAX, 3_500_000), ms: num(e.DAILY_MS_MAX, 40_000_000) };
  }
  ttl() { return num(this.env.PENDING_TTL_MS, 15 * 60 * 1000); }

  // Roll the per-month / per-day counters when the UTC date changes.
  roll() {
    const iso = new Date().toISOString();
    const m = (this.env.BUDGET_TEST === "1" && this.st.test_month) || iso.slice(0, 7);
    const d = (this.env.BUDGET_TEST === "1" && this.st.test_day) || iso.slice(0, 10);
    if (this.st.month !== m) { this.st.month = m; this.st.a = 0; this.st.b = 0; this.mark(); }
    if (this.st.day !== d) { this.st.day = d; this.st.rows = 0; this.st.reads = 0; this.st.ms = 0; this.mark(); }
  }
  // Charge n estimated DO row writes. Returns true when the daily guard is already exhausted.
  over() {
    const c = this.caps();
    return this.st.rows >= c.rows || this.st.reads >= c.reads || this.st.ms >= c.ms;
  }
  // per-account totals kept in a tiny table so a put never scans the account's rows
  adj(uid, dBytes, dFiles) {
    this.st.total = Math.max(0, this.st.total + dBytes); this.mark();
    this.q(`INSERT INTO accts(uid,used,n) VALUES(?,MAX(0,?),MAX(0,?)) ON CONFLICT(uid) DO UPDATE SET used=MAX(0,used+?), n=MAX(0,n+?)`, uid, dBytes, dFiles, dBytes, dFiles);
  }
  // Spend a/b R2 ops if within the caps. Returns null when ok, else "paused".
  spend(a, b) {
    const c = this.caps();
    if (this.st.a + a > c.a || this.st.b + b > c.b) return "paused";
    this.st.a += a; this.st.b += b; this.mark();
    return null;
  }

  eff(row) { return row ? (row.pend != null ? row.pend : row.size) : 0; }
  row(rkey) { return this.q(`SELECT * FROM files WHERE rkey=?`, rkey)[0] || null; }
  pub(row) { return { size: row.size, etag: row.hetag || row.etag, sha: row.sha || "", mtime: row.mtime || "0" }; }
  abort(row) {
    if (!row || row.pend == null) return;
    this.adj(row.uid, -(row.pend - row.size), row.etag ? 0 : -1);
    if (!row.etag) this.q(`DELETE FROM files WHERE rkey=?`, row.rkey);
    else this.q(`UPDATE files SET pend=NULL, pts=NULL WHERE rkey=?`, row.rkey);
  }
  expirePending(now) {
    const stale = this.q(`SELECT * FROM files WHERE pend IS NOT NULL AND pts < ?`, (now - this.ttl()) * 1000);
    for (const r of stale) { this.abort(r); this.st.dirty = 1; this.st.recent_expire = now; }   // the upload may still land: reconcile will check
  }
  locked(now) { return this.st.lock_until > now; }

  // Rebuild the index from the bucket. Writes (put_begin/del_check) answer "busy" while st.lock_until is in the
  // future, and it only starts with no pending upload, so the listing cannot race a write.
  async maybeReconcile(now, force = false) {
    const c = this.caps();
    if (!this.st.last_try) { this.st.last_try = now; this.mark(); if (!force) return; }
    const due = force || (this.st.dirty && now - this.st.last_try > RECONCILE_MIN_GAP_MS) || now - this.st.last_try > RECONCILE_EVERY_MS;
    if (!due || !this.env.SAVES) return;
    if (now - this.st.recent_expire < this.ttl()) return;   // an expired upload may still be landing: wait it out
    if (this.st.a > c.a * 0.5 || this.st.b > c.b * 0.5) return;
    if (this.q(`SELECT 1 FROM files WHERE pend IS NOT NULL LIMIT 1`).length) return;
    this.st.last_try = now; this.st.lock_until = now + RECONCILE_LOCK_MS; this.mark(); this.save();
    const rows = [], t0 = Date.now();
    let cursor, pages = 0, done = false;
    try {
      do {
        if (this.spend(1, 0)) break;
        const page = await this.env.SAVES.list({ prefix: "saves/", cursor, limit: 1000, include: ["customMetadata"] });
        pages++;
        for (const o of page.objects) {
          const cm = o.customMetadata || {};
          rows.push([o.key, o.key.split("/")[1] || "", o.size, o.etag, o.httpEtag || o.etag, cm.sha || "", cm.mtime || "0"]);
        }
        cursor = page.truncated ? page.cursor : undefined;
        if (!cursor) done = true;
      } while (cursor && pages < 200);
    } catch { done = false; }
    const c2 = this.caps();
    if (done && (this.st.rows + 3 * rows.length > c2.rows * 0.9 || this.st.reads + 4 * rows.length > c2.reads * 0.9)) done = false;   // too costly today
    if (done) {
      const have = new Map(this.q(`SELECT rkey,etag FROM files`).map((r) => [r.rkey, r.etag]));
      let changed = false;
      for (const r of rows) {      // write only what differs: reconcile cost scales with drift, not with bucket size
        if (have.get(r[0]) === r[3]) { have.delete(r[0]); continue; }
        have.delete(r[0]); changed = true;
        this.q(`INSERT INTO files(rkey,uid,size,etag,hetag,sha,mtime) VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(rkey) DO UPDATE SET uid=excluded.uid, size=excluded.size, etag=excluded.etag, hetag=excluded.hetag,
          sha=excluded.sha, mtime=excluded.mtime, pend=NULL, pts=NULL`, ...r);
      }
      for (const k of have.keys()) { changed = true; this.q(`DELETE FROM files WHERE rkey=?`, k); }
      if (changed) {
        this.q(`DELETE FROM accts`);
        this.q(`INSERT INTO accts SELECT uid, SUM(size), COUNT(*) FROM files GROUP BY uid`);
      }
      this.st.total = rows.reduce((t, r) => t + r[2], 0); this.st.dirty = 0; this.mark();
    }
    this.st.ms += Date.now() - t0;
    this.st.lock_until = 0; this.mark(); this.save();
  }

  async fetch(request) {
    if (request.headers.get("x-rh-internal") !== "1") return new Response("no", { status: 403 });
    const q = await request.json();
    this.st.ms += num(this.env.EST_MS, 50);          // rough wall-time meter (persisted with the next state save)
    if (this.env.BUDGET_TEST === "1" && this.st.test_fail && q.op !== "test_fail") throw new Error("budget test failure");
    try { return await this.handle(q); } finally { this.save(); }
  }

  async handle(q) {
    const now = Date.now();
    this.roll();
    const c = this.caps();
    const QUOTA = num(this.env.SAVES_QUOTA, 200 * 1024 * 1024);
    const MAXF = num(this.env.SAVES_MAX_FILES, 1500);
    const today = () => this.over() ? J({ r: "busytoday" }) : null;

    switch (q.op) {
      case "list": {
        const files = this.q(`SELECT rkey,size,etag,hetag,sha,mtime FROM files WHERE uid=? AND etag IS NOT NULL ORDER BY rkey`, q.uid)
          .map((r) => ({ key: r.rkey.slice(`saves/${q.uid}/`.length), size: r.size, etag: r.hetag || r.etag, sha: r.sha || "", mtime: r.mtime || "0" }));
        return J({ r: "ok", files, used: files.reduce((s, f) => s + f.size, 0), quota: QUOTA });
      }
      case "get": {            // one Class B op (R2 get); the index supplies size/etag so no head is needed
        const row = this.row(q.rkey);
        if (!row || !row.etag) return J({ r: "none" });
        const t = today(); if (t) return t;
        if (this.spend(0, 1)) return J({ r: "paused" });
        this.mark();
        return J({ r: "ok", ...this.pub(row), rawEtag: row.etag });
      }
      case "put_begin": {
        if (this.locked(now)) return J({ r: "busy" });
        const t = today(); if (t) return t;
        this.expirePending(now);
        await this.maybeReconcile(now);
        if (this.locked(now)) return J({ r: "busy" });
        const row = this.row(q.rkey);
        const exists = !!(row && row.etag);
        if (row && row.pend != null) return J({ r: "busy" });
        if (q.ifNone === "*" && exists) return J({ r: "conflict", current: this.pub(row) });
        if (q.ifMatch && (!exists || (q.ifMatch !== row.etag && q.ifMatch !== row.hetag))) return J({ r: "conflict", current: exists ? this.pub(row) : null });
        if (exists && row.sha === q.sha && row.size === q.len) return J({ r: "unchanged", etag: row.hetag || row.etag });
        const old = exists ? row.size : 0;
        const ac = this.q(`SELECT used, n FROM accts WHERE uid=?`, q.uid)[0] || { used: 0, n: 0 };
        const used = { s: ac.used, n: ac.n };
        if (!exists && used.n >= MAXF) return J({ r: "toomany", max: MAXF });
        if (used.s - old + q.len > QUOTA) return J({ r: "quota", used: used.s, quota: QUOTA });
        if (this.st.total + q.len - old > c.storage) return J({ r: "full" });
        if (this.spend(1, 0)) return J({ r: "paused" });
        const tok = now * 1000 + Math.floor(Math.random() * 1000);
        if (exists) this.q(`UPDATE files SET pend=?, pts=? WHERE rkey=?`, q.len, tok, q.rkey);
        else this.q(`INSERT INTO files(rkey,uid,size,pend,pts) VALUES(?,?,0,?,?)`, q.rkey, q.uid, q.len, tok);
        this.adj(q.uid, q.len - old, exists ? 0 : 1);
        return J({ r: "ok", etag: exists ? row.etag : null, tok });
      }
      case "put_commit": {
        if (this.env.BUDGET_TEST === "1" && this.st.test_commit_fail > 0) { this.st.test_commit_fail--; this.mark(); throw new Error("commit test failure"); }
        const row = this.row(q.rkey);
        // Normal path (token matches): the pending size is already counted. Otherwise the pending expired or was
        // replaced while the R2 put still completed: re-apply the delta so the bytes are never untracked.
        if (!(row && row.pend != null && row.pts === q.tok) && (!row || row.pend == null)) {
          this.adj(q.uid, q.size - (row && row.etag ? row.size : 0), row ? 0 : 1);
        }
        if (row && row.pend != null && row.pts !== q.tok) {
          this.q(`UPDATE files SET size=?, etag=?, hetag=?, sha=?, mtime=? WHERE rkey=?`, q.size, q.etag, q.hetag, q.sha, q.mtime, q.rkey);
          this.st.dirty = 1;
        } else {
          this.q(`INSERT INTO files(rkey,uid,size,etag,hetag,sha,mtime) VALUES(?,?,?,?,?,?,?)
            ON CONFLICT(rkey) DO UPDATE SET size=excluded.size, etag=excluded.etag, hetag=excluded.hetag, sha=excluded.sha,
            mtime=excluded.mtime, pend=NULL, pts=NULL`, q.rkey, q.uid, q.size, q.etag, q.hetag, q.sha, q.mtime);
        }
        return J({ r: "ok" });
      }
      case "put_abort": {
        const row = this.row(q.rkey);
        if (row && row.pend != null && row.pts === q.tok) this.abort(row);
        if (q.unknown) { this.st.dirty = 1; this.mark(); }       // the object may exist without us knowing
        return J({ r: "ok" });
      }
      case "del_check": {      // no R2 op; deletes stay possible when the op budget is exhausted (they free storage)
        if (this.locked(now)) return J({ r: "busy" });
        if (this.st.rows >= c.rows * 1.25 || this.st.reads >= c.reads * 1.25) return J({ r: "busytoday" });
        this.expirePending(now);
        const row = this.row(q.rkey);
        if (!row || !row.etag) return J({ r: "none" });
        if (row.pend != null) return J({ r: "busy" });   // upload in flight: deleting now would untrack it
        if (q.ifMatch && q.ifMatch !== row.etag && q.ifMatch !== row.hetag) return J({ r: "conflict", current: this.pub(row) });
        return J({ r: "ok" });
      }
      case "del_commit": {
        const row = this.row(q.rkey);
        if (row && row.pend != null) { this.st.dirty = 1; this.mark(); return J({ r: "ok" }); }   // an upload slipped in
        if (row) { this.adj(row.uid, -row.size, -1); this.q(`DELETE FROM files WHERE rkey=?`, q.rkey); }
        return J({ r: "ok" });
      }
      case "status":
        return J({ r: "ok", month: this.st.month, day: this.st.day, a: this.st.a, b: this.st.b, total: this.st.total, rows: this.st.rows, reads: this.st.reads, ms: this.st.ms, dirty: this.st.dirty, caps: c });
      case "test_month": this.st.test_month = String(q.month || ""); this.mark(); this.roll(); return J({ r: "ok" });
      case "test_day": this.st.test_day = String(q.day || ""); this.mark(); this.roll(); return J({ r: "ok" });
      case "test_fail": this.st.test_fail = q.on ? 1 : 0; this.mark(); return J({ r: "ok" });
      case "test_commit_fail": this.st.test_commit_fail = Number(q.n) || 0; this.mark(); return J({ r: "ok" });
      case "test_reconcile": await this.maybeReconcile(now, true); return J({ r: "ok", total: this.st.total });
      case "test_acct": return J({ r: "ok", acct: this.q(`SELECT uid, used, n FROM accts ORDER BY uid`), real: this.q(`SELECT uid, SUM(COALESCE(pend,size)) AS used, COUNT(*) AS n FROM files GROUP BY uid ORDER BY uid`) });
      case "test_sum": return J({ r: "ok", sum: this.q(`SELECT COALESCE(SUM(COALESCE(pend,size)),0) AS s FROM files`)[0].s });
      default: return J({ r: "bad-op" });
    }
  }
}
