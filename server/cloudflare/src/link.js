// RetroHub "link a new PC": short-lived, single-use link codes that carry an identity
// bundle encrypted end-to-end. The client derives the AES key from the code (PBKDF2),
// so this server only stores and returns opaque ciphertext (salt, iv, ct, base64). It
// never sees the code-derived key nor the plaintext identity.
//
// Flow (all POST JSON, public, forwarded from index.js for /link/*):
//   /link/create  {uid, secret}                -> {code, expires_at}     (rate limited per uid)
//   /link/put     {uid, secret, code, salt, iv, ct}  -> {ok}            (old PC uploads the bundle)
//   /link/redeem  {code}                       -> {salt, iv, ct}         (new PC; single use)
//                                               or {error:"pending"|"invalid"}
//
// Storage: LinkBox Durable Object, one per code (keyed by sha256(code)), plus one per
// client IP for redeem rate limiting. Auth reuses the UserHub secret check (/i/link_auth).
// Env: LINK_TTL_SECONDS (default 600), LINK_REDEEM_LIMIT (default 20 per 10 min per IP).

import { DurableObject } from "cloudflare:workers";

const UID_RE = /^[a-z2-7]{26}$/;
// 31 unambiguous characters (no I, L, O, 0, 1). Rejection sampling keeps it uniform.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/;
const B64_RE = /^[A-Za-z0-9+/]{1,4096}={0,2}$/;
const MAX_BODY = 8192;
const REDEEM_WINDOW_MS = 10 * 60 * 1000;

const now = () => Date.now();

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

async function sha256hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Uniform random code of 8 characters from ALPHABET (rejection sampling on bytes).
function newCode() {
  const out = [];
  const buf = new Uint8Array(32);
  while (out.length < 8) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b < 248 && out.length < 8) out.push(ALPHABET[b % 31]);
    }
  }
  return out.join("");
}

// Accepts "ABCD-EFGH", "abcd efgh", "ABCDEFGH" and returns the canonical 8 chars or null.
function normalizeCode(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.replace(/[\s-]/g, "").toUpperCase();
  return CODE_RE.test(s) ? s : null;
}

function boxFor(env, key) {
  return env.LINK_BOXES.get(env.LINK_BOXES.idFromName(key));
}

