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
//   /link/keep    {uid, secret, box, salt, iv, ct}  -> {ok}               (PERSISTENT account code)
//   /link/keep    {uid, secret, remove:true}   -> {ok}                    (revoke the persistent code)
//
// Two code kinds share one mechanism. 8 chars (XXXX-XXXX): temporary, single use, 10 min.
// 12 chars (XXXX-XXXX-XXXX): persistent "add/recover this account" code. The CLIENT generates it and
// sends only box = sha256hex(normalized 12-char code) plus the opaque encrypted bundle; the server never
// sees the code. Redeeming a persistent code returns {salt,iv,ct,username} and does NOT consume it. One
// persistent code per account: a new /link/keep (or remove) revokes the previous one. A hash already used
// by another account -> 409 code-in-use. Auth and the per-uid rate limit (5/h) are shared with /link/create.
//
// Storage: LinkBox Durable Object, one per code (keyed by sha256(code)), plus one per
// client IP for redeem rate limiting. Auth reuses the UserHub secret check (/i/link_auth).
// Env: LINK_TTL_SECONDS (default 600), LINK_REDEEM_LIMIT (default 10 attempts per hour per IP),
//      LINK_GLOBAL_LIMIT (default 300 failed redeems per hour across all IPs).
//
// Security (brute force). The 12-char permanent code is 31^12 = 2^59.4 combinations; the 8-char temporary code
// is 31^8 = 2^39.6 but lives 10 minutes and is single use. Guessing is bounded three ways: (1) per IP, 10 redeem
// attempts per hour; exceeding it locks that IP out for an hour, doubling on every further strike (cap 24 h,
// strikes decay after 24 h of quiet); (2) globally, 300 failed redeems per hour across ALL IPs, after which every
// redeem answers 429 until the window ends (stops botnets; legit users retry later); (3) the lookup is by
// sha256(code) (a Durable Object per hash) and the stored hash is compared in constant time before any bundle is
// returned. At 300 guesses/hour a 2^59 space takes ~10^14 years; 2^39.6 against a live 10-minute code is < 10^-8.

import { DurableObject } from "cloudflare:workers";

const UID_RE = /^[a-z2-7]{26}$/;
// 31 unambiguous characters (no I, L, O, 0, 1). Rejection sampling keeps it uniform.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$|^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{12}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const B64_RE = /^[A-Za-z0-9+/]{1,4096}={0,2}$/;
const MAX_BODY = 8192;
// Brute-force defence for /link/redeem (see "Security" below).
const REDEEM_WINDOW_MS = 60 * 60 * 1000;          // per-IP window: LINK_REDEEM_LIMIT (default 10) attempts per hour
const LOCK_MAX_MS = 24 * 60 * 60 * 1000;          // lockout backoff cap
const GLOBAL_WINDOW_MS = 60 * 60 * 1000;          // global window: LINK_GLOBAL_LIMIT (default 300) FAILED redeems per hour

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

// Accepts "ABCD-EFGH", "abcd efgh", "ABCDEFGH" (or the 12-char form) and returns the canonical code or null.
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
  return Number.isFinite(n) && n > 0 ? n : 10;
}

function globalLimit(env) {
  const n = Number(env.LINK_GLOBAL_LIMIT);
  return Number.isFinite(n) && n > 0 ? n : 300;
}

// Constant-time string equality (length is public: always 64 hex chars here).
export function timingSafeEqualStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function rateLimited(retryAfterMs) {
  const secs = Math.max(1, Math.ceil((retryAfterMs || 60000) / 1000));
  return new Response(JSON.stringify({ error: "rate-limited", retryAfter: secs }), {
    status: 429, headers: { "content-type": "application/json", "retry-after": String(secs) },
  });
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
      const r = await boxCall(env, boxKey, "reserve", { uid: body.uid, expires, username, hash: boxKey });
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

  if (url.pathname === "/link/keep") {
    const removing = body.remove === true;
    if (!removing && (typeof body.box !== "string" || !HEX64_RE.test(body.box) || !B64_RE.test(body.salt || "") || !B64_RE.test(body.iv || "") || !B64_RE.test(body.ct || ""))) {
      return json({ error: "bad-request" }, 400);
    }
    const af = await authFull(env, body.uid, body.secret, !removing);
    const a = af.r || "none";
    if (a === "rate") return json({ error: "rate-limited" }, 429);
    if (a !== "ok") return json({ error: "auth" }, 403);
    const hubSet = (box) => env.USER_HUBS.get(env.USER_HUBS.idFromName(body.uid)).fetch("https://userhub/i/link_set", {
      method: "POST", headers: { "x-rh-internal": "1", "content-type": "application/json" },
      body: JSON.stringify({ uid: body.uid, secret: body.secret, kind: "keep", box }),
    });
    if (removing) {
      if (af.keep) await boxCall(env, af.keep, "revoke", { uid: body.uid });
      await hubSet("");
      return json({ ok: true });
    }
    const username = typeof af.username === "string" ? af.username : "";
    const r = await boxCall(env, body.box, "keep", { uid: body.uid, salt: body.salt, iv: body.iv, ct: body.ct, username, hash: body.box });
    if (!r.ok) return json({ error: "code-in-use" }, 409);
    if (af.keep && af.keep !== body.box) await boxCall(env, af.keep, "revoke", { uid: body.uid });
    await hubSet(body.box);
    return json({ ok: true });
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
    const gl = await boxCall(env, "rl:global", "peek", { limit: globalLimit(env), windowMs: GLOBAL_WINDOW_MS });
    if (!gl.ok) return rateLimited(gl.retryAfter);
    const lim = await boxCall(env, `rl:${ip}`, "hit", { limit: redeemLimit(env), windowMs: REDEEM_WINDOW_MS, backoff: true });
    if (!lim.ok) return rateLimited(lim.retryAfter);
    const hash = await sha256hex(code);
    const r = await boxCall(env, hash, "take", { hash });
    if (r.status === "ok") return json({ salt: r.salt, iv: r.iv, ct: r.ct, username: r.username || null });
    // Failed guess: count it against the global budget too.
    await boxCall(env, "rl:global", "hit", { limit: globalLimit(env), windowMs: GLOBAL_WINDOW_MS });
    if (r.status === "pending") return json({ error: "pending" }, 409);
    return json({ error: "invalid" }, 404);
  }

  return new Response("not found", { status: 404 });
}

