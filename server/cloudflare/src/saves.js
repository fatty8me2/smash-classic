// RetroHub optional cloud saves (R2). Second sync backend beside sync folders.
//
//   GET    /saves/list                  -> {ok, files:[{key,size,etag,sha,mtime}], used, quota, maxObject}
//   GET    /saves/obj?key=REL           -> object bytes (supports "Range: bytes=N-" to resume)
//   PUT    /saves/obj?key=REL           -> create/replace. Needs Content-Length, X-RH-Sha (sha256 hex of body),
//                                          X-RH-Mtime, and either If-None-Match: * (create) or If-Match: <etag>.
//                                          412 {error:"conflict", current:{etag,sha,mtime,size}} on mismatch.
//   DELETE /saves/obj?key=REL           -> optional If-Match
//
// Auth: Authorization: RHSIG uid=<26 b32>,ts=<unix ms>,sig=<hex>
//   sig = HMAC-SHA256(key = sha256hex(account secret),
//         "METHOD\n/saves/...?query\nts\nX-RH-Sha\nIf-Match\nIf-None-Match\nContent-Length\nX-RH-Mtime")
//   (each header value, or "-" when absent)
// The Worker never sees the secret itself; the account's UserHub Durable Object holds sha256hex(secret) (the same
// value the friends hello checks) and hands it to this module over the internal route "saves_auth", which also
// applies the per-account rate limit. The R2 key is always saves/<uid>/<rel> with uid taken from the verified
// signature, so one account can never address another's objects.
//
// If the SAVES R2 binding is absent every /saves route answers 503 {error:"cloud-saves-disabled"}.

import { cleanKey } from "./saves_pool.js";
import { savesV2Fetch } from "./saves_v2.js";

const UID_RE = /^[a-z2-7]{26}$/;
export const MAX_OBJECT = 16 * 1024 * 1024;
export const QUOTA = 200 * 1024 * 1024;   // per account (env SAVES_QUOTA overrides, for tests)
export const MAX_FILES = 1500;
const SKEW_MS = 5 * 60 * 1000;
export const HEX64 = /^[0-9a-f]{64}$/;

export function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...extra } });
}
export const err = (status, code, extra = {}) => json({ ok: false, error: code, ...extra }, status);

const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

async function hmacHex(keyStr, msg) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(keyStr), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}