async function boxCall(env, key, route, body) {
  const res = await boxFor(env, key).fetch(`https://linkbox/${route}`, {
    method: "POST",
    headers: { "x-rh-internal": "1", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

function ttlMs(env) {
  const s = Number(env.LINK_TTL_SECONDS);
  return (Number.isFinite(s) && s > 0 ? s : 600) * 1000;
}

function redeemLimit(env) {
  const n = Number(env.LINK_REDEEM_LIMIT);
  return Number.isFinite(n) && n > 0 ? n : 20;
}

async function readBody(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) return { tooLarge: true };
  try {
    const b = JSON.parse(text);
    return b && typeof b === "object" ? b : null;
  } catch {
    return null;
  }
}

// Verifies the account secret on the user's own UserHub. Returns "ok", "bad-secret",
// "rate" (only when count is set) or "none" (no such account).
async function auth(env, uid, secret, count) {
  if (!UID_RE.test(uid) || typeof secret !== "string" || secret.length < 16 || secret.length > 128) return "none";
  const stub = env.USER_HUBS.get(env.USER_HUBS.idFromName(uid));
  const res = await stub.fetch("https://userhub/i/link_auth", {
    method: "POST",
    headers: { "x-rh-internal": "1", "content-type": "application/json" },
    body: JSON.stringify({ uid, secret, count: !!count }),
  });
  const r = await res.json();
  return r.r || "none";
}

// Same check as auth(), but returns the whole reply ({r, username, prev}).
async function authFull(env, uid, secret, count) {
  if (!UID_RE.test(uid) || typeof secret !== "string" || secret.length < 16 || secret.length > 128) return { r: "none" };
  const stub = env.USER_HUBS.get(env.USER_HUBS.idFromName(uid));
  const res = await stub.fetch("https://userhub/i/link_auth", {
    method: "POST",
    headers: { "x-rh-internal": "1", "content-type": "application/json" },
    body: JSON.stringify({ uid, secret, count: !!count }),
  });
  return res.json();
}

export async function linkFetch(request, env) {
  if (request.method !== "POST") return json({ error: "method" }, 405);
  const url = new URL(request.url);
  const body = await readBody(request);
  if (body && body.tooLarge) return json({ error: "too-large" }, 413);
  if (!body) return json({ error: "bad-request" }, 400);
  const ip = request.headers.get("cf-connecting-ip") || "local";

  if (url.pathname === "/link/create") {
    const af = await authFull(env, body.uid, body.secret, true);
    const a = af.r || "none";
    if (a === "rate") return json({ error: "rate-limited" }, 429);
    if (a !== "ok") return json({ error: "auth" }, 403);
    const username = typeof af.username === "string" ? af.username : "";
    const expires = now() + ttlMs(env);
    for (let i = 0; i < 3; i++) {
      const code = newCode();
      const boxKey = await sha256hex(code);
      const r = await boxCall(env, boxKey, "reserve", { uid: body.uid, expires, username });
      if (r.ok) {
        // One open code per account: a fresh code revokes the previous unredeemed one.
        try {
          if (af.prev && af.prev !== boxKey) await boxCall(env, af.prev, "revoke", { uid: body.uid });
          await env.USER_HUBS.get(env.USER_HUBS.idFromName(body.uid)).fetch("https://userhub/i/link_set", {
            method: "POST", headers: { "x-rh-internal": "1", "content-type": "application/json" },
            body: JSON.stringify({ uid: body.uid, secret: body.secret, box: boxKey }),
          });
        } catch { /* best effort */ }
      }
      if (r.ok) return json({ code: `${code.slice(0, 4)}-${code.slice(4)}`, expires_at: expires, username: username || null });
    }
    return json({ error: "busy" }, 503);
  }

  if (url.pathname === "/link/put") {
    const a = await auth(env, body.uid, body.secret, false);
    if (a !== "ok") return json({ error: "auth" }, 403);
    const code = normalizeCode(body.code);
    if (!code || !B64_RE.test(body.salt || "") || !B64_RE.test(body.iv || "") || !B64_RE.test(body.ct || "")) {
      return json({ error: "bad-request" }, 400);
    }
    const r = await boxCall(env, await sha256hex(code), "put", {
      uid: body.uid, salt: body.salt, iv: body.iv, ct: body.ct,
    });
    if (!r.ok) return json({ error: r.error || "invalid" }, r.error === "already" ? 409 : 404);
    return json({ ok: true });
  }

  if (url.pathname === "/link/redeem") {
    const code = normalizeCode(body.code);
    if (!code) return json({ error: "invalid" }, 404);
    const lim = await boxCall(env, `rl:${ip}`, "hit", { limit: redeemLimit(env), windowMs: REDEEM_WINDOW_MS });
    if (!lim.ok) return json({ error: "rate-limited" }, 429);
    const r = await boxCall(env, await sha256hex(code), "take", {});
    if (r.status === "ok") return json({ salt: r.salt, iv: r.iv, ct: r.ct, username: r.username || null });
    if (r.status === "pending") return json({ error: "pending" }, 409);
    return json({ error: "invalid" }, 404);
  }

  return new Response("not found", { status: 404 });
}

// One row per link code (state: reserved -> bundle stored -> taken/expired), or one row
// per IP for rate limiting. Single-use: the bundle is deleted on the first successful take.
export class LinkBox extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS link (id INTEGER PRIMARY KEY CHECK (id = 1), uid TEXT NOT NULL, expires INTEGER NOT NULL, salt TEXT, iv TEXT, ct TEXT)");
    try { this.sql.exec("ALTER TABLE link ADD COLUMN username TEXT"); } catch { /* already added */ }
    this.sql.exec("CREATE TABLE IF NOT EXISTS rl (id INTEGER PRIMARY KEY CHECK (id = 1), start INTEGER NOT NULL, n INTEGER NOT NULL)");
  }

  async fetch(request) {
    if (request.headers.get("x-rh-internal") !== "1") return new Response("forbidden", { status: 403 });
    const route = new URL(request.url).pathname;
    const b = (await request.json().catch(() => ({}))) || {};
    const t = now();
    if (route === "/hit") {
      const row = this.sql.exec("SELECT start, n FROM rl WHERE id = 1").toArray()[0];
      if (!row || t - row.start >= b.windowMs) {
        this.sql.exec("INSERT OR REPLACE INTO rl (id, start, n) VALUES (1, ?, 1)", t);
        return json({ ok: true });
      }
      if (row.n >= b.limit) return json({ ok: false });
      this.sql.exec("UPDATE rl SET n = n + 1 WHERE id = 1");
      return json({ ok: true });
    }

    const row = this.sql.exec("SELECT * FROM link WHERE id = 1").toArray()[0] || null;
    if (row && row.expires <= t) {
      this.sql.exec("DELETE FROM link WHERE id = 1");
      if (route !== "/reserve") return json({ ok: false, error: "invalid", status: "invalid" });
    }
    const live = row && row.expires > t ? row : null;

    if (route === "/reserve") {
      if (live) return json({ ok: false, error: "exists" });
      this.sql.exec("INSERT INTO link (id, uid, expires, username) VALUES (1, ?, ?, ?)", b.uid, b.expires, b.username || null);
      return json({ ok: true });
    }
    if (route === "/revoke") {
      if (live && live.uid === b.uid) this.sql.exec("DELETE FROM link WHERE id = 1");
      return json({ ok: true });
    }
    if (route === "/put") {
      if (!live || live.uid !== b.uid) return json({ ok: false, error: "invalid" });
      if (live.ct) return json({ ok: false, error: "already" });
      this.sql.exec("UPDATE link SET salt = ?, iv = ?, ct = ? WHERE id = 1", b.salt, b.iv, b.ct);
      return json({ ok: true });
    }
    if (route === "/take") {
      if (!live) return json({ status: "invalid" });
      if (!live.ct) return json({ status: "pending" });
      this.sql.exec("DELETE FROM link WHERE id = 1");
      return json({ status: "ok", salt: live.salt, iv: live.iv, ct: live.ct, username: live.username || null });
    }
    return new Response("not found", { status: 404 });
  }
}