// One row per link code (state: reserved -> bundle stored -> taken/expired), or one row
// per IP for rate limiting. Temporary rows are single-use (deleted on the first take); keep rows persist until revoked.
export class LinkBox extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS link (id INTEGER PRIMARY KEY CHECK (id = 1), uid TEXT NOT NULL, expires INTEGER NOT NULL, salt TEXT, iv TEXT, ct TEXT)");
    try { this.sql.exec("ALTER TABLE link ADD COLUMN username TEXT"); } catch { /* already added */ }
    try { this.sql.exec("ALTER TABLE link ADD COLUMN hash TEXT"); } catch { /* already added */ }
    try { this.sql.exec("ALTER TABLE link ADD COLUMN keep INTEGER NOT NULL DEFAULT 0"); } catch { /* already added */ }
    this.sql.exec("CREATE TABLE IF NOT EXISTS rl (id INTEGER PRIMARY KEY CHECK (id = 1), start INTEGER NOT NULL, n INTEGER NOT NULL)");
    try { this.sql.exec("ALTER TABLE rl ADD COLUMN strikes INTEGER NOT NULL DEFAULT 0"); } catch { /* already added */ }
    try { this.sql.exec("ALTER TABLE rl ADD COLUMN locked_until INTEGER NOT NULL DEFAULT 0"); } catch { /* already added */ }
  }

  async fetch(request) {
    if (request.headers.get("x-rh-internal") !== "1") return new Response("forbidden", { status: 403 });
    const route = new URL(request.url).pathname;
    const b = (await request.json().catch(() => ({}))) || {};
    const t = now();
    if (route === "/hit" || route === "/peek") {
      const peek = route === "/peek";
      let row = this.sql.exec("SELECT start, n, strikes, locked_until FROM rl WHERE id = 1").toArray()[0];
      if (row && row.locked_until > t) return json({ ok: false, retryAfter: row.locked_until - t });
      // Strikes decay after 24 h of quiet.
      const strikes = row && t - Math.max(row.start, row.locked_until) < LOCK_MAX_MS ? row.strikes : 0;
      if (!row || t - row.start >= b.windowMs) {
        if (peek) return json({ ok: true });
        this.sql.exec("INSERT OR REPLACE INTO rl (id, start, n, strikes, locked_until) VALUES (1, ?, 1, ?, 0)", t, strikes);
        return json({ ok: true });
      }
      if (row.n >= b.limit) {
        if (peek) return json({ ok: false, retryAfter: row.start + b.windowMs - t });
        if (b.backoff) {
          const lock = Math.min(LOCK_MAX_MS, b.windowMs * Math.pow(2, strikes));
          this.sql.exec("UPDATE rl SET strikes = ?, locked_until = ?, start = ?, n = 0 WHERE id = 1", strikes + 1, t + lock, t + lock);
          return json({ ok: false, retryAfter: lock });
        }
        return json({ ok: false, retryAfter: row.start + b.windowMs - t });
      }
      if (!peek) this.sql.exec("UPDATE rl SET n = n + 1 WHERE id = 1");
      return json({ ok: true });
    }

    const row = this.sql.exec("SELECT * FROM link WHERE id = 1").toArray()[0] || null;
    if (row && !row.keep && row.expires <= t) {
      this.sql.exec("DELETE FROM link WHERE id = 1");
      if (route !== "/reserve") return json({ ok: false, error: "invalid", status: "invalid" });
    }
    const live = row && (row.keep || row.expires > t) ? row : null;

    if (route === "/reserve") {
      if (live) return json({ ok: false, error: "exists" });
      this.sql.exec("INSERT INTO link (id, uid, expires, username, hash) VALUES (1, ?, ?, ?, ?)", b.uid, b.expires, b.username || null, b.hash || null);
      return json({ ok: true });
    }
    if (route === "/keep") {
      if (live && live.uid !== b.uid) return json({ ok: false, error: "exists" });
      this.sql.exec("INSERT OR REPLACE INTO link (id, uid, expires, salt, iv, ct, username, hash, keep) VALUES (1, ?, 0, ?, ?, ?, ?, ?, 1)", b.uid, b.salt, b.iv, b.ct, b.username || null, b.hash || null);
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
      if (live.hash && !timingSafeEqualStr(String(b.hash || ""), live.hash)) return json({ status: "invalid" });
      if (!live.ct) return json({ status: "pending" });
      if (!live.keep) this.sql.exec("DELETE FROM link WHERE id = 1");
      return json({ status: "ok", salt: live.salt, iv: live.iv, ct: live.ct, username: live.username || null });
    }
    return new Response("not found", { status: 404 });
  }
}
