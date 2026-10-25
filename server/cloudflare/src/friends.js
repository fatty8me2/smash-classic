// RetroHub friends system: GET /friends?uid=<user_id> (WebSocket upgrade).
// Protocol: RetroHub/docs/FRIENDS.md.
//
// UserHub  - one Durable Object per user_id (SQLite): profile, friends,
//            requests, blocked, inbox, history, rate limits. Holds the user's
//            WebSockets (hibernation API).
// Directory - single DO "directory": 8-char code prefix -> user_id.
//
// Cross-user operations go DO -> DO over stub.fetch to "/i/..." routes. The
// public worker (friendsFetch) only ever forwards to the fixed path "/ws" of a
// UserHub, so "/i/..." can never be reached from a public URL; the DO also
// requires the x-rh-internal header on them.

import { DurableObject } from "cloudflare:workers";
import { meter, gate, PRESENCE_LEASE_MS, presenceAlarmMs } from "./reqbudget.js";
import { normalizeUsername, lookupKey, reasonToError, HOLD_MS, LEGACY_WINDOW_MS } from "./usernames.js";
import { FixedWindow, onlineTargets, FRIENDS_MSGS_PER_MIN } from "./limits.js";

const UID_RE = /^[a-z2-7]{26}$/;
const LOBBY_RE = /^[A-HJ-NP-Z2-9]{6}(-[0-9]{1,6})?$/;
const CODE_RE = /^RH-?([A-Z2-7]{4})-?([A-Z2-7]{4})$/;

const MAX_JSON = 8192;
const MAX_FRIENDS = 200;
// The admin account is auto-linked with every user, so its friend list may grow much
// larger. To keep presence fan-out bounded, the admin only broadcasts its own presence
// to its first ADMIN_FANOUT friends (oldest links first); the rest still see it on connect.
const ADMIN_MAX_FRIENDS = 5000;
const ADMIN_FANOUT = 200;
// Retry the automatic admin link this long after the admin's side reported full.
const ADMIN_LINK_RETRY_MS = 24 * 60 * 60 * 1000;
const MAX_OUT_REQ = 50;
const MAX_IN_REQ = 200;
const MAX_BLOCKED = 500;
const MAX_NAME = 24;
const MAX_TEXT = 500;
const MAX_INBOX = 200;
const INBOX_TTL = 30 * 24 * 3600 * 1000;
const MAX_HISTORY = 200;
const INVITE_TTL = 30 * 60 * 1000;
export const ONLINE_LEASE_MS = PRESENCE_LEASE_MS;   // 10 min (was 3): the refresh alarm fires every lease/3 (see reqbudget_core.js)
const RANK = { offline: 0, online: 1, in_lobby: 2, in_game: 3 };

const now = () => Date.now();
const codeOf = (uid) => {
  const p = uid.slice(0, 8).toUpperCase();
  return `RH-${p.slice(0, 4)}-${p.slice(4)}`;
};

function clean(raw, max) {
  const s = String(raw ?? "")
    .replace(/\s+/g, " ")
    .replace(/[\p{C}\p{Zl}\p{Zp}]/gu, "")
    .trim();
  return Array.from(s).slice(0, max).join("");
}
const cleanName = (raw) => clean(raw, MAX_NAME);

function cleanText(raw) {
  // Keep newlines, drop other control/format characters.
  return String(raw ?? "").replace(/[^\S\n]+/g, " ").replace(/[\p{C}\p{Zl}\p{Zp}]/gu, (c) => (c === "\n" ? c : "")).trim();
}

function sanitizeStatus(s) {
  if (!s || typeof s !== "object") return null;
  const state = s.state;
  if (!(state in RANK)) return null;
  const out = { state, updated: now() };
  if (state === "offline") return out;
  if (s.game_id != null) out.game_id = clean(s.game_id, 64);
  if (s.game_title != null) out.game_title = clean(s.game_title, 64);
  if (s.system != null) out.system = clean(s.system, 32);
  if (state === "in_lobby" || state === "in_game") {
    const lc = String(s.lobby_code || "").toUpperCase();
    if (LOBBY_RE.test(lc)) out.lobby_code = lc;
    out.joinable = s.joinable === true;
  }
  const n = (v) => (Number.isInteger(v) && v >= 0 && v <= 16 ? v : undefined);
  if (n(s.players) !== undefined) out.players = s.players;
  if (n(s.max_players) !== undefined) out.max_players = s.max_players;
  return out;
}

const offlineStatus = () => ({ state: "offline", updated: now() });

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

// Public entry (called from index.js).
export function friendsFetch(request, env) {
  if (request.headers.get("Upgrade") !== "websocket") {
    return new Response("expected websocket", { status: 426 });
  }
  const uid = new URL(request.url).searchParams.get("uid") || "";
  if (!UID_RE.test(uid)) return new Response("bad uid", { status: 400 });
  const stub = env.USER_HUBS.get(env.USER_HUBS.idFromName(uid));
  // Fixed internal path; never forward the caller's path/headers beyond upgrade.
  const headers = new Headers();
  for (const h of ["Upgrade", "Connection", "Sec-WebSocket-Key", "Sec-WebSocket-Version", "Sec-WebSocket-Extensions"]) {
    const v = request.headers.get(h);
    if (v) headers.set(h, v);
  }
  return stub.fetch(new Request(`https://userhub/ws?uid=${uid}`, { method: "GET", headers }));
}

// ---------------------------------------------------------------------------

/* Throwaway QA/test identities (never auto-linked to the admin). */
export const TEST_NAME_RE = /^(qa-|At\d+$|linktest|scratch-test|test)/i;
export function isTestName(n) { return typeof n === "string" && TEST_NAME_RE.test(n); }

