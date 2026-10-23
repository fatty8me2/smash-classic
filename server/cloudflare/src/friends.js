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

export class Directory extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS dir (prefix TEXT PRIMARY KEY, uid TEXT NOT NULL)");
    // Accounts with at least one authed socket. Lets a sender fan presence out to
    // online friends only, with one call here instead of one per friend.
    this.sql.exec("CREATE TABLE IF NOT EXISTS online (uid TEXT PRIMARY KEY)");
  }

  async fetch(request) {
    if (request.headers.get("x-rh-internal") !== "1") return new Response("forbidden", { status: 403 });
    const url = new URL(request.url);
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
      if (on) this.sql.exec("INSERT OR REPLACE INTO online (uid) VALUES (?)", uid);
      else this.sql.exec("DELETE FROM online WHERE uid=?", uid);
      return json({ ok: true });
    }
    if (url.pathname === "/online-of" && request.method === "POST") {
      const { uids } = await request.json();
      const list = (Array.isArray(uids) ? uids : []).filter((u) => UID_RE.test(u)).slice(0, 5000);
      const set = new Set(this.sql.exec("SELECT uid FROM online").toArray().map((r) => r.uid));
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
    try {
      await dir.fetch("https://directory/online", {
        method: "POST",
        headers: { "x-rh-internal": "1", "content-type": "application/json" },
        body: JSON.stringify({ uid: this.profile().uid, on }),
      });
    } catch {
      // directory unreachable: presence falls back to the next transition
    }
  }

  addFriendRow(uid, name, status) {
    this.run("INSERT OR REPLACE INTO friends (uid, code, name, status, since) VALUES (?, ?, ?, ?, ?)",
      uid, codeOf(uid), cleanName(name) || "player", JSON.stringify(status || offlineStatus()), now());
    return this.friendObj(this.one("SELECT * FROM friends WHERE uid=?", uid));
  }

  saveHistory(peer, msg) {
    this.run("INSERT OR REPLACE INTO history (id, peer, json, at) VALUES (?, ?, ?, ?)", msg.id, peer, JSON.stringify(msg), msg.at);
    this.run("DELETE FROM history WHERE peer=? AND id NOT IN (SELECT id FROM history WHERE peer=? ORDER BY at DESC LIMIT ?)",
      peer, peer, MAX_HISTORY);
  }

  // ---- fetch (WebSocket upgrade + internal routes) -----------------------

  async fetch(request) {
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
    switch (route) {
      case "link_auth": {
        // Secret check for /link/* (see link.js). Optionally rate-limits link-code creation.
        if (p.secret_hash !== (await sha256hex(String(b.secret ?? "")))) return { r: "bad-secret" };
        if (b.count && !this.hit(`link:${from}`, 5, 60 * 60 * 1000)) return { r: "rate" };
        return { r: "ok" };
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
        if (this.isBlocked(from)) return { r: "ok", name: "player", code: p.code };
        if (this.isFriend(from)) return { r: "already" };
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
          if (!this.one("SELECT 1 FROM requests WHERE uid=? AND dir='out'", from) || this.isBlocked(from)) return { r: "none" };
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
        if (this.isBlocked(from)) return { r: "blocked" };
        if (!this.isFriend(from)) {
          if (this.count("friends") >= this.friendCap(p)) return { r: "full" };
          this.run("DELETE FROM requests WHERE uid=?", from);
          const f = this.addFriendRow(from, cleanName(b.name) || "player", sanitizeStatus(b.status));
          this.push({ type: "friend_added", friend: f });
        }
        return { r: "ok", friend: this.me() };
      }
      case "friend_removed": {
        if (!this.isFriend(from)) return { r: "none" };
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
    if (!this.msgLimit.hit("m")) {
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
    let renamed = false;
    if (p.name !== name) {
      this.run("UPDATE profile SET name=? WHERE id=1", name);
      p.name = name;
      renamed = true;
    }
    const wasOnline = this.authedSockets().length > 0;
    ws.serializeAttachment({ uid, authed: true, status: { state: "online", updated: now() } });
    await this.autoLinkAdmin(p);
    if (!wasOnline) {
      // First socket up: announce ourselves and pull friends' current statuses before the welcome.
      await this.setOnline(true);
      await this.broadcastPresence(true);
    }

    this.run("DELETE FROM inbox WHERE at < ?", now() - INBOX_TTL);
    const friends = this.all("SELECT * FROM friends ORDER BY name").map((r) => this.friendObj(r));
    const reqs = this.all("SELECT uid, dir, code, name, at FROM requests ORDER BY at");
    const strip = ({ uid: u, code, name: n, at }) => ({ uid: u, code, name: n, at });
    ws.send(JSON.stringify({
      type: "welcome",
      code: p.code,
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
      case "rename": {
        const name = cleanName(msg.name);
        if (!name) return this.err(ws, "bad-request", type);
        this.run("UPDATE profile SET name=? WHERE id=1", name);
        await this.broadcastPresence(true);
        break;
      }
      case "add_friend": {
        if (typeof msg.code !== "string") return this.err(ws, "bad-request", type);
        if (!this.hit("add", 30, 3600 * 1000)) return this.err(ws, "rate-limited", type);
        const m = CODE_RE.exec(msg.code.trim().toUpperCase());
        if (!m) return this.err(ws, "unknown-code", type);
        const prefix = (m[1] + m[2]).toLowerCase();
        const dir = this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName("directory"));
        const lr = await (await dir.fetch(`https://directory/lookup?prefix=${prefix}`, { headers: { "x-rh-internal": "1" } })).json();
        if (!lr.uid) return this.err(ws, "unknown-code", type);
        const target = lr.uid;
        if (target === p.uid) return this.err(ws, "self", type);
        if (this.isBlocked(target)) return this.err(ws, "blocked", type);
        if (this.isFriend(target)) return this.err(ws, "already-friends", type);
        if (this.one("SELECT 1 FROM requests WHERE uid=? AND dir='in'", target)) {
          return this.acceptFlow(ws, target);
        }
        if (this.one("SELECT 1 FROM requests WHERE uid=? AND dir='out'", target)) {
          return this.err(ws, "bad-request", type, "already-requested");
        }
        if (this.count("requests", "dir='out'") >= MAX_OUT_REQ) return this.err(ws, "bad-request", type, "too-many-requests");
        if (this.count("friends") >= this.friendCap(p)) return this.err(ws, "bad-request", type, "friends-full");
        const me = this.me();
        const r = await this.call(target, "request", { uid: p.uid, code: p.code, name: p.name, status: me.status, at: now() });
        if (r.r === "ok") {
          const req = { uid: target, code: codeOf(target), name: cleanName(r.name) || "player", at: now() };
          this.run("INSERT OR REPLACE INTO requests (uid, dir, code, name, at) VALUES (?, 'out', ?, ?, ?)", target, req.code, req.name, req.at);
          this.push({ type: "request", req, dir: "out" });
        } else if (r.r === "accepted") {
          this.run("DELETE FROM requests WHERE uid=?", target);
          const f = this.addFriendRow(target, r.friend.name, sanitizeStatus(r.friend.status));
          this.push({ type: "friend_added", friend: f });
        } else if (r.r === "already") {
          this.err(ws, "already-friends", type);
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
        for (const to of targets) {
          if (!this.isFriend(to)) { this.err(ws, "not-friends", type, to); continue; }
          if (!this.hit("invite", 20, 60 * 1000)) { this.err(ws, "rate-limited", type, to); break; }
          const m = { id: crypto.randomUUID(), from: p.uid, from_name: p.name, to, kind: "invite", invite, at: now() };
          try { await this.call(to, "msg", { uid: p.uid, msg: m }); } catch { /* unreachable */ }
        }
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
    return this.env.ADMIN_UID && p.uid === this.env.ADMIN_UID ? ADMIN_MAX_FRIENDS : MAX_FRIENDS;
  }

  /* Every RetroHub user starts out friends with the admin (env ADMIN_UID), both
   * ways. Done once per user: if either side removes or blocks the other later,
   * it is not re-added. If the admin's side is full, retry after a day. */
  async autoLinkAdmin(p) {
    const admin = this.env.ADMIN_UID;
    if (!admin || !UID_RE.test(admin) || p.uid === admin) return;
    if (this.one("SELECT 1 FROM kv WHERE k='admin_linked'")) return;
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

  async acceptFlow(ws, uid) {
    const p = this.profile();
    if (!this.one("SELECT 1 FROM requests WHERE uid=? AND dir='in'", uid)) return this.err(ws, "bad-request", "accept", "no-such-request");
    if (this.isBlocked(uid)) return this.err(ws, "blocked", "accept");
    if (this.count("friends") >= this.friendCap(p)) return this.err(ws, "bad-request", "accept", "friends-full");
    const me = this.me();
    const r = await this.call(uid, "request_update", { uid: p.uid, result: "accepted", name: p.name, status: me.status });
    if (r.r === "full") return this.err(ws, "bad-request", "accept", "target-full");
    this.run("DELETE FROM requests WHERE uid=?", uid);
    this.push({ type: "request_update", uid, result: "accepted" });
    if (r.r !== "ok") return; // their outgoing request vanished; just drop ours
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
