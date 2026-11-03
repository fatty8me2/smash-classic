// RetroHub account registry + owner controls (docs: RetroHub/docs/ADMIN.md).
//
// AdminRegistry - ONE Durable Object ("registry", SQLite, Workers Free plan class). It is never reachable from a public URL:
// the Worker has no route to it, every request needs the x-rh-internal header, and the routes that read or change anything
// about OTHER accounts additionally carry the admin uid, which only the admin's own UserHub (friends.js, adminDispatch) sends
// after the socket proved the admin secret in its hello.
//
// What it holds (one row per account, hard capped): uid, display name, username, created (the account's own creation time),
// first/last seen, a PC estimate (most simultaneous sockets seen), the gate status, who set it, a test flag and whether the
// verdict has reached the account's hub. No IP address, no message, no file name. Every account's hub "touches" it at hello
// (at most once per REG_TOUCH_MS while the account stays approved).
//
// Gate status:  ok | pending | banned | denied
//   banned / denied  the account is refused for friends, rooms (ident), invites, saves and links ("account-unavailable").
//   pending          approval mode is on and the account is new: refused online until the owner approves it.
// Settings (kv): approval (default OFF), cutoff (when approval was switched on), vouch (default OFF), autofriend (default ON).
//
// Safety rule for everything here: no EXISTING account is ever locked out by an error, a bug, seeding or a rollback. Only an
// explicit ban/deny, or a brand-new account while approval mode is on, is ever refused. Row counts are kept in counters (cnt) so
// nothing on a hot path scans the table.

import { DurableObject } from "cloudflare:workers";
import { meter, meteredSql } from "./reqbudget.js";

const UID_RE = /^[a-z2-7]{26}$/;
export const ACCT_CAP = 20000;      // ok + pending rows (test accounts included); past it new ok accounts are simply not tracked (never refused)
export const PENDING_CAP = 500;     // rows waiting for approval; past it a new account is still refused but not queued
export const BAN_CAP = 3000;        // banned/denied rows (bans may exceed ACCT_CAP by this much, never more)
export const VOUCH_PER = 5;         // accounts one approved person may vouch for
export const PAGE_MAX = 50;
export const SEED_MAX = 300;
export const OFFSET_MAX = 5000;     // deepest list page (keeps rows read per call small)
export const COUNT_PROBE = 1001;    // a search counts at most this many matches
export const STATUSES = ["ok", "pending", "banned", "denied"];

const now = () => Date.now();
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : d; };
const like = (s) => "%" + String(s).replace(/[\\%_]/g, (c) => "\\" + c) + "%";
const cleanStr = (v, max) => String(v ?? "").replace(/[\p{C}\p{Zl}\p{Zp}]/gu, "").trim().slice(0, max);
const blocked = (s) => s === "banned" || s === "denied";
const grp = (s) => (s === "ok" ? "ok" : s === "pending" ? "pending" : "banned");