export class Directory extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS dir (prefix TEXT PRIMARY KEY, uid TEXT NOT NULL)");
    // Accounts with at least one authed socket. Lets a sender fan presence out to
    // online friends only, with one call here instead of one per friend.
    this.sql.exec("CREATE TABLE IF NOT EXISTS online (uid TEXT PRIMARY KEY)");
    // `at` makes the flag a lease: entries older than ONLINE_LEASE_MS count as offline.
    try { this.sql.exec("ALTER TABLE online ADD COLUMN at INTEGER NOT NULL DEFAULT 0"); } catch { /* already added */ }
    // Retired identity -> the identity that replaced it (written when a retire completes). Lets anyone who still
    // lists the old uid (a failed fan-out, an offline peer) be swapped to the current uid on their next hello.
    this.sql.exec("CREATE TABLE IF NOT EXISTS alias (old TEXT PRIMARY KEY, new TEXT NOT NULL, at INTEGER NOT NULL DEFAULT 0)");
    // Username registry (see usernames.js, docs/ACCOUNTS.md). One row per claimed name; a DO is single threaded,
    // so every claim is atomic and the first one wins. `ord` = the account's registration order (dir rowid).
    this.sql.exec("CREATE TABLE IF NOT EXISTS uname (key TEXT PRIMARY KEY, uid TEXT NOT NULL UNIQUE, display TEXT NOT NULL, ord INTEGER NOT NULL DEFAULT 0, legacy INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL)");
    // A name given up by a rename/release stays reserved for its old owner for HOLD_MS.
    this.sql.exec("CREATE TABLE IF NOT EXISTS uname_hold (key TEXT PRIMARY KEY, uid TEXT NOT NULL, until INTEGER NOT NULL)");
    // Accounts whose migrated name lost a collision: they must pick a new one.
    this.sql.exec("CREATE TABLE IF NOT EXISTS uname_needs (uid TEXT PRIMARY KEY, at INTEGER NOT NULL)");
  }

  /* Username registry operations. `b.test` = caller is a test account. Returns a plain object. */
  uname(route, b) {
    const t = Date.now();
    const holdOf = (key) => {
      const h = this.sql.exec("SELECT uid, until FROM uname_hold WHERE key=?", key).toArray()[0];
      if (h && h.until <= t) { this.sql.exec("DELETE FROM uname_hold WHERE key=?", key); return null; }
      return h || null;
    };
    const mine = (uid) => this.sql.exec("SELECT * FROM uname WHERE uid=?", uid).toArray()[0] || null;
    const ordOf = (uid) => {
      const r = this.sql.exec("SELECT rowid AS o FROM dir WHERE uid=?", uid).toArray()[0];
      return r ? r.o : 1e12;
    };
    const putHold = (key, uid) => {
      this.sql.exec("INSERT OR REPLACE INTO uname_hold (key, uid, until) VALUES (?, ?, ?)", key, uid, t + (Number(b.holdMs) > 0 ? Number(b.holdMs) : HOLD_MS));
      // at most 5 live holds per account: drop the oldest
      this.sql.exec("DELETE FROM uname_hold WHERE uid=? AND key NOT IN (SELECT key FROM uname_hold WHERE uid=? ORDER BY until DESC LIMIT 5)", uid, uid);
    };
    if (route === "lookup") {
      const n = normalizeUsername(b.name, { test: true });
      const key = normalizeUsername(b.name, { test: false }).key || n.key;
      if (!key) return { uid: null };
      const r = this.sql.exec("SELECT uid, display FROM uname WHERE key=?", key).toArray()[0];
      return { uid: r ? r.uid : null, display: r ? r.display : null };
    }
    if (route === "status") {
      const m = mine(b.uid);
      if (m) return { status: "ok", username: m.display };
      if (this.sql.exec("SELECT 1 FROM uname_needs WHERE uid=?", b.uid).toArray()[0]) return { status: "needs_new_name" };
      return { status: "none" };
    }
    if (route === "check" || route === "claim") {
      const v = normalizeUsername(b.name, { test: !!b.test });
      if (!v.ok) return { ok: false, reason: v.reason };
      const row = this.sql.exec("SELECT uid FROM uname WHERE key=?", v.key).toArray()[0];
      if (row && row.uid !== b.uid) return { ok: false, reason: "taken" };
      const h = holdOf(v.key);
      if (h && h.uid !== b.uid) return { ok: false, reason: "held" };
      if (route === "check") return { ok: true, display: v.display, yours: !!(row || h) };
      const old = mine(b.uid);
      if (old && old.key !== v.key) {
        this.sql.exec("DELETE FROM uname WHERE uid=?", b.uid);
        putHold(old.key, b.uid);
      } else if (old) {
        this.sql.exec("UPDATE uname SET display=?, legacy=0 WHERE uid=?", v.display, b.uid);
        return { ok: true, username: v.display, previous: old.display };
      }
      this.sql.exec("DELETE FROM uname_hold WHERE key=? AND uid=?", v.key, b.uid);
      this.sql.exec("INSERT INTO uname (key, uid, display, ord, legacy, at) VALUES (?, ?, ?, ?, 0, ?)", v.key, b.uid, v.display, ordOf(b.uid), t);
      this.sql.exec("DELETE FROM uname_needs WHERE uid=?", b.uid);
      return { ok: true, username: v.display, previous: old ? old.display : null };
    }
    if (route === "legacy") {
      // Migration of an existing account's display name. Oldest account (registration order) wins a collision.
      const m = mine(b.uid);
      if (m) return { status: "ok", username: m.display };
      const v = normalizeUsername(b.name, { test: false });
      const needs = () => {
        this.sql.exec("INSERT OR REPLACE INTO uname_needs (uid, at) VALUES (?, ?)", b.uid, t);
        return { status: "needs_new_name" };
      };
      if (!v.ok) return needs();
      const ord = ordOf(b.uid);
      const row = this.sql.exec("SELECT * FROM uname WHERE key=?", v.key).toArray()[0];
      let displaced = null;
      if (row) {
        const window = Number(b.window) > 0 ? Number(b.window) : LEGACY_WINDOW_MS;
        if (row.legacy === 1 && row.ord > ord && t - row.at < window) {
          this.sql.exec("DELETE FROM uname WHERE key=?", v.key);
          this.sql.exec("INSERT OR REPLACE INTO uname_needs (uid, at) VALUES (?, ?)", row.uid, t);
          displaced = row.uid;
        } else return needs();
      } else {
        const h = holdOf(v.key);
        if (h && h.uid !== b.uid) return needs();
      }
      this.sql.exec("INSERT INTO uname (key, uid, display, ord, legacy, at) VALUES (?, ?, ?, ?, 1, ?)", v.key, b.uid, v.display, ord, t);
      return { status: "ok", username: v.display, displaced };
    }
    if (route === "release") {
      // hold:true (default) = the name stays reserved for the owner; hold:false = account deletion, free at once.
      const m = mine(b.uid);
      if (!m) return { ok: true, released: null };
      this.sql.exec("DELETE FROM uname WHERE uid=?", b.uid);
      if (b.hold !== false) putHold(m.key, b.uid);
      return { ok: true, released: m.display };
    }
    if (route === "transfer") {
      // Identity retire (old uid replaced by new uid): the name follows the person.
      const m = mine(b.from);
      if (!m) return { ok: true, moved: false };
      this.sql.exec("DELETE FROM uname WHERE uid=?", b.from);
      if (mine(b.to)) { putHold(m.key, b.to); return { ok: true, moved: false }; }
      this.sql.exec("INSERT INTO uname (key, uid, display, ord, legacy, at) VALUES (?, ?, ?, ?, 0, ?)", m.key, b.to, m.display, ordOf(b.to), t);
      this.sql.exec("DELETE FROM uname_needs WHERE uid=?", b.to);
      return { ok: true, moved: true, username: m.display };
    }
    return null;
  }

  async fetch(request) {
    meter(this.env, this.ctx, "do");
    if (request.headers.get("x-rh-internal") !== "1") return new Response("forbidden", { status: 403 });
    const url = new URL(request.url);
    if (url.pathname.startsWith("/uname/") && request.method === "POST") {
      const out = this.uname(url.pathname.slice(7), (await request.json()) || {});
      return out ? json(out) : new Response("not found", { status: 404 });
    }
    if (url.pathname === "/lookup") {
      const prefix = url.searchParams.get("prefix") || "";
      const row = this.sql.exec("SELECT uid FROM dir WHERE prefix=?", prefix).toArray()[0];
      return json({ uid: row ? row.uid : null });
    }
    if (url.pathname === "/register" && request.method === "POST") {
      const { prefix, uid } = await request.json();
      if (!/^[a-z2-7]{8}$/.test(prefix) || !UID_RE.test(uid) || !uid.startsWith(prefix)) {
        return json({ ok: false, reason: "bad-request" }, 400);
      }
      const row = this.sql.exec("SELECT uid FROM dir WHERE prefix=?", prefix).toArray()[0];
      if (row) return json({ ok: row.uid === uid });
      this.sql.exec("INSERT INTO dir (prefix, uid) VALUES (?, ?)", prefix, uid);
      return json({ ok: true });
    }
    if (url.pathname === "/online" && request.method === "POST") {
      const { uid, on } = await request.json();
      if (!UID_RE.test(uid)) return json({ ok: false }, 400);
      if (on) this.sql.exec("INSERT OR REPLACE INTO online (uid, at) VALUES (?, ?)", uid, Date.now());
      else this.sql.exec("DELETE FROM online WHERE uid=?", uid);
      return json({ ok: true });
    }
    if (url.pathname === "/alias" && request.method === "POST") {
      const { old, to } = await request.json();
      if (!UID_RE.test(old) || !UID_RE.test(to) || old === to) return json({ ok: false }, 400);
      // never create a cycle: if `to` already resolves to `old`, refuse
      let cur = to;
      for (let i = 0; i < 8 && cur; i++) {
        if (cur === old) return json({ ok: false }, 409);
        const r = this.sql.exec("SELECT new FROM alias WHERE old=?", cur).toArray()[0];
        cur = r ? r.new : null;
      }
      this.sql.exec("INSERT OR REPLACE INTO alias (old, new, at) VALUES (?, ?, ?)", old, to, Date.now());
      return json({ ok: true });
    }
    if (url.pathname === "/aliases" && request.method === "POST") {
      const { uids } = await request.json();
      const map = {};
      for (const u of (Array.isArray(uids) ? uids : []).filter((x) => UID_RE.test(x)).slice(0, 500)) {
        let cur = u, hops = 0;
        for (; hops < 8; hops++) {
          const r = this.sql.exec("SELECT new FROM alias WHERE old=?", cur).toArray()[0];
          if (!r) break;
          cur = r.new;
        }
        if (cur !== u) map[u] = cur;
      }
      return json({ map });
    }
    if (url.pathname === "/online-of" && request.method === "POST") {
      const { uids } = await request.json();
      const list = (Array.isArray(uids) ? uids : []).filter((u) => UID_RE.test(u)).slice(0, 5000);
      const set = new Set(this.sql.exec("SELECT uid FROM online WHERE at > ?", Date.now() - ONLINE_LEASE_MS).toArray().map((r) => r.uid));
      return json({ uids: list.filter((u) => set.has(u)) });
    }
    return new Response("not found", { status: 404 });
  }
}

// ---------------------------------------------------------------------------

async function sha256hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