function safeEq(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export { cleanKey };

export async function authenticate(request, env, url, write, cls) {
  const h = request.headers.get("Authorization") || "";
  const m = /^RHSIG uid=([a-z2-7]{26}),ts=(\d{10,16}),sig=([0-9a-f]{64})$/.exec(h);
  if (!m) return { res: err(401, "unauthorized") };
  const [, uid, ts, sig] = m;
  if (Math.abs(Date.now() - Number(ts)) > SKEW_MS) return { res: err(401, "stale-timestamp", { serverTime: Date.now() }) };
  const hub = env.USER_HUBS.get(env.USER_HUBS.idFromName(uid));
  const r = await hub.fetch("https://userhub/i/saves_auth", {
    method: "POST",
    headers: { "x-rh-internal": "1", "content-type": "application/json" },
    body: JSON.stringify({ uid, write, cls }),
  });
  const a = await r.json();
  if (a.r === "limited") return { res: err(429, "rate-limited", { retryAfter: 60 }) };
  if (a.r !== "ok" || typeof a.key !== "string") return { res: err(401, "unauthorized") };
  const hv = (n) => request.headers.get(n) || "-";
  const msgS = `${request.method}\n${url.pathname}${url.search}\n${ts}\n${hv("X-RH-Sha")}\n${hv("If-Match")}\n${hv("If-None-Match")}\n${request.method === "PUT" ? hv("Content-Length") : "-"}\n${hv("X-RH-Mtime")}`; const want = await hmacHex(a.key, msgS);
  if (!safeEq(want, sig)) return { res: err(401, "unauthorized") };
  return { uid };
}

// Every R2 call goes through the global R2Budget Durable Object first (src/r2budget.js). If it errors or is
// unreachable the operation is refused: fail CLOSED.
export class BudgetDown extends Error {}
export async function budget(env, body) {
  try {
    const r = await env.R2_BUDGET.get(env.R2_BUDGET.idFromName("global")).fetch("https://budget/b", {
      method: "POST", headers: { "x-rh-internal": "1", "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error("budget " + r.status);
    return await r.json();
  } catch (e) { throw new BudgetDown(String(e)); }
}
const busyToday = () => err(429, "cloud-saves-busy-today", { retryAfter: 3600 });
const unavailable = () => err(429, "cloud-saves-unavailable", { retryAfter: 600 });
const paused = () => err(429, "cloud-saves-paused", { retryAfter: 3600 });
const full = () => err(507, "cloud-saves-full");

export async function savesFetch(request, env) {
  if (!env.SAVES) return err(503, "cloud-saves-disabled");
  if (!env.R2_BUDGET) return err(503, "cloud-saves-disabled");   // no budget guard -> never touch R2
  try { return await savesInner(request, env); }
  catch (e) {
    if (e instanceof BudgetDown) return unavailable();
    console.error("saves: unexpected", e && e.stack || String(e));
    return err(503, "cloud-saves-error", { retryAfter: 60 });
  }
}

async function savesInner(request, env) {
  const testRes = await testHooks(request, env);
  if (testRes) return testRes;
  const url = new URL(request.url);
  const route = url.pathname;
  const method = request.method;
  if (route.startsWith("/saves/v2/")) return savesV2Fetch(request, env, url);
  const isObj = route === "/saves/obj";
  if (!(route === "/saves/list" && method === "GET") && !(isObj && ["GET", "PUT", "DELETE"].includes(method))) {
    return err(route.startsWith("/saves/") ? 405 : 404, "not-found");
  }
  const write = method !== "GET";
  if (method === "PUT") {
    const len = Number(request.headers.get("Content-Length"));
    if (!Number.isFinite(len) || len < 0 || !request.headers.has("Content-Length")) return err(411, "length-required");
    if (len > MAX_OBJECT) return err(413, "object-too-large", { max: MAX_OBJECT });
  }
  const au = await authenticate(request, env, url, write);
  if (au.res) return au.res;
  const prefix = `saves/${au.uid}/`;

  if (route === "/saves/list") {
    const l = await budget(env, { op: "list", uid: au.uid });   // served from the DO index: zero R2 ops
    return json({ ok: true, files: l.files, used: l.used, quota: l.quota, maxObject: MAX_OBJECT });
  }

  const key = cleanKey(url.searchParams.get("key"));
  if (!key) return err(400, "bad-key");
  const rkey = prefix + key;

  if (method === "GET") {
    const range = /^bytes=(\d+)-$/.exec(request.headers.get("Range") || "");
    const g = await budget(env, { op: "get", rkey });            // reserves one Class B op
    if (g.r === "none") return err(404, "not-found");
    if (g.r === "paused") return paused();
    if (g.r === "busytoday") return busyToday();
    const off = range ? Number(range[1]) : 0;
    if (off >= g.size && g.size > 0) return err(416, "bad-range");
    const obj = off ? await env.SAVES.get(rkey, { range: { offset: off }, onlyIf: { etagMatches: g.rawEtag } })
                    : await env.SAVES.get(rkey, { onlyIf: { etagMatches: g.rawEtag } });
    if (!obj || !obj.body) return err(409, "changed-during-read");
    return new Response(obj.body, {
      status: off ? 206 : 200,
      headers: {
        "content-type": "application/octet-stream",
        ETag: g.etag,
        "X-RH-Sha": g.sha,
        "X-RH-Mtime": g.mtime,
        "X-RH-Size": String(g.size),
        ...(off ? { "Content-Range": `bytes ${off}-${g.size - 1}/${g.size}` } : {}),
      },
    });
  }

  if (method === "DELETE") {     // free R2 op and frees budgeted storage: allowed even when the budget is exhausted
    const d = await budget(env, { op: "del_check", rkey, ifMatch: request.headers.get("If-Match") });
    if (d.r === "none") return json({ ok: true, deleted: false });
    if (d.r === "busy") return err(409, "busy", { retryAfter: 5 });
    if (d.r === "busytoday") return busyToday();
    if (d.r === "conflict") return err(412, "conflict", { current: d.current });
    await env.SAVES.delete(rkey);
    await budget(env, { op: "del_commit", rkey });
    return json({ ok: true, deleted: true });
  }

  // PUT
  const sha = (request.headers.get("X-RH-Sha") || "").toLowerCase();
  if (!HEX64.test(sha)) return err(400, "sha-required");
  const mtime = request.headers.get("X-RH-Mtime") || "0";
  if (!/^\d{1,20}$/.test(mtime)) return err(400, "bad-mtime");
  const ifMatch = request.headers.get("If-Match");
  const ifNone = request.headers.get("If-None-Match");
  if (!ifMatch && ifNone !== "*") return err(428, "precondition-required");
  const len = Number(request.headers.get("Content-Length"));

  // One atomic DO step: preconditions, idempotency, per-account + global storage caps, Class A reservation.
  const b = await budget(env, { op: "put_begin", uid: au.uid, rkey, len, sha, ifMatch, ifNone });
  switch (b.r) {
    case "conflict": return err(412, "conflict", { current: b.current });
    case "busy": return err(409, "busy", { retryAfter: 5 });
    case "unchanged": return json({ ok: true, etag: b.etag, unchanged: true });
    case "toomany": return err(507, "too-many-files", { max: b.max });
    case "quota": return err(507, "quota-exceeded", { used: b.used, quota: b.quota });
    case "full": return full();
    case "paused": return paused();
    case "busytoday": return busyToday();
    case "ok": break;
    default: return paused();
  }

  // The body must be exactly Content-Length bytes and hash to X-RH-Sha (enforced while streaming), so a bad upload
  // fails before anything is committed and the previous version is never touched. The conditional put makes R2
  // itself reject a lost race (replace: etag must match; create: object must not exist).
  const tok = b.tok;
  const abort = (unknown) => budget(env, { op: "put_abort", rkey, tok, unknown }).catch(() => {});
  let put;
  try {
    const body = len === 0 || !request.body ? new Uint8Array(0) : request.body.pipeThrough(new FixedLengthStream(len));
    put = await env.SAVES.put(rkey, body, {
      sha256: sha,
      customMetadata: { sha, mtime },
      onlyIf: b.etag ? { etagMatches: b.etag } : { etagDoesNotMatch: "*" },
    });
  } catch (e) {
    await abort(true);             // may or may not have landed: mark the index dirty so a reconcile re-checks
    return err(400, "bad-body");   // digest mismatch / truncated upload
  }
  if (!put) { await abort(false); return err(412, "conflict", { current: null }); }
  // The object is stored. Commit to the index; one retry, then a retryable 503. A pending row that is never
  // committed is aborted after its TTL and the index marked dirty; a late commit re-applies the bytes.
  const commit = { op: "put_commit", uid: au.uid, rkey, tok, size: put.size, etag: put.etag, hetag: put.httpEtag || put.etag, sha, mtime };
  try { await budget(env, commit); }
  catch (e1) {
    try { await budget(env, commit); }
    catch (e2) { return err(503, "cloud-saves-retry", { retryAfter: 30 }); }
  }
  return json({ ok: true, etag: put.httpEtag || put.etag });
}

// Test-only hooks (need BUDGET_TEST=1 in .dev.vars; never set in production).
async function testHooks(request, env) {
  if (env.BUDGET_TEST !== "1") return null;
  const u = new URL(request.url);
  if (!u.pathname.startsWith("/saves/_test/")) return null;
  const op = u.pathname.slice("/saves/_test/".length);
  if (op.startsWith("v2/")) return json(await budget(env, { ...Object.fromEntries(u.searchParams), op: "test_v2_" + op.slice(3) }));   // v2 hooks (uid, active, total...)
  if (op === "rawput") {   // write straight into R2 behind the index's back (reconcile tests)
    await env.SAVES.put(u.searchParams.get("rkey"), "x".repeat(Number(u.searchParams.get("n") || 10)), { customMetadata: { sha: "0".repeat(64), mtime: "1" } });
    return json({ ok: true });
  }
  const body = { month: { op: "test_month", month: u.searchParams.get("m") }, day: { op: "test_day", day: u.searchParams.get("d") },
    fail: { op: "test_fail", on: u.searchParams.get("on") === "1" }, commitfail: { op: "test_commit_fail", n: u.searchParams.get("n") },
    reconcile: { op: "test_reconcile" }, sum: { op: "test_sum" }, acct: { op: "test_acct" } }[op] || { op: "status" };
  return json(await budget(env, body));
}