export class AdminRegistry extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.sql = meteredSql(ctx.storage.sql);
    this.sql.exec("CREATE TABLE IF NOT EXISTS acct (uid TEXT PRIMARY KEY, name TEXT NOT NULL, username TEXT, created INTEGER NOT NULL DEFAULT 0, " +
      "first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL DEFAULT 0, pcs INTEGER NOT NULL DEFAULT 1, hub INTEGER NOT NULL DEFAULT 1, " +
      "status TEXT NOT NULL DEFAULT 'ok', by TEXT NOT NULL DEFAULT '', st_at INTEGER NOT NULL DEFAULT 0, test INTEGER NOT NULL DEFAULT 0, pushed INTEGER NOT NULL DEFAULT 1, " +
      "tries INTEGER NOT NULL DEFAULT 0, unreach INTEGER NOT NULL DEFAULT 0)");
    for (const col of ["tries INTEGER NOT NULL DEFAULT 0", "unreach INTEGER NOT NULL DEFAULT 0"]) { try { this.sql.exec("ALTER TABLE acct ADD COLUMN " + col); } catch { /* already there */ } }
    this.sql.exec("CREATE INDEX IF NOT EXISTS acct_last ON acct (last_seen)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS acct_first ON acct (first_seen)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS acct_status_last ON acct (status, last_seen)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS acct_status_first ON acct (status, first_seen)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS acct_by ON acct (by)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS acct_pushed ON acct (pushed)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS cnt (k TEXT PRIMARY KEY, n INTEGER NOT NULL)");
    this.cfg = null;
    this.cn = null;
    this.down = false;       // local tests only (t_down): every route answers 503, like an outage
    this.failPush = 0;       // local tests only (t_failpush): the next N pushes to a hub fail
  }

  // ---- limits (the vars are for local tests only) ----
  cap(name, dflt) { return num(this.env["REG_" + name + "_CAP"], dflt); }
  retryMs() { return num(this.env.REG_RETRY_MS, 60000); }
  maxTries() { return num(this.env.REG_PUSH_TRIES, 10); }               // the retry alarm gives up after this many tries...
  giveUpMs() { return num(this.env.REG_PUSH_GIVEUP_MS, 24 * 3600 * 1000); }   // ...or this long after the verdict, whichever comes first

  // ---- counters: group ("ok" | "pending" | "banned") x test flag. Nothing on a hot path counts rows by scanning. ----
  counters() {
    if (!this.cn) {
      this.cn = {};
      for (const r of this.sql.exec("SELECT k, n FROM cnt").toArray()) this.cn[r.k] = r.n;
    }
    return this.cn;
  }
  bump(status, test, d) {
    const k = grp(status) + ":" + (test ? 1 : 0);
    const c = this.counters();
    c[k] = Math.max(0, (c[k] || 0) + d);
    this.sql.exec("INSERT OR REPLACE INTO cnt (k, n) VALUES (?, ?)", k, c[k]);
  }
  n(g, test = null) {
    const c = this.counters();
    return test === null ? (c[g + ":0"] || 0) + (c[g + ":1"] || 0) : c[g + ":" + (test ? 1 : 0)] || 0;
  }
  tracked() { return this.n("ok") + this.n("pending"); }
  counts() {
    const ok = this.n("ok", false), pending = this.n("pending", false), banned = this.n("banned", false);
    return { all: ok + pending + banned, ok, pending, banned };
  }

  // ---- settings ----
  settings() {
    if (!this.cfg) {
      const o = {};
      for (const r of this.sql.exec("SELECT k, v FROM kv").toArray()) o[r.k] = r.v;
      this.cfg = { approval: o.approval === "1", cutoff: Number(o.cutoff) || 0, vouch: o.vouch === "1", autofriend: o.autofriend !== "0" };
    }
    return this.cfg;
  }
  setKv(k, v) { this.sql.exec("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)", k, String(v)); this.cfg = null; }

  row(uid) { return this.sql.exec("SELECT * FROM acct WHERE uid=?", uid).toArray()[0] || null; }

  /* Status for an account seen for the first time. approval off => ok; on => ok only if it is older than the switch-on moment. */
  decide(created) {
    const s = this.settings();
    if (!s.approval) return { status: "ok", by: "auto" };
    if (created > 0 && created < s.cutoff) return { status: "ok", by: "grandfathered" };
    return { status: "pending", by: "" };
  }

  publicRow(r) {
    return { uid: r.uid, name: r.name, username: r.username || null, created: r.created, first_seen: r.first_seen, last_seen: r.last_seen,
      pcs: r.pcs, status: r.status, by: r.by, st_at: r.st_at, test: r.test === 1,
      unapplied: r.hub === 1 && r.pushed === 0 && r.unreach === 0, unreachable: r.hub === 1 && r.pushed === 0 && r.unreach === 1 };
  }

  async hubCall(uid, route, body) {
    if (route === "gate" && this.failPush > 0) { this.failPush--; throw new Error("test push failure"); }
    const stub = this.env.USER_HUBS.get(this.env.USER_HUBS.idFromName(uid));
    const res = await stub.fetch(`https://userhub/i/${route}`, {
      method: "POST", headers: { "x-rh-internal": "1", "content-type": "application/json" }, body: JSON.stringify({ uid, ...body }),
    });
    return res.json();
  }

  /* A uid is "registered" when the Directory knows it. Calling a hub for an unknown uid would create (and write the schema of) a
   * brand-new account hub, so never do that. */
  async isRegistered(uid) {
    try {
      const dir = this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName("directory"));
      const r = await (await dir.fetch("https://directory/lookup?prefix=" + uid.slice(0, 8), { headers: { "x-rh-internal": "1" } })).json();
      return r.uid === uid;
    } catch { return false; }
  }

  async notifyAdmin() {
    const admin = this.env.ADMIN_UID;
    if (!admin || !UID_RE.test(admin)) return;
    try { await this.hubCall(admin, "admin_note", { pending: this.n("pending", false) }); } catch { /* the admin sees it on the next list */ }
  }

  /* Push a verdict to the account's hub. true = done: the hub has it, or there is no hub to push to (a retired / deleted account
   * answers "none": nothing to enforce, nothing to retry). */
  async push(uid, status) {
    for (let i = 0; i < 2; i++) {
      try { const r = (await this.hubCall(uid, "gate", { status })).r; if (r === "ok" || r === "none") return true; } catch { /* retried */ }
    }
    return false;
  }

  // ---- routes ----
  async fetch(request) {
    meter(this.env, this.ctx, "do");
    if (request.headers.get("x-rh-internal") !== "1" || request.method !== "POST") return new Response("forbidden", { status: 403 });
    const route = new URL(request.url).pathname.slice(1);
    let b;
    try { b = (await request.json()) || {}; } catch { return json({ ok: false }, 400); }
    if (route.startsWith("t_")) return this.testRoute(route, b);   // local tests only (TEST_REG=1, see index.js)
    if (this.down) return new Response("down", { status: 503 });
    const ADMIN_ROUTES = ["list", "detail", "set_status", "settings", "seed"];
    if (ADMIN_ROUTES.includes(route) && (!this.env.ADMIN_UID || b.admin !== this.env.ADMIN_UID)) return new Response("forbidden", { status: 403 });
    switch (route) {
      case "touch": return json(await this.touch(b));
      case "rename": return json(this.rename(b));
      case "vouch": return json(this.vouch(b));
      case "list": return json(this.list(b));
      case "detail": return json(this.detail(b));
      case "set_status": return json(await this.setStatus(b));
      case "settings": return json(this.setSettings(b));
      case "seed": return json(this.seed(b));
      default: return new Response("not found", { status: 404 });
    }
  }

  testRoute(route, b) {
    if (this.env.TEST_REG !== "1") return new Response("not found", { status: 404 });
    if (route === "t_down") { this.down = b.on === true; return json({ ok: true }); }
    if (route === "t_failpush") { this.failPush = num(b.n, 0); return json({ ok: true }); }
    if (route === "t_delete") {   // forget a row, as if the account had never been tracked
      const r = UID_RE.test(b.uid) ? this.row(b.uid) : null;
      if (r) { this.sql.exec("DELETE FROM acct WHERE uid=?", r.uid); this.bump(r.status, r.test === 1, -1); }
      return json({ ok: !!r });
    }
    if (route === "t_seed") return json(this.seed(b));
    if (route === "t_row") return json({ row: UID_RE.test(b.uid) ? this.row(b.uid) : null });
    return new Response("not found", { status: 404 });
  }

  /* Retry verdicts that did not reach their hub, a few per invocation (the alarm has its own subrequest budget). A row is given up
   * after maxTries() tries or giveUpMs() after the verdict, whichever comes first: it is then marked unreachable (shown to the owner)
   * and no longer retried. The verdict is still enforced at that account's next hello through the registry (a banned hub re-checks
   * within 10 minutes, an approved one at its next touch), and a touch clears the mark. */
  async alarm() {
    meter(this.env, this.ctx, "alarm");
    const t = now();
    const rows = this.sql.exec("SELECT uid, status, tries, st_at FROM acct WHERE pushed=0 AND hub=1 AND unreach=0 LIMIT 10").toArray();
    for (const r of rows) {
      if (await this.push(r.uid, r.status)) { this.sql.exec("UPDATE acct SET pushed=1, tries=0 WHERE uid=? AND status=?", r.uid, r.status); continue; }
      const tries = r.tries + 1;
      const giveUp = tries >= this.maxTries() || t - r.st_at > this.giveUpMs();
      this.sql.exec("UPDATE acct SET tries=?, unreach=? WHERE uid=? AND status=?", tries, giveUp ? 1 : 0, r.uid, r.status);
    }
    if (this.sql.exec("SELECT 1 FROM acct WHERE pushed=0 AND hub=1 AND unreach=0 LIMIT 1").toArray().length) await this.armRetry(5);
  }
  async armRetry(mult = 1) {
    try { await this.ctx.storage.setAlarm(now() + this.retryMs() * mult); } catch { /* storage alarm unavailable */ }
  }

  /* An account's hub reports in (hello, at most every REG_TOUCH_MS). Returns the gate status and the autofriend switch. Test-flagged
   * accounts are stored too (flagged, hidden from the default list, counted against the caps) and bound by the same gate: a spoofed
   * test flag must not be a way around a ban or approval mode. */
  async touch(b) {
    const uid = String(b.uid || "");
    if (!UID_RE.test(uid)) return { status: "ok" };   // malformed: never lock anybody out on bad input
    const s = this.settings();
    const t = now();
    const created = num(b.created, 0);
    const test = b.test === true;
    const name = cleanStr(b.name, 24) || "player";
    const username = cleanStr(b.username, 24) || null;
    const row = this.row(uid);
    if (row) {
      let status = row.status, by = row.by;
      if (status === "pending" && !s.approval) { status = "ok"; by = "mode-off"; }
      const testNow = test ? 1 : row.test;
      this.sql.exec("UPDATE acct SET name=?, username=COALESCE(?, username), last_seen=?, pcs=MAX(pcs, ?), created=CASE WHEN created=0 THEN ? ELSE created END, " +
        "hub=1, status=?, by=?, st_at=CASE WHEN status<>? THEN ? ELSE st_at END, test=?, pushed=1, tries=0, unreach=0 WHERE uid=?",   // the reply below IS the verdict reaching the hub
        name, username, t, num(b.pcs, 1), created, status, by, status, t, testNow, uid);
      if (status !== row.status || testNow !== row.test) { this.bump(row.status, row.test === 1, -1); this.bump(status, testNow === 1, 1); }
      return { status, autofriend: test || testNow ? false : s.autofriend, approval: s.approval };
    }
    const d = this.decide(created);
    const room = d.status === "pending" ? this.n("pending") < this.cap("PENDING", PENDING_CAP) : this.tracked() < this.cap("ACCT", ACCT_CAP);
    if (room) {
      this.sql.exec("INSERT INTO acct (uid, name, username, created, first_seen, last_seen, pcs, hub, status, by, st_at, test) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)",
        uid, name, username, created, t, t, num(b.pcs, 1), d.status, d.by, t, test ? 1 : 0);
      this.bump(d.status, test, 1);
      if (d.status === "pending" && !test) await this.notifyAdmin();
    }
    return { status: d.status, autofriend: test ? false : s.autofriend, approval: s.approval, tracked: room };
  }

  rename(b) {
    const uid = String(b.uid || "");
    if (!UID_RE.test(uid) || !this.row(uid)) return { ok: false };
    this.sql.exec("UPDATE acct SET name=?, username=? WHERE uid=?", cleanStr(b.name, 24) || "player", cleanStr(b.username, 24) || null, uid);
    return { ok: true };
  }

  /* "An approved friend added a new account by its friend code": approve it, if the owner switched vouching on. Only an account
   * the owner (or approval mode's grandfathering) approved can vouch: a vouched account cannot vouch (no chains). */
  vouch(b) {
    const uid = String(b.uid || ""), by = String(b.by || "");
    if (!UID_RE.test(uid) || !UID_RE.test(by) || uid === by) return { status: "pending" };
    const row = this.row(uid);
    if (row && row.status !== "pending") return { status: row.status };
    if (!this.settings().vouch) return { status: "pending" };
    if (by !== this.env.ADMIN_UID) {
      const v = this.row(by);
      if (!v || v.status !== "ok") return { status: "pending" };
      if (v.by.startsWith("vouch:")) return { status: "pending", reason: "vouch-chain" };
      if (this.sql.exec("SELECT COUNT(*) AS c FROM acct WHERE by=?", "vouch:" + by).toArray()[0].c >= this.cap("VOUCH", VOUCH_PER)) return { status: "pending", reason: "vouch-limit" };
    }
    const t = now();
    if (row) {
      this.sql.exec("UPDATE acct SET status='ok', by=?, st_at=? WHERE uid=?", "vouch:" + by, t, uid);
      this.bump("pending", row.test === 1, -1); this.bump("ok", row.test === 1, 1);
    } else if (this.tracked() < this.cap("ACCT", ACCT_CAP)) {
      this.sql.exec("INSERT INTO acct (uid, name, created, first_seen, last_seen, hub, status, by, st_at) VALUES (?, 'player', ?, ?, ?, 1, 'ok', ?, ?)",
        uid, num(b.created, 0), t, t, "vouch:" + by, t);
      this.bump("ok", false, 1);
    }
    return { status: "ok", by };
  }

  // ---- admin-only ----
  list(b) {
    const s = this.settings();
    const where = [], args = [];
    const st = String(b.status || "all");
    if (st === "pending") where.push("status='pending'");
    else if (st === "banned") where.push("status IN ('banned','denied')");
    else if (st === "ok") where.push("status='ok'");
    const showTests = b.tests === true;
    if (!showTests) where.push("test=0");
    const q = cleanStr(b.q, 40);
    if (q) { where.push("(name LIKE ? ESCAPE '\\' OR username LIKE ? ESCAPE '\\' OR uid LIKE ? ESCAPE '\\')"); args.push(like(q), like(q), like(q.toLowerCase())); }
    const col = b.sort === "first" ? "first_seen" : "last_seen";
    const dir = b.order === "asc" ? "ASC" : "DESC";
    const limit = Math.min(num(b.limit, 25), PAGE_MAX);
    const offset = Math.min(num(b.offset, 0), OFFSET_MAX);
    const w = where.length ? "WHERE " + where.join(" AND ") : "";
    let total;
    if (!q) {   // no search: the totals come from the counters (no scan)
      const t0 = (g) => this.n(g, false) + (showTests ? this.n(g, true) : 0);
      total = st === "pending" ? t0("pending") : st === "banned" ? t0("banned") : st === "ok" ? t0("ok") : t0("ok") + t0("pending") + t0("banned");
    } else {   // a search counts at most COUNT_PROBE matches
      total = this.sql.exec(`SELECT COUNT(*) AS c FROM (SELECT 1 FROM acct ${w} LIMIT ${COUNT_PROBE})`, ...args).toArray()[0].c;
    }
    const rows = this.sql.exec(`SELECT * FROM acct ${w} ORDER BY ${col} ${dir}, uid LIMIT ? OFFSET ?`, ...args, limit, offset).toArray().map((r) => this.publicRow(r));
    return { ok: true, rows, total, offset, counts: this.counts(), settings: this.publicSettings(), all: this.tracked() };
  }

  publicSettings() { const s = this.settings(); return { approval: s.approval, vouch: s.vouch, autofriend: s.autofriend, cutoff: s.cutoff }; }

  detail(b) {
    const uid = String(b.uid || "");
    if (!UID_RE.test(uid)) return { ok: false };
    const r = this.row(uid);
    return r ? { ok: true, found: true, row: this.publicRow(r), hub: r.hub === 1 } : { ok: true, found: false };
  }

  /* ban / unban / approve / deny. A banned or denied uid is pushed to its hub at once (that closes its sockets and starts the
   * clean-up of friends and requests). A push that fails is kept (pushed=0), shown to the owner as not applied yet, and retried
   * by the alarm and on every hello of the account's hub. Unknown uids are recorded too, so a ban sticks even before the account
   * ever registers. */
  async setStatus(b) {
    const uid = String(b.uid || ""), status = String(b.status || "");
    if (!UID_RE.test(uid) || !STATUSES.includes(status) || uid === this.env.ADMIN_UID) return { ok: false, reason: "bad-request" };
    const t = now();
    let row = this.row(uid);
    const registered = row ? row.hub === 1 : await this.isRegistered(uid);
    row = this.row(uid);   // a hello may have inserted the row while we waited for the Directory
    if (!row) {
      if (blocked(status) && this.n("banned") >= this.cap("BAN", BAN_CAP)) return { ok: false, reason: "ban-cap" };
      if (!blocked(status) && this.tracked() >= this.cap("ACCT", ACCT_CAP)) return { ok: false, reason: "cap" };
      this.sql.exec("INSERT OR IGNORE INTO acct (uid, name, created, first_seen, last_seen, hub, status, by, st_at, pushed) VALUES (?, ?, 0, ?, 0, ?, ?, 'admin', ?, ?)",
        uid, cleanStr(b.name, 24) || "player", t, registered ? 1 : 0, status, t, registered ? 0 : 1);
      row = this.row(uid);
      this.bump(status, row.test === 1, 1);
    } else if (row.status !== status) {
      this.bump(row.status, row.test === 1, -1); this.bump(status, row.test === 1, 1);
    }
    this.sql.exec("UPDATE acct SET status=?, by='admin', st_at=?, pushed=?, tries=0, unreach=0 WHERE uid=?", status, t, registered ? 0 : 1, uid);
    let applied = null;
    if (registered) {
      applied = await this.push(uid, status);
      if (applied) this.sql.exec("UPDATE acct SET pushed=1 WHERE uid=? AND status=?", uid, status);
      else await this.armRetry();
    }
    return { ok: true, status, applied, row: this.publicRow(this.row(uid)) };
  }

  setSettings(b) {
    const set = b.set && typeof b.set === "object" ? b.set : {};
    const s = this.settings();
    if (typeof set.approval === "boolean" && set.approval !== s.approval) {
      this.setKv("approval", set.approval ? "1" : "0");
      if (set.approval) this.setKv("cutoff", String(now()));   // grandfathering: accounts created before this moment keep working
    }
    if (typeof set.vouch === "boolean") this.setKv("vouch", set.vouch ? "1" : "0");
    if (typeof set.autofriend === "boolean") this.setKv("autofriend", set.autofriend ? "1" : "0");
    return { ok: true, settings: this.publicSettings(), counts: this.counts() };
  }

  /* The admin's own friend list already holds every auto-linked account: seed the registry from it (never overwrites). A seeded
   * account is an account that already existed: it is always ok (grandfathered), never pending, whatever the friend row's time says.
   * Its creation time is unknown (0) until its own hub reports it at its next hello. */
  seed(b) {
    const list = Array.isArray(b.rows) ? b.rows.slice(0, SEED_MAX) : [];
    let added = 0;
    const cap = this.cap("ACCT", ACCT_CAP);
    for (const r of list) {
      if (this.tracked() >= cap) break;
      if (!r || !UID_RE.test(r.uid) || r.uid === this.env.ADMIN_UID) continue;
      if (this.row(r.uid)) continue;
      const since = num(r.since, 0);
      this.sql.exec("INSERT OR IGNORE INTO acct (uid, name, created, first_seen, last_seen, hub, status, by, st_at) VALUES (?, ?, 0, ?, 0, 1, 'ok', 'seed', ?)",
        r.uid, cleanStr(r.name, 24) || "player", since || now(), now());
      this.bump("ok", false, 1);
      added++;
    }
    return { ok: true, added, total: this.tracked() };
  }
}