export class UserHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.sql = ctx.storage.sql;
    this.helloChain = Promise.resolve();
    this.msgLimit = new FixedWindow(FRIENDS_MSGS_PER_MIN, 60 * 1000);
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"type":"keepalive"}', '{"type":"keepalive_ack"}'));
    const q = (s) => this.sql.exec(s);
    q("CREATE TABLE IF NOT EXISTS profile (id INTEGER PRIMARY KEY CHECK (id = 1), uid TEXT NOT NULL, secret_hash TEXT NOT NULL, name TEXT NOT NULL, code TEXT NOT NULL, created INTEGER NOT NULL)");
    q("CREATE TABLE IF NOT EXISTS friends (uid TEXT PRIMARY KEY, code TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL, since INTEGER NOT NULL)");
    q("CREATE TABLE IF NOT EXISTS requests (uid TEXT NOT NULL, dir TEXT NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (uid, dir))");
    q("CREATE TABLE IF NOT EXISTS blocked (uid TEXT PRIMARY KEY, at INTEGER NOT NULL)");
    q("CREATE TABLE IF NOT EXISTS inbox (id TEXT PRIMARY KEY, json TEXT NOT NULL, at INTEGER NOT NULL)");
    q("CREATE TABLE IF NOT EXISTS history (id TEXT PRIMARY KEY, peer TEXT NOT NULL, json TEXT NOT NULL, at INTEGER NOT NULL)");
    q("CREATE INDEX IF NOT EXISTS history_peer ON history (peer, at)");
    q("CREATE TABLE IF NOT EXISTS rl (k TEXT PRIMARY KEY, start INTEGER NOT NULL, n INTEGER NOT NULL)");
    q("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  }

  // ---- helpers ----------------------------------------------------------

  all(query, ...p) { return this.sql.exec(query, ...p).toArray(); }
  one(query, ...p) { return this.all(query, ...p)[0] || null; }
  run(query, ...p) { this.sql.exec(query, ...p); }

  profile() { return this.one("SELECT * FROM profile WHERE id=1"); }
  isFriend(uid) { return !!this.one("SELECT 1 FROM friends WHERE uid=?", uid); }
  isBlocked(uid) { return !!this.one("SELECT 1 FROM blocked WHERE uid=?", uid); }
  count(table, where = "1", ...p) { return this.one(`SELECT COUNT(*) AS c FROM ${table} WHERE ${where}`, ...p).c; }

  hit(key, limit, windowMs) {
    const t = now();
    const row = this.one("SELECT start, n FROM rl WHERE k=?", key);
    if (!row || t - row.start >= windowMs) {
      this.run("INSERT OR REPLACE INTO rl (k, start, n) VALUES (?, ?, 1)", key, t);
      return true;
    }
    if (row.n >= limit) return false;
    this.run("UPDATE rl SET n=n+1 WHERE k=?", key);
    return true;
  }

  authedSockets(except) {
    const out = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      const a = ws.deserializeAttachment();
      if (a && a.authed) out.push(ws);
    }
    return out;
  }

  push(obj, except) {
    const text = JSON.stringify(obj);
    for (const ws of this.authedSockets(except)) {
      try { ws.send(text); } catch { /* closing */ }
    }
  }

  err(ws, reason, ref, detail) {
    const o = { type: "error", reason };
    if (ref !== undefined) o.ref = ref;
    if (detail) o.detail = detail;
    try { ws.send(JSON.stringify(o)); } catch { /* closing */ }
  }

  effective(except) {
    let best = null;
    let bestRank = 0;
    for (const ws of this.authedSockets(except)) {
      const st = ws.deserializeAttachment().status;
      if (!st) continue;
      const r = RANK[st.state] || 0;
      if (r === 0) continue; // offline / invisible device
      if (!best || r > bestRank || (r === bestRank && st.updated > best.updated)) {
        best = st;
        bestRank = r;
      }
    }
    return best || offlineStatus();
  }

  me() {
    const p = this.profile();
    return { uid: p.uid, code: p.code, name: p.name, status: this.effective() };
  }

  async call(uid, path, body) {
    const stub = this.env.USER_HUBS.get(this.env.USER_HUBS.idFromName(uid));
    const res = await stub.fetch(`https://userhub/i/${path}`, {
      method: "POST",
      headers: { "x-rh-internal": "1", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  /* Friend list for the welcome, with the presence lease applied: a friend whose directory lease expired
   * (crashed client / killed process never sent "offline") is shown offline, not stuck "in_game". */
  async friendsWithLease() {
    const rows = this.all("SELECT * FROM friends ORDER BY name");
    if (rows.length === 0) return [];
    let on = null;
    try {
      const dir = this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName("directory"));
      const res = await (await dir.fetch("https://directory/online-of", {
        method: "POST",
        headers: { "x-rh-internal": "1", "content-type": "application/json" },
        body: JSON.stringify({ uids: rows.map((r) => r.uid) }),
      })).json();
      on = new Set(res.uids || []);
    } catch { /* directory unreachable: show stored statuses */ }
    return rows.map((r) => {
      const f = this.friendObj(r);
      if (on && !on.has(r.uid) && f.status && f.status.state !== "offline") f.status = offlineStatus();
      return f;
    });
  }

  friendObj(r) {
    return { uid: r.uid, code: r.code, name: r.name, status: JSON.parse(r.status), since: r.since };
  }

  async broadcastPresence(force, except) {
    const p = this.profile();
    if (!p) return;
    const eff = this.effective(except);
    const key = JSON.stringify({ ...eff, updated: 0 }) + "|" + p.name;
    const prev = this.one("SELECT v FROM kv WHERE k='pres'");
    if (!force && prev && prev.v === key) return;
    this.run("INSERT OR REPLACE INTO kv (k, v) VALUES ('pres', ?)", key);
    const payload = { uid: p.uid, name: p.name, status: eff };
    const isAdmin = !!this.env.ADMIN_UID && p.uid === this.env.ADMIN_UID;
    const rows = isAdmin
      ? this.all("SELECT uid FROM friends ORDER BY since ASC LIMIT ?", ADMIN_FANOUT)
      : this.all("SELECT uid FROM friends");
    const uids = rows.map((f) => f.uid);
    if (uids.length === 0) return;
    // Only online friends are contacted: one directory call, then one call per online friend.
    // Offline friends pick up our status when they connect (their hello pulls it below).
    const dir = this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName("directory"));
    const on = await (await dir.fetch("https://directory/online-of", {
      method: "POST",
      headers: { "x-rh-internal": "1", "content-type": "application/json" },
      body: JSON.stringify({ uids }),
    })).json();
    const targets = onlineTargets(uids, new Set(on.uids || []));
    const results = await Promise.allSettled(targets.map((uid) => this.call(uid, "presence", payload)));
    // Each reply carries the friend's own status, so our copy of it stays current too.
    results.forEach((res, i) => {
      const r = res.status === "fulfilled" ? res.value : null;
      const st = r && sanitizeStatus(r.st);
      if (st) this.run("UPDATE friends SET name=?, status=? WHERE uid=?", cleanName(r.name) || "player", JSON.stringify(st), targets[i]);
    });
  }

  // Record this account in the directory's online set (called on the first socket up / last socket down).
  async setOnline(on) {
    const dir = this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName("directory"));
    const uid = this.profile().uid;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await dir.fetch("https://directory/online", {
          method: "POST",
          headers: { "x-rh-internal": "1", "content-type": "application/json" },
          body: JSON.stringify({ uid, on }),
        });
        if (r.ok) break;
      } catch {
        // retry once; the lease refresh (alarm) repairs anything still missed
      }
    }
    if (on) await this.scheduleLease();
  }

  // Keep the directory lease fresh while sockets are connected (keepalives are auto-answered
  // without waking this object, so a timer does the refresh).
  async scheduleLease() {
    try {
      if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + presenceAlarmMs(ONLINE_LEASE_MS));
    } catch { /* storage alarm unavailable */ }
  }

  async alarm() {
    meter(this.env, this.ctx, "alarm");
    if (this.authedSockets().length === 0) return;
    // Cost guard: at >=90% of the daily budget stop refreshing presence (no reschedule; leases lapse harmlessly).
    if (!gate(this.env).relayFrames) return;
    await this.setOnline(true);
  }

  addFriendRow(uid, name, status) {
    // A person is either a friend or a pending request, never both.
    this.run("DELETE FROM requests WHERE uid=?", uid);
    this.run("INSERT OR REPLACE INTO friends (uid, code, name, status, since) VALUES (?, ?, ?, ?, ?)",
      uid, codeOf(uid), cleanName(name) || "player", JSON.stringify(status || offlineStatus()), now());
    return this.friendObj(this.one("SELECT * FROM friends WHERE uid=?", uid));
  }

  /* Idempotent clean-up of rows that violate "one entry per person" (older versions or races left some):
   * malformed/self friend rows, a request for someone who is already a friend, a person with both an incoming
   * and an outgoing request (keep the incoming one so it can be accepted), friends/requests of blocked users. */
  dedupeRows() {
    const p = this.profile();
    for (const r of this.all("SELECT uid FROM friends")) {
      if (!UID_RE.test(r.uid) || r.uid === p.uid) this.run("DELETE FROM friends WHERE uid=?", r.uid);
    }
    this.run("DELETE FROM requests WHERE uid=?", p.uid);
    this.run("DELETE FROM friends WHERE uid IN (SELECT uid FROM blocked)");
    this.run("DELETE FROM requests WHERE uid IN (SELECT uid FROM blocked)");
    this.run("DELETE FROM requests WHERE uid IN (SELECT uid FROM friends)");
    this.run("DELETE FROM requests WHERE dir='out' AND uid IN (SELECT uid FROM requests WHERE dir='in')");
    // an outgoing request nobody answered for 60 days is stale (the target is gone or never coming back)
    this.run("DELETE FROM requests WHERE dir='out' AND at < ?", now() - 60 * 86400 * 1000);
  }

  /* Swap every retired identity still sitting in our lists for the identity that replaced it (Directory alias map),
   * so one person never shows up twice because an older fan-out missed us. Friends keep their slot, requests their direction. */
  async applyAliases() {
    const p = this.profile();
    const uids = [...this.all("SELECT uid FROM friends"), ...this.all("SELECT uid FROM requests")].map((r) => r.uid);
    if (!uids.length) return;
    let map;
    try {
      const dir = this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName("directory"));
      const r = await dir.fetch("https://directory/aliases", {
        method: "POST", headers: { "x-rh-internal": "1", "content-type": "application/json" },
        body: JSON.stringify({ uids: [...new Set(uids)] }),
      });
      map = (await r.json()).map || {};
    } catch { return; }
    for (const [oldU, newU] of Object.entries(map)) {
      if (!UID_RE.test(newU) || oldU === newU) continue;
      const fr = this.one("SELECT * FROM friends WHERE uid=?", oldU);
      const rq = this.one("SELECT * FROM requests WHERE uid=?", oldU);
      // Cap full (and the new identity not already listed): keep the old row rather than silently losing the friend.
      if (fr && !this.isFriend(newU) && newU !== p.uid && !this.isBlocked(newU) && this.count("friends") >= this.friendCap(p)) continue;
      if (fr) { this.run("DELETE FROM friends WHERE uid=?", oldU); this.push({ type: "friend_removed", uid: oldU }); }
      if (rq) { this.run("DELETE FROM requests WHERE uid=?", oldU); this.push({ type: "request_update", uid: oldU, result: "cancelled" }); }
      if (newU === p.uid || this.isBlocked(newU)) continue;
      if (fr && !this.isFriend(newU) && this.count("friends") < this.friendCap(p)) {
        let back = null;
        try { back = await this.call(newU, "alias_link", { uid: p.uid, name: p.name, status: this.me().status }); } catch { /* keep one-sided */ }
        if (back && (back.r === "blocked" || back.r === "none")) continue;   // they cannot list us (blocked / no such account)
        this.push({ type: "friend_added", friend: this.addFriendRow(newU, fr.name, null) });
      } else if (rq && !this.isFriend(newU) && !this.one("SELECT 1 FROM requests WHERE uid=?", newU)) {
        const q = { uid: newU, code: codeOf(newU), name: rq.name, at: rq.at };
        this.run("INSERT OR REPLACE INTO requests (uid, dir, code, name, at) VALUES (?, ?, ?, ?, ?)", newU, rq.dir, q.code, q.name, q.at);
        this.push({ type: "request", req: q, dir: rq.dir });
      }
    }
  }

  /* Remember old -> new for everyone who may still list the old uid. Idempotent, best effort. */
  async postAlias(old, to) {
    try {
      if (this.env.TEST_ALIAS_FAIL_ONCE === "1" && !this.one("SELECT 1 FROM kv WHERE k='test_alias_failed'")) {
        this.run("INSERT OR REPLACE INTO kv (k, v) VALUES ('test_alias_failed', '1')");
        throw new Error("test alias failure");
      }
      const dir = this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName("directory"));
      const r = await dir.fetch("https://directory/alias", {
        method: "POST", headers: { "x-rh-internal": "1", "content-type": "application/json" },
        body: JSON.stringify({ old, to }),
      });
      return r.ok;
    } catch { return false; }
  }

  retiredTo() {
    const r = this.one("SELECT v FROM kv WHERE k='retired'");
    return r ? r.v : null;
  }

  saveHistory(peer, msg) {
    this.run("INSERT OR REPLACE INTO history (id, peer, json, at) VALUES (?, ?, ?, ?)", msg.id, peer, JSON.stringify(msg), msg.at);
    this.run("DELETE FROM history WHERE peer=? AND id NOT IN (SELECT id FROM history WHERE peer=? ORDER BY at DESC LIMIT ?)",
      peer, peer, MAX_HISTORY);
  }

  // ---- fetch (WebSocket upgrade + internal routes) -----------------------

  async fetch(request) {
    meter(this.env, this.ctx, "do");
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
      const uid = url.searchParams.get("uid") || "";
      if (!UID_RE.test(uid)) return new Response("bad uid", { status: 400 });
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({ uid, authed: false });
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (url.pathname.startsWith("/i/") && request.method === "POST" && request.headers.get("x-rh-internal") === "1") {
      const body = await request.json();
      const route = url.pathname.slice(3);
      return json(await this.internal(route, body));
    }
    return new Response("not found", { status: 404 });
  }

  // ---- internal (DO -> DO) ----------------------------------------------

  async internal(route, b) {
    const p = this.profile();
    if (!p) return { r: "none" };
    if (!b || !UID_RE.test(b.uid || "")) return { r: "none" };
    const from = b.uid;
    if (this.retiredTo() && route !== "retire_begin" && route !== "retire_done" && route !== "link_auth") return { r: "none" };
    switch (route) {
      case "retire_begin": {
        // Called by the successor identity's hub with this (old) account's secret: hand over everything
        // and become inert. Idempotent for the same successor.
        if (p.secret_hash !== (await sha256hex(String(b.secret ?? "")))) return { r: "bad-secret" };
        const to = this.retiredTo();
        if (to && to !== from) return { r: "gone" };
        if (from === p.uid) return { r: "none" };
        // Non-destructive: the snapshot stays in this account until the successor confirms (retire_done),
        // so a failure mid fan-out can simply be retried and resumes from the same snapshot.
        const friends = this.all("SELECT uid, name, status FROM friends").map((f) => ({ uid: f.uid, name: f.name, status: JSON.parse(f.status) }));
        const reqs = this.all("SELECT uid, dir, name FROM requests");
        const blocked = this.all("SELECT uid FROM blocked").map((x) => x.uid);
        this.run("INSERT OR REPLACE INTO kv (k, v) VALUES ('retired', ?)", from);
        for (const ws of this.ctx.getWebSockets()) { try { ws.close(4005, "retired"); } catch { /* closed */ } }
        try {
          const dir = this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName("directory"));
          await dir.fetch("https://directory/online", {
            method: "POST", headers: { "x-rh-internal": "1", "content-type": "application/json" },
            body: JSON.stringify({ uid: p.uid, on: false }),
          });
        } catch { /* lease expires on its own */ }
        return { r: "ok", old: p.uid, friends, requests: reqs, blocked };
      }
      case "retire_done": {
        // The successor finished moving everything: only now is the snapshot dropped.
        if (this.retiredTo() !== from) return { r: "none" };
        if (p.secret_hash !== (await sha256hex(String(b.secret ?? "")))) return { r: "bad-secret" };
        this.run("DELETE FROM friends");
        this.run("DELETE FROM requests");
        this.run("DELETE FROM blocked");
        return { r: "ok" };
      }
      case "replace_uid": {
        // A friend's account `from` was retired in favour of b.to: swap them in our lists (no duplicates).
        const to = String(b.to || "");
        if (!UID_RE.test(to) || to === p.uid || to === from) return { r: "none" };
        const name = cleanName(b.name) || "player";
        const had = this.isFriend(from);
        const reqOut = !!this.one("SELECT 1 FROM requests WHERE uid=? AND dir='out'", from); // we asked the old uid
        const reqIn = !!this.one("SELECT 1 FROM requests WHERE uid=? AND dir='in'", from);   // the old uid asked us
        this.run("DELETE FROM friends WHERE uid=?", from);
        this.run("DELETE FROM requests WHERE uid=?", from);
        if (had) this.push({ type: "friend_removed", uid: from });
        if (reqOut) this.push({ type: "request_update", uid: from, result: "cancelled" });
        if (reqIn) this.push({ type: "request_update", uid: from, result: "cancelled" });
        let linked = this.isFriend(to);
        if (this.isBlocked(to)) return { r: "ok", linked: false };
        if (!linked && had && this.count("friends") < this.friendCap(p)) {
          const f = this.addFriendRow(to, name, sanitizeStatus(b.status));
          this.push({ type: "friend_added", friend: f });
          linked = true;
        }
        let req = null;
        if (!linked && (reqOut || reqIn)) {
          const dirn = reqOut ? "out" : "in";
          const code = codeOf(to);
          const at = now();
          if (!this.one("SELECT 1 FROM requests WHERE uid=?", to)) {
            this.run("INSERT OR REPLACE INTO requests (uid, dir, code, name, at) VALUES (?, ?, ?, ?, ?)", to, dirn, code, name, at);
            this.push({ type: "request", req: { uid: to, code, name, at }, dir: dirn });
          }
          req = reqOut ? "out" : "in";
        }
        return { r: "ok", linked, req };
      }
      case "alias_link": {
        // A friend whose old uid was swapped for ours in their list asks us to list them back (two-sided friendship).
        if (this.isBlocked(from)) return { r: "blocked" };
        if (!this.isFriend(from)) {
          if (this.count("friends") >= this.friendCap(p)) return { r: "full" };
          const f = this.addFriendRow(from, b.name, sanitizeStatus(b.status));
          this.push({ type: "friend_added", friend: f });
        }
        return { r: "ok" };
      }
      case "link_auth": {
        // Secret check for /link/* (see link.js). Optionally rate-limits link-code creation.
        if (p.secret_hash !== (await sha256hex(String(b.secret ?? "")))) return { r: "bad-secret" };
        if (b.count && !this.hit(`link:${from}`, 5, 60 * 60 * 1000)) return { r: "rate" };
        // username: shown on the new PC ("Linking as NAME"); prev: the still-open code of this account, revoked when a new one is made.
        return { r: "ok", username: this.kvGet("username"), prev: b.count ? this.kvGet("last_link") : undefined };
      }
      case "link_set": {
        if (b.secret && p.secret_hash !== (await sha256hex(String(b.secret)))) return { r: "bad-secret" };
        this.kvSet("last_link", String(b.box || "").slice(0, 80));
        return { r: "ok" };
      }
      case "uname_revoked": {
        // Another (older) account won our migrated name: ask the player for a new one.
        this.setUsernameLocal(null, "needs_new_name");
        this.push({ type: "username", username: null, status: "needs_new_name" });
        return { r: "ok" };
      }
      case "saves_auth": {
        // Cloud saves: hand the Worker the HMAC key (sha256hex of the secret) after rate limiting this account.
        if (from !== p.uid) return { r: "none" };
        const w = !!b.write;
        const V2 = { pc: 30, put: 120, get: 300, meta: 60 };   // v2 per-account per-minute limits (docs/CLOUD_SAVES_V2.md 3.6)
        if (b.cls && V2[b.cls]) {
          const ov = Number(this.env && this.env["SAVES_RATE_" + b.cls.toUpperCase()]);   // tests only; unset in production
          if (!this.hit("saves2:" + b.cls, ov > 0 ? ov : V2[b.cls], 60000)) return { r: "limited" };
        }
        else if (!this.hit(w ? "saves:w" : "saves:r", w ? 120 : 600, 60000)) return { r: "limited" };
        return { r: "ok", key: p.secret_hash };
      }
      case "presence": {
        if (!this.isFriend(from)) return { r: "none" };
        const st = sanitizeStatus(b.status) || offlineStatus();
        const name = cleanName(b.name) || "player";
        this.run("UPDATE friends SET name=?, status=? WHERE uid=?", name, JSON.stringify(st), from);
        this.push({ type: "presence", uid: from, name, status: st });
        return { r: "ok", name: p.name, st: this.effective() };
      }
      case "request": {
        const name = cleanName(b.name) || "player";
        // Blocked sender: fake "ok" so they cannot tell they are blocked (privacy). Their pending-request entry
        // then looks accepted-but-unanswered until it is cleared; if they query the pair later they only ever see
        // "removed". Accepted trade-off, documented in docs.
        if (this.isBlocked(from)) return { r: "ok", name: "player", code: p.code };
        if (this.isFriend(from)) {
          // They no longer have us (a removal never reached them) but we still list them: finish the link
          // instead of leaving a one-sided ghost entry.
          this.run("DELETE FROM requests WHERE uid=?", from);
          return { r: "accepted", friend: this.me() };
        }
        if (this.one("SELECT 1 FROM requests WHERE uid=? AND dir='out'", from)) {
          if (this.count("friends") >= this.friendCap(p)) return { r: "full" };
          this.run("DELETE FROM requests WHERE uid=?", from);
          const f = this.addFriendRow(from, name, sanitizeStatus(b.status));
          this.push({ type: "request_update", uid: from, result: "accepted" });
          this.push({ type: "friend_added", friend: f });
          return { r: "accepted", friend: this.me() };
        }
        if (this.count("requests", "dir='in'") >= MAX_IN_REQ && !this.one("SELECT 1 FROM requests WHERE uid=? AND dir='in'", from)) {
          return { r: "ok", name: p.name, code: p.code };
        }
        const req = { uid: from, code: codeOf(from), name, at: now() };
        this.run("INSERT OR REPLACE INTO requests (uid, dir, code, name, at) VALUES (?, 'in', ?, ?, ?)", from, req.code, name, req.at);
        this.push({ type: "request", req, dir: "in" });
        return { r: "ok", name: p.name, code: p.code };
      }
      case "request_update": {
        const result = b.result;
        if (result === "accepted") {
          // Normally they accept our outgoing request; crossed requests are resolved by the "request" route, not here.
          // Only a request WE sent (dir='out') can be accepted by them; an incoming row must never be force-accepted.
          // The only exception is a genuine crossed request (both asked within seconds): flagged by the sender
          // and only honoured while our incoming row is fresh.
          const okRow = this.one("SELECT 1 FROM requests WHERE uid=? AND dir='out'", from)
            || (b.crossed === true && this.one("SELECT 1 FROM requests WHERE uid=? AND dir='in' AND at > ?", from, now() - 60000));
          if (!okRow || this.isBlocked(from)) return { r: "none" };
          if (this.count("friends") >= this.friendCap(p)) return { r: "full" };
          this.run("DELETE FROM requests WHERE uid=?", from);
          const f = this.addFriendRow(from, b.name, sanitizeStatus(b.status));
          this.push({ type: "request_update", uid: from, result: "accepted" });
          this.push({ type: "friend_added", friend: f });
          return { r: "ok", friend: this.me() };
        }
        if (result === "declined") this.run("DELETE FROM requests WHERE uid=? AND dir='out'", from);
        else if (result === "cancelled") this.run("DELETE FROM requests WHERE uid=? AND dir='in'", from);
        else return { r: "none" };
        this.push({ type: "request_update", uid: from, result });
        return { r: "ok" };
      }
      case "admin_link": {
        // Only the configured admin's own UserHub accepts automatic links.
        if (!this.env.ADMIN_UID || p.uid !== this.env.ADMIN_UID) return { r: "none" };
        if (isTestName(b.name)) return { r: "blocked" };
        if (this.isBlocked(from)) return { r: "blocked" };
        if (!this.isFriend(from)) {
          if (this.count("friends") >= this.friendCap(p)) return { r: "full" };
          this.run("DELETE FROM requests WHERE uid=?", from);
          const f = this.addFriendRow(from, cleanName(b.name) || "player", sanitizeStatus(b.status));
          this.push({ type: "friend_added", friend: f });
        }
        return { r: "ok", friend: this.me() };
      }
      case "room_pair": {
        // Called by HubRoom (which verified both members' account secrets): link us with b.uid, both ways.
        if (from === p.uid) return { r: "none" };
        const bad = this.autoPairCheck(from, b.name);
        if (bad) return { r: bad };
        let back = null;
        try { back = await this.call(from, "auto_pair_back", { uid: p.uid, name: p.name, status: this.me().status }); } catch { /* peer unreachable */ }
        if (!back || back.r !== "ok" || !back.friend) return { r: (back && back.r) || "none" };
        if (!this.isFriend(from) && this.count("friends") < this.friendCap(p)) {
          this.run("DELETE FROM requests WHERE uid=?", from);
          const f = this.addFriendRow(from, back.friend.name, sanitizeStatus(back.friend.status));
          this.push({ type: "friend_added", friend: f, auto: true });
        }
        return { r: "ok" };
      }
      case "auto_pair_back": {
        const bad = this.autoPairCheck(from, null, true);
        if (bad === "already") return { r: "ok", friend: this.me() };   // finish a one-sided link
        if (bad) return { r: bad };
        this.run("DELETE FROM requests WHERE uid=?", from);
        const f = this.addFriendRow(from, b.name || codeOf(from), sanitizeStatus(b.status));
        this.push({ type: "friend_added", friend: f, auto: true });
        return { r: "ok", friend: this.me() };
      }
      case "friend_removed": {
        if (!this.isFriend(from)) return { r: "none" };
        this.run("INSERT OR REPLACE INTO kv (k, v) VALUES (?, '1')", "norelink:" + from);
        this.run("DELETE FROM friends WHERE uid=?", from);
        this.push({ type: "friend_removed", uid: from });
        return { r: "ok" };
      }
      case "msg": {
        const m = b.msg;
        if (!m || m.from !== from || m.to !== p.uid) return { r: "none" };
        if (this.isBlocked(from)) return { r: "ok" }; // silent drop
        if (!this.isFriend(from)) return { r: "notfriend" };
        if (m.kind === "text") this.saveHistory(from, m);
        if (this.authedSockets().length) {
          this.push({ type: "msg", msg: m });
        } else {
          this.run("INSERT OR REPLACE INTO inbox (id, json, at) VALUES (?, ?, ?)", m.id, JSON.stringify(m), m.at);
          this.run("DELETE FROM inbox WHERE id NOT IN (SELECT id FROM inbox ORDER BY at DESC LIMIT ?)", MAX_INBOX);
        }
        return { r: "ok" };
      }
      default:
        return { r: "none" };
    }
  }

  // ---- WebSocket handlers ------------------------------------------------

  async webSocketMessage(ws, message) {
    meter(this.env, this.ctx, "ws");   // incoming messages bill 20:1 (keepalives are auto-answered and free)
    if (typeof message !== "string") return;
    const att = ws.deserializeAttachment();
    if (!att) return;
    if (message.length > MAX_JSON) {
      this.err(ws, "bad-request", undefined, "too-large");
      return;
    }
    let msg;
    try { msg = JSON.parse(message); } catch { return; }
    if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return;
    // Per-account budget for all API traffic (in-memory, per UserHub instance).
    // hello and keepalive are exempt so reconnect storms can't lock an account out.
    if (msg.type !== "hello" && msg.type !== "keepalive" && !this.msgLimit.hit("m")) {
      this.err(ws, "rate-limited", msg.type);
      return;
    }

    if (msg.type === "hello") {
      this.helloChain = this.helloChain.then(() => this.hello(ws, msg)).catch(() => {
        try { ws.close(4002, "bad-hello"); } catch { /* closed */ }
      });
      await this.helloChain;
      return;
    }
    if (!att.authed) {
      try { ws.close(4002, "hello-required"); } catch { /* closed */ }
      return;
    }
    try {
      await this.dispatch(ws, att, msg);
    } catch (e) {
      this.err(ws, "bad-request", msg.type, "internal");
    }
  }

  async hello(ws, msg) {
    const att = ws.deserializeAttachment();
    if (!att || att.authed) return;
    const uid = att.uid;
    if (typeof msg.secret !== "string" || msg.secret.length < 16 || msg.secret.length > 128) {
      ws.close(4002, "bad-hello");
      return;
    }
    const hash = await sha256hex(msg.secret);
    const name = cleanName(msg.name) || "player";
    let p = this.profile();
    if (!p) {
      const dir = this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName("directory"));
      const res = await dir.fetch("https://directory/register", {
        method: "POST",
        headers: { "x-rh-internal": "1", "content-type": "application/json" },
        body: JSON.stringify({ prefix: uid.slice(0, 8), uid }),
      });
      const r = await res.json();
      if (!r.ok) {
        ws.close(4004, "code-collision");
        return;
      }
      p = this.profile(); // re-check after the await
      if (!p) {
        this.run("INSERT INTO profile (id, uid, secret_hash, name, code, created) VALUES (1, ?, ?, ?, ?, ?)",
          uid, hash, name, codeOf(uid), now());
        p = this.profile();
      }
    }
    if (p.secret_hash !== hash) {
      ws.close(4003, "bad-secret");
      return;
    }
    if (this.retiredTo()) {
      ws.close(4005, "retired");
      return;
    }
    const isTestAcct = msg.test === true || isTestName(name) || !!this.one("SELECT 1 FROM kv WHERE k='is_test'");
    const un = await this.helloUsername(msg, name, isTestAcct);
    const shownName = un.username || name;   // a claimed username always wins over whatever name a device sends
    let renamed = false;
    if (p.name !== shownName) {
      this.run("UPDATE profile SET name=? WHERE id=1", shownName);
      p.name = shownName;
      renamed = true;
    }
    const wasOnline = this.authedSockets().length > 0;
    ws.serializeAttachment({ uid, authed: true, status: { state: "online", updated: now() } });
    if (msg.test === true || isTestName(name)) this.run("INSERT OR REPLACE INTO kv (k, v) VALUES ('is_test', '1')");
    if (typeof msg.auto_friend === "boolean") this.run("INSERT OR REPLACE INTO kv (k, v) VALUES ('auto_friend', ?)", msg.auto_friend ? "1" : "0");
    await this.autoLinkAdmin(p);
    if (!wasOnline) {
      // First socket up: announce ourselves and pull friends' current statuses before the welcome.
      await this.setOnline(true);
      await this.broadcastPresence(true);
    }

    this.run("DELETE FROM inbox WHERE at < ?", now() - INBOX_TTL);
    await this.applyAliases();
    this.dedupeRows();
    const friends = await this.friendsWithLease();
    const reqs = this.all("SELECT uid, dir, code, name, at FROM requests ORDER BY at");
    const strip = ({ uid: u, code, name: n, at }) => ({ uid: u, code, name: n, at });
    ws.send(JSON.stringify({
      type: "welcome",
      code: p.code,
      username: un.username || null,
      username_status: un.status,
      ...(un.error ? { username_error: un.error } : {}),
      friends,
      requests: {
        incoming: reqs.filter((r) => r.dir === "in").map(strip),
        outgoing: reqs.filter((r) => r.dir === "out").map(strip),
      },
      blocked: this.all("SELECT uid FROM blocked").map((r) => r.uid),
      inbox: this.all("SELECT json FROM inbox ORDER BY at").map((r) => JSON.parse(r.json)),
    }));
    await this.broadcastPresence(renamed);
  }

  // ---- usernames (registry = Directory, see usernames.js / docs/ACCOUNTS.md) ----

  isTestAccount() { return !!this.one("SELECT 1 FROM kv WHERE k='is_test'"); }
  kvGet(k) { const r = this.one("SELECT v FROM kv WHERE k=?", k); return r ? r.v : null; }
  kvSet(k, v) { this.run("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)", k, v); }

  async dirU(route, body) {
    const dir = this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName("directory"));
    const res = await dir.fetch(`https://directory/uname/${route}`, {
      method: "POST", headers: { "x-rh-internal": "1", "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return res.json();
  }

  setUsernameLocal(username, status) {
    if (username) this.kvSet("username", username); else this.run("DELETE FROM kv WHERE k='username'");
    this.kvSet("uname_status", status);
  }

  /* Hello time: report the account's username state, claiming when asked (hello.username) or migrating the legacy
   * display name once (oldest account wins; losers get needs_new_name). Test accounts never migrate. */
  async helloUsername(msg, name, isTest) {
    const have = this.kvGet("username");
    if (have) return { username: have, status: "ok" };
    try {
      if (typeof msg.username === "string" && msg.username) {
        const r = await this.dirU("claim", { uid: this.profile().uid, name: msg.username, test: isTest, holdMs: this.env.UNAME_HOLD_MS });
        if (r.ok) { this.setUsernameLocal(r.username, "ok"); return { username: r.username, status: "ok" }; }
        if (!isTest) this.kvSet("uname_status", "needs_new_name");
        return { username: null, status: isTest ? "none" : (this.kvGet("uname_status") || "none"), error: reasonToError(r.reason) };
      }
      if (isTest) return { username: null, status: "none" };
      if (!msg.no_auto_username && !this.kvGet("uname_legacy_done")) {
        const r = await this.dirU("legacy", { uid: this.profile().uid, name, window: this.env.UNAME_LEGACY_WINDOW_MS });
        this.kvSet("uname_legacy_done", "1");
        if (r.status === "ok") {
          this.setUsernameLocal(r.username, "ok");
          if (r.displaced) { try { await this.call(r.displaced, "uname_revoked", { uid: this.profile().uid }); } catch { /* next hello */ } }
          return { username: r.username, status: "ok" };
        }
        this.kvSet("uname_status", "needs_new_name");
        return { username: null, status: "needs_new_name" };
      }
    } catch { /* registry unreachable: stay as before, retried on the next hello */ }
    return { username: null, status: this.kvGet("uname_status") || "none" };
  }

  /* Identity replaced: the retired uid's username follows the person to the new uid (or is held for them). */
  async transferUsername(old) {
    try {
      const p = this.profile();
      const r = await this.dirU("transfer", { from: old, to: p.uid, holdMs: this.env.UNAME_HOLD_MS });
      if (r.moved && r.username) {
        this.setUsernameLocal(r.username, "ok");
        this.run("UPDATE profile SET name=? WHERE id=1", r.username);
        this.push({ type: "username", username: r.username, status: "ok" });
      }
    } catch { /* registry unreachable: the name stays with the old uid until a retry */ }
  }

  async setUsername(ws, name) {
    const p = this.profile();
    if (!this.hit("uset", 10, 3600 * 1000)) {
      ws.send(JSON.stringify({ type: "username_result", op: "set", ok: false, reason: "rate-limited" }));
      return;
    }
    const r = await this.dirU("claim", { uid: p.uid, name, test: this.isTestAccount(), holdMs: this.env.UNAME_HOLD_MS });
    if (!r.ok) {
      ws.send(JSON.stringify({ type: "username_result", op: "set", ok: false, reason: reasonToError(r.reason), detail: r.reason }));
      return;
    }
    this.setUsernameLocal(r.username, "ok");
    this.kvSet("uname_legacy_done", "1");
    this.run("UPDATE profile SET name=? WHERE id=1", r.username);
    this.push({ type: "username", username: r.username, status: "ok", previous: r.previous || null });
    ws.send(JSON.stringify({ type: "username_result", op: "set", ok: true, username: r.username }));
    await this.broadcastPresence(true);
  }

  async dispatch(ws, att, msg) {
    const p = this.profile();
    const type = msg.type;
    const uidArg = (v) => (typeof v === "string" && UID_RE.test(v) ? v : null);
    switch (type) {
      case "status": {
        const st = sanitizeStatus(msg.status);
        if (!st) return this.err(ws, "bad-request", type);
        ws.serializeAttachment({ ...att, status: st });
        await this.broadcastPresence(false);
        break;
      }
      case "username_check": {
        if (!this.hit("ucheck", 40, 5 * 60 * 1000)) {
          ws.send(JSON.stringify({ type: "username_result", op: "check", ok: false, name: String(msg.name ?? "").slice(0, 32), reason: "rate-limited" }));
          break;
        }
        const r = await this.dirU("check", { uid: p.uid, name: msg.name, test: this.isTestAccount() });
        ws.send(JSON.stringify({
          type: "username_result", op: "check", name: String(msg.name ?? "").slice(0, 32), ok: !!r.ok,
          ...(r.ok ? { username: r.display, yours: !!r.yours } : { reason: reasonToError(r.reason), detail: r.reason }),
        }));
        break;
      }
      case "set_username": {
        if (typeof msg.name !== "string") return this.err(ws, "bad-request", type);
        await this.setUsername(ws, msg.name);
        break;
      }
      case "release_username": {
        // Give the name up (held for you 7 days so nobody can snipe it); you keep your display name until you pick a new one.
        const r = await this.dirU("release", { uid: p.uid, holdMs: this.env.UNAME_HOLD_MS });
        this.setUsernameLocal(null, "none");
        this.kvSet("uname_legacy_done", "1");
        this.push({ type: "username", username: null, status: "none", previous: r.released || null });
        break;
      }
      case "delete_account": {
        // Account deletion: the username is freed at once, friendships are removed and the uid can never connect again.
        if (msg.confirm !== true) return this.err(ws, "bad-request", type, "confirm-required");
        await this.dirU("release", { uid: p.uid, hold: false });
        for (const f of this.all("SELECT uid FROM friends")) {
          this.run("DELETE FROM friends WHERE uid=?", f.uid);
          try { await this.call(f.uid, "friend_removed", { uid: p.uid }); } catch { /* peer unreachable */ }
        }
        this.run("DELETE FROM requests");
        this.setUsernameLocal(null, "none");
        this.kvSet("retired", p.uid);
        try { await this.setOnline(false); } catch { /* lease expires */ }
        this.push({ type: "account_deleted" });
        for (const s of this.ctx.getWebSockets()) { try { s.close(4005, "deleted"); } catch { /* closed */ } }
        break;
      }
      case "rename": {
        if (this.kvGet("username")) return this.err(ws, "bad-request", type, "use-set-username");
        const name = cleanName(msg.name);
        if (!name) return this.err(ws, "bad-request", type);
        this.run("UPDATE profile SET name=? WHERE id=1", name);
        await this.broadcastPresence(true);
        break;
      }
      case "retire_old": {
        // This account replaced another one (adopted an older identity / linked a new PC). Prove ownership
        // of the old account with its secret; its friendships move here and it stops existing as a person.
        const old = uidArg(msg.uid);
        if (!old || old === p.uid || typeof msg.secret !== "string") return this.err(ws, "bad-request", type);
        if (!this.hit("retire", 10, 3600 * 1000)) return this.err(ws, "rate-limited", type);
        if (this.one("SELECT 1 FROM kv WHERE k=?", "retire_done:" + old)) {
          await this.transferUsername(old);
          await this.postAlias(old, p.uid);   // idempotent retry: an earlier attempt may have failed after the marker
          ws.send(JSON.stringify({ type: "retired", uid: old })); // already completed: never replay (would re-block)
          return;
        }
        const r = await this.call(old, "retire_begin", { uid: p.uid, secret: msg.secret });
        if (r.r === "gone") {
          // Another account already took over this identity: tell this one it is NOT the successor.
          return this.err(ws, "bad-request", type, "retired-elsewhere");
        }
        if (r.r === "bad-secret" || r.r === "none") {
          if (r.r === "bad-secret") { try { ws.send(JSON.stringify({ type: "error", reason: "bad-request", ref: type, detail: "bad-secret", uid: old })); } catch {} return; }
          ws.send(JSON.stringify({ type: "retired", uid: old })); // nothing (more) to move
          return;
        }
        if (r.r !== "ok") return this.err(ws, "bad-request", type, "retire-failed");
        const bkey = "retire_blocked:" + old;
        if (!this.one("SELECT 1 FROM kv WHERE k=?", bkey)) for (const u of r.blocked || []) {
          if (UID_RE.test(u) && u !== p.uid && !this.isBlocked(u) && this.count("blocked") < MAX_BLOCKED) {
            this.run("INSERT OR IGNORE INTO blocked (uid, at) VALUES (?, ?)", u, now());
            this.run("DELETE FROM friends WHERE uid=?", u);
            this.run("DELETE FROM requests WHERE uid=?", u);
            this.push({ type: "block_update", uid: u, blocked: true });
          }
        }
        this.run("INSERT OR REPLACE INTO kv (k, v) VALUES (?, '1')", bkey);
        const status = this.me().status;
        let failed = false, moved = 0;
        const seen = new Set();
        const people = [...(r.friends || []).map((f) => ({ uid: f.uid, name: f.name })),
                        ...(r.requests || []).map((q) => ({ uid: q.uid, name: q.name }))];
        for (const f of people) {
          if (!UID_RE.test(f.uid) || f.uid === p.uid || f.uid === old || seen.has(f.uid)) continue;
          seen.add(f.uid);
          if (this.isBlocked(f.uid)) continue;
          let pr;
          try {
            const lim = Number(this.env.TEST_RETIRE_FAIL_AFTER);
            if (lim > 0 && moved >= lim && !this.one("SELECT 1 FROM kv WHERE k='test_fail_used'")) {
              this.run("INSERT OR REPLACE INTO kv (k, v) VALUES ('test_fail_used', '1')");
              throw new Error("test crash");
            }
            pr = await this.call(f.uid, "replace_uid", { uid: old, to: p.uid, name: p.name, status });
          } catch { failed = true; break; }
          if (!pr || (pr.r !== "ok" && pr.r !== "none")) { failed = true; continue; } // "none": that account no longer exists
          if (pr.r !== "ok") continue;
          moved++;
          if (pr.linked) {
            if (!this.isFriend(f.uid) && this.count("friends") < this.friendCap(p)) {
              const row = this.addFriendRow(f.uid, f.name, null);
              this.push({ type: "friend_added", friend: row });
            }
          } else if ((pr.req === "out" || pr.req === "in") && !this.isFriend(f.uid)) {
            // mirror image of the peer's request
            const dirn = pr.req === "out" ? "in" : "out";
            if (!this.one("SELECT 1 FROM requests WHERE uid=?", f.uid)) {
              const q = { uid: f.uid, code: codeOf(f.uid), name: cleanName(f.name) || "player", at: now() };
              this.run("INSERT OR REPLACE INTO requests (uid, dir, code, name, at) VALUES (?, ?, ?, ?, ?)", f.uid, dirn, q.code, q.name, q.at);
              this.push({ type: "request", req: q, dir: dirn });
            }
          }
        }
        this.dedupeRows();
        if (failed) return this.err(ws, "bad-request", type, "retire-failed"); // snapshot kept on the old account: retry resumes
        await this.postAlias(old, p.uid);   // alias first, then the marker: a failed POST is retried on the early-return path
        await this.transferUsername(old);
        this.run("INSERT OR REPLACE INTO kv (k, v) VALUES (?, '1')", "retire_done:" + old);
        try { await this.call(old, "retire_done", { uid: p.uid, secret: msg.secret }); } catch { /* old stays inert; marker prevents replay */ }
        this.push({ type: "retired", uid: old });
        await this.broadcastPresence(true);
        break;
      }
      case "add_friend": {
        // By friend code (`code`) or by username (`username`, or a `code` that is not code-shaped).
        const raw = typeof msg.code === "string" ? msg.code.trim() : "";
        const byName = typeof msg.username === "string" ? msg.username
          : (raw && !CODE_RE.test(raw.toUpperCase()) && lookupKey(raw) ? raw : null);
        if (byName === null && typeof msg.code !== "string") return this.err(ws, "bad-request", type);
        if (!this.hit("add", 30, 3600 * 1000)) return this.err(ws, "rate-limited", type);
        let target;
        if (byName !== null) {
          const ur = await this.dirU("lookup", { name: byName });
          if (!ur.uid) return this.err(ws, "unknown-code", type, "unknown-username");
          target = ur.uid;
        } else {
          const m = CODE_RE.exec(raw.toUpperCase());
          if (!m) return this.err(ws, "unknown-code", type);
          const prefix = (m[1] + m[2]).toLowerCase();
          const dir = this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName("directory"));
          const lr = await (await dir.fetch(`https://directory/lookup?prefix=${prefix}`, { headers: { "x-rh-internal": "1" } })).json();
          if (!lr.uid) return this.err(ws, "unknown-code", type);
          target = lr.uid;
        }
        if (target === p.uid) return this.err(ws, "self", type);
        if (this.isBlocked(target)) return this.err(ws, "blocked", type);
        if (this.isFriend(target)) return this.err(ws, "already-friends", type);
        if (this.one("SELECT 1 FROM requests WHERE uid=? AND dir='in'", target)) {
          return this.acceptFlow(ws, target, true);
        }
        if (this.one("SELECT 1 FROM requests WHERE uid=? AND dir='out'", target)) {
          return this.err(ws, "bad-request", type, "already-requested");
        }
        if (this.count("requests", "dir='out'") >= MAX_OUT_REQ) return this.err(ws, "bad-request", type, "too-many-requests");
        if (this.count("friends") >= this.friendCap(p)) return this.err(ws, "bad-request", type, "friends-full");
        const me = this.me();
        const r = await this.call(target, "request", { uid: p.uid, code: p.code, name: p.name, status: me.status, at: now() });
        if (r.r === "ok" && this.isFriend(target)) {
          // the friendship completed while the request was in flight (crossed requests): nothing to record
        } else if (r.r === "ok") {
          const req = { uid: target, code: codeOf(target), name: cleanName(r.name) || "player", at: now() };
          if (this.one("SELECT 1 FROM requests WHERE uid=? AND dir='in'", target)) {
            // They asked us at the very same moment: one friendship, not two crossed requests.
            return this.acceptFlow(ws, target, true);
          }
          this.run("INSERT OR REPLACE INTO requests (uid, dir, code, name, at) VALUES (?, 'out', ?, ?, ?)", target, req.code, req.name, req.at);
          this.push({ type: "request", req, dir: "out" });
        } else if (r.r === "accepted") {
          this.run("DELETE FROM requests WHERE uid=?", target);
          const f = this.addFriendRow(target, r.friend.name, sanitizeStatus(r.friend.status));
          this.push({ type: "friend_added", friend: f });
        } else if (r.r === "full") {
          this.err(ws, "bad-request", type, "target-full");
        } else {
          this.err(ws, "unknown-code", type);
        }
        break;
      }
      case "accept": {
        const uid = uidArg(msg.uid);
        if (!uid) return this.err(ws, "bad-request", type);
        await this.acceptFlow(ws, uid);
        break;
      }
      case "decline":
      case "cancel": {
        const uid = uidArg(msg.uid);
        if (!uid) return this.err(ws, "bad-request", type);
        const dir = type === "decline" ? "in" : "out";
        if (!this.one("SELECT 1 FROM requests WHERE uid=? AND dir=?", uid, dir)) return this.err(ws, "bad-request", type, "no-such-request");
        this.run("DELETE FROM requests WHERE uid=? AND dir=?", uid, dir);
        const result = type === "decline" ? "declined" : "cancelled";
        this.push({ type: "request_update", uid, result });
        try { await this.call(uid, "request_update", { uid: p.uid, result }); } catch { /* peer unreachable */ }
        break;
      }
      case "remove_friend": {
        const uid = uidArg(msg.uid);
        if (!uid) return this.err(ws, "bad-request", type);
        if (!this.isFriend(uid)) return this.err(ws, "not-friends", type, undefined);
        this.run("INSERT OR REPLACE INTO kv (k, v) VALUES (?, '1')", "norelink:" + uid);   // never auto re-add someone we removed
        this.run("DELETE FROM friends WHERE uid=?", uid);
        this.push({ type: "friend_removed", uid });
        try { await this.call(uid, "friend_removed", { uid: p.uid }); } catch { /* peer unreachable */ }
        break;
      }
      case "block": {
        const uid = uidArg(msg.uid);
        if (!uid) return this.err(ws, "bad-request", type);
        if (uid === p.uid) return this.err(ws, "self", type);
        if (!this.isBlocked(uid)) {
          if (this.count("blocked") >= MAX_BLOCKED) return this.err(ws, "bad-request", type, "too-many-blocked");
          this.run("INSERT INTO blocked (uid, at) VALUES (?, ?)", uid, now());
        }
        const wasFriend = this.isFriend(uid);
        const hadIn = !!this.one("SELECT 1 FROM requests WHERE uid=? AND dir='in'", uid);
        const hadOut = !!this.one("SELECT 1 FROM requests WHERE uid=? AND dir='out'", uid);
        this.run("DELETE FROM friends WHERE uid=?", uid);
        this.run("DELETE FROM requests WHERE uid=?", uid);
        this.run("DELETE FROM inbox WHERE json LIKE ?", `%"from":"${uid}"%`);
        this.push({ type: "block_update", uid, blocked: true });
        if (wasFriend) {
          this.push({ type: "friend_removed", uid });
          try { await this.call(uid, "friend_removed", { uid: p.uid }); } catch { /* ignore */ }
        }
        if (hadIn) {
          this.push({ type: "request_update", uid, result: "declined" });
          try { await this.call(uid, "request_update", { uid: p.uid, result: "declined" }); } catch { /* ignore */ }
        }
        if (hadOut) {
          this.push({ type: "request_update", uid, result: "cancelled" });
          try { await this.call(uid, "request_update", { uid: p.uid, result: "cancelled" }); } catch { /* ignore */ }
        }
        break;
      }
      case "unblock": {
        const uid = uidArg(msg.uid);
        if (!uid) return this.err(ws, "bad-request", type);
        this.run("DELETE FROM blocked WHERE uid=?", uid);
        this.push({ type: "block_update", uid, blocked: false });
        break;
      }
      case "message": {
        const to = uidArg(msg.to);
        const text = cleanText(msg.text);
        if (!to || !text || typeof msg.text !== "string" || Array.from(text).length > MAX_TEXT) {
          return this.err(ws, "bad-request", type, "text");
        }
        if (!this.isFriend(to)) return this.err(ws, "not-friends", type, to);
        if (!this.hit("msg", 60, 60 * 1000)) return this.err(ws, "rate-limited", type, to);
        const m = { id: crypto.randomUUID(), from: p.uid, from_name: p.name, to, kind: "text", text, at: now() };
        const r = await this.call(to, "msg", { uid: p.uid, msg: m });
        if (r.r === "notfriend") return this.err(ws, "not-friends", type, to);
        if (r.r !== "ok") return this.err(ws, "bad-request", type, "undeliverable");
        this.saveHistory(to, m);
        break;
      }
      case "invite": {
        const inv = msg.invite;
        const lobby = inv && typeof inv === "object" ? String(inv.lobby_code || "").toUpperCase() : "";
        if (!Array.isArray(msg.to) || !LOBBY_RE.test(lobby)) return this.err(ws, "bad-request", type);
        const invite = {
          lobby_code: lobby,
          game_id: clean(inv.game_id, 64),
          game_title: clean(inv.game_title, 64),
          system: clean(inv.system, 32),
          expires_at: now() + INVITE_TTL,
        };
        const targets = [...new Set(msg.to.filter((u) => uidArg(u)))].slice(0, 50);
        const results = [];
        for (const to of targets) {
          if (!this.isFriend(to)) { this.err(ws, "not-friends", type, to); results.push({ uid: to, ok: false, reason: "not-friends" }); continue; }
          if (!this.hit("invite", 20, 60 * 1000)) { this.err(ws, "rate-limited", type, to); results.push({ uid: to, ok: false, reason: "rate-limited" }); break; }
          const m = { id: crypto.randomUUID(), from: p.uid, from_name: p.name, to, kind: "invite", invite, at: now() };
          // r:"ok" also covers a silent drop by a blocker (deliberately indistinguishable: privacy).
          let ok = false, reason = "undeliverable";
          try {
            const r = await this.call(to, "msg", { uid: p.uid, msg: m });
            ok = !!r && r.r === "ok";
            if (r && r.r === "notfriend") reason = "not-friends";
          } catch { /* unreachable */ }
          results.push(ok ? { uid: to, ok: true } : { uid: to, ok: false, reason });
        }
        try { ws.send(JSON.stringify({ type: "invite_result", lobby_code: lobby, results })); } catch { /* closing */ }
        break;
      }
      case "prefs": {
        if (typeof msg.auto_friend === "boolean") this.run("INSERT OR REPLACE INTO kv (k, v) VALUES ('auto_friend', ?)", msg.auto_friend ? "1" : "0");
        break;
      }
      case "ack": {
        if (!Array.isArray(msg.ids)) return this.err(ws, "bad-request", type);
        for (const id of msg.ids.slice(0, MAX_INBOX)) {
          if (typeof id === "string" && id.length <= 64) this.run("DELETE FROM inbox WHERE id=?", id);
        }
        break;
      }
      case "history": {
        const uid = uidArg(msg.with);
        if (!uid) return this.err(ws, "bad-request", type);
        const before = Number.isFinite(msg.before) ? msg.before : now() + 1;
        const rows = this.all("SELECT json FROM history WHERE peer=? AND at<? ORDER BY at DESC LIMIT 50", uid, before);
        ws.send(JSON.stringify({ type: "history", with: uid, msgs: rows.reverse().map((r) => JSON.parse(r.json)) }));
        break;
      }
      default:
        break;
    }
  }

  /* Friend-list cap for this account: the admin account gets the larger cap. */
  friendCap(p) {
    const t = Number(this.env.TEST_FRIEND_CAP);   // local tests only (never set in production)
    if (t > 0) return t;
    return this.env.ADMIN_UID && p.uid === this.env.ADMIN_UID ? ADMIN_MAX_FRIENDS : MAX_FRIENDS;
  }

  /* Room auto-friending (see hub.js): may this account be auto-linked with `other`? Returns null when yes, else a
   * reason: test | off | blocked | already | skip (we removed them earlier) | full | rate. Consumes one rate token only
   * when everything else passes (40 auto-links per hour per account). */
  autoPairCheck(other, otherName, skipRate) {
    const p = this.profile();
    if (!UID_RE.test(other || "") || other === p.uid) return "skip";
    if (this.one("SELECT 1 FROM kv WHERE k='is_test'") || isTestName(p.name) || isTestName(otherName)) return "test";
    const t = this.one("SELECT v FROM kv WHERE k='auto_friend'");
    if (t && t.v === "0") return "off";
    if (this.isBlocked(other)) return "blocked";
    if (this.isFriend(other)) return "already";
    if (this.one("SELECT 1 FROM kv WHERE k=?", "norelink:" + other)) return "skip";
    if (this.count("friends") >= this.friendCap(p)) return "full";
    if (!skipRate && !this.hit("autopair", 40, 60 * 60 * 1000)) return "rate";
    return null;
  }

  /* Every RetroHub user starts out friends with the admin (env ADMIN_UID), both
   * ways. Done once per user: if either side removes or blocks the other later,
   * it is not re-added. If the admin's side is full, retry after a day. */
  async autoLinkAdmin(p) {
    const admin = this.env.ADMIN_UID;
    if (!admin || !UID_RE.test(admin) || p.uid === admin) return;
    if (this.one("SELECT 1 FROM kv WHERE k='admin_linked'")) return;
    if (this.one("SELECT 1 FROM kv WHERE k='is_test'") || isTestName(p.name)) return;   // QA/test accounts never touch the admin's list
    const retry = this.one("SELECT v FROM kv WHERE k='admin_link_retry'");
    if (retry && now() < Number(retry.v)) return;
    if (this.isFriend(admin) || this.isBlocked(admin)) {
      this.run("INSERT OR REPLACE INTO kv (k, v) VALUES ('admin_linked', '1')");
      return;
    }
    let r;
    try {
      r = await this.call(admin, "admin_link", { uid: p.uid, name: p.name, status: this.me().status });
    } catch {
      return; // try again next connect
    }
    if (r && r.r === "ok" && r.friend) {
      this.run("DELETE FROM requests WHERE uid=?", admin);
      this.addFriendRow(admin, r.friend.name, sanitizeStatus(r.friend.status));
    }
    if (r && r.r === "full") {
      this.run("INSERT OR REPLACE INTO kv (k, v) VALUES ('admin_link_retry', ?)", String(now() + ADMIN_LINK_RETRY_MS));
      return;
    }
    if (r && (r.r === "ok" || r.r === "blocked")) {
      this.run("INSERT OR REPLACE INTO kv (k, v) VALUES ('admin_linked', '1')");
    }
  }

  async acceptFlow(ws, uid, crossed = false) {
    const p = this.profile();
    if (!this.one("SELECT 1 FROM requests WHERE uid=? AND dir='in'", uid)) return this.err(ws, "bad-request", "accept", "no-such-request");
    if (this.isBlocked(uid)) return this.err(ws, "blocked", "accept");
    if (this.count("friends") >= this.friendCap(p)) return this.err(ws, "bad-request", "accept", "friends-full");
    const me = this.me();
    const r = await this.call(uid, "request_update", { uid: p.uid, result: "accepted", name: p.name, status: me.status, crossed });
    if (r.r === "full") return this.err(ws, "bad-request", "accept", "target-full");
    if (r.r !== "ok") {
      // Their outgoing request vanished (cancelled / account gone): drop ours, tell the client, refresh its list.
      this.run("DELETE FROM requests WHERE uid=?", uid);
      this.push({ type: "request_update", uid, result: "cancelled" });
      return this.err(ws, "bad-request", "accept", "no-such-request");
    }
    this.run("DELETE FROM requests WHERE uid=?", uid);
    this.push({ type: "request_update", uid, result: "accepted" });
    const f = this.addFriendRow(uid, r.friend.name, sanitizeStatus(r.friend.status));
    this.push({ type: "friend_added", friend: f });
  }

  async webSocketClose(ws, code) {
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, "closed"); } catch { /* already closed */ }
    const a = ws.deserializeAttachment();
    if (a && a.authed) {
      if (this.authedSockets(ws).length === 0) await this.setOnline(false);
      await this.broadcastPresence(false, ws);
    }
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws, 1011);
  }
}
