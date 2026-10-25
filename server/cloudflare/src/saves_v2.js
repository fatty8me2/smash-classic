// Cloud saves v2 router (Worker side). Spec: RetroHub/docs/CLOUD_SAVES_V2.md section 3.
// Every route authenticates like v1 (RHSIG, key = sha256hex(secret) from the account's UserHub, per-account rate limit
// class), then talks to the R2Budget Durable Object (r2budget_v2.js) which owns manifest, quota, tickets and leases.
// R2 is only touched for blob PUT/GET and the (free) deletes the DO asks for; the DO is asked BEFORE each R2 call
// and every failure of it fails closed (BudgetDown -> 429 cloud-saves-unavailable, see saves.js).
//
// Signature: unchanged from v1. For JSON POST bodies X-RH-Sha is mandatory and must equal sha256(body), so the body is
// covered by the signature. Content-Length is part of the signed string for PUT only (as in v1), "-" otherwise.

import { authenticate, budget, err, json, HEX64, MAX_OBJECT } from "./saves.js";
import { gate } from "./reqbudget.js";

const DEV_RE = /^[a-z0-9-]{8,40}$/;
const ROUTES = {
  "GET /saves/v2/status": { cls: "meta", op: "v2_status", status: true },
  "GET /saves/v2/manifest": { cls: "meta", op: "v2_manifest" },
  "POST /saves/v2/device": { cls: "meta", op: "v2_device", body: 8192 },
  "POST /saves/v2/plan": { cls: "pc", op: "v2_plan", body: 65536 },
  "POST /saves/v2/commit": { cls: "pc", op: "v2_commit", body: 8192 },
  "GET /saves/v2/blob": { cls: "get", op: "v2_blob_get", blob: true },
  "PUT /saves/v2/blob": { cls: "put", op: "v2_blob_begin", blob: true },
  "POST /saves/v2/restore": { cls: "pc", op: "v2_restore", body: 8192 },
  "POST /saves/v2/game": { cls: "pc", op: "v2_game", body: 8192 },
  "POST /saves/v2/lease": { cls: "meta", op: "v2_lease", body: 8192, action: "take" },
  "POST /saves/v2/lease/beat": { cls: "meta", op: "v2_lease", body: 8192, action: "beat" },
  "POST /saves/v2/lease/release": { cls: "meta", op: "v2_lease", body: 8192, action: "release" },
};

const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
async function sha256hex(bytes) { return hex(await crypto.subtle.digest("SHA-256", bytes)); }

// Turn a DO answer into the HTTP reply, then do the R2 deletes it asked for (free ops) and confirm them.
async function reply(env, res, extra = {}) {
  const dels = Array.isArray(res.dels) ? res.dels : [];
  if (res.r === "err") {
    const { r, status, code, ...rest } = res;
    return err(status, code, rest);
  }
  const { r, dels: _d, ...rest } = res;
  const out = json({ ok: true, ...rest, ...extra });
  if (dels.length) await sweepDeletes(env, dels);
  return out;
}
async function sweepDeletes(env, rkeys) {
  const done = [];
  for (const k of rkeys) {
    try { await env.SAVES.delete(k); done.push(k); } catch { /* the DO re-offers it later */ }
  }
  if (done.length) { try { await budget(env, { op: "v2_del_done", rkeys: done }); } catch { /* idempotent, retried via oldDead */ } }
}

export async function savesV2Fetch(request, env, url) {
  const route = url.pathname.replace(/\/+$/, "");
  const key = `${request.method} ${route}`;
  const spec = ROUTES[key];
  if (!spec) return err(Object.keys(ROUTES).some((k) => k.endsWith(" " + route)) ? 405 : 404, "not-found");
  if (env.SAVES_V2 === "0") return err(503, "cloud-saves-disabled");

  // global request-unit pressure (REQ_BUDGET at 50%+): saves just wait, local play is never affected
  if (!spec.status && !gate(env).relayNew) return err(429, "cloud-saves-busy-today", { retryAfter: 3600 });

  if (spec.public) return publicRoute(request, env, spec);

  if (request.method === "PUT") {
    const len = Number(request.headers.get("Content-Length"));
    if (!request.headers.has("Content-Length") || !Number.isFinite(len) || len < 0) return err(411, "length-required");
    if (len > MAX_OBJECT) return err(413, "object-too-large", { max: MAX_OBJECT });
  }
  const au = await authenticate(request, env, url, request.method !== "GET", spec.cls);
  if (au.res) return au.res;
  const uid = au.uid;
  const devH = request.headers.get("X-RH-Device") || "";
  const dev = DEV_RE.test(devH) ? devH : "";

  if (spec.blob) return blobRoute(request, env, url, spec, uid, dev);

  let body;
  if (spec.body) {
    const shaH = (request.headers.get("X-RH-Sha") || "").toLowerCase();
    if (!HEX64.test(shaH)) return err(400, "bad-sha");
    const cl = request.headers.get("Content-Length");
    if (cl && Number(cl) > spec.body) return err(413, "body-too-large", { max: spec.body });
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length > spec.body) return err(413, "body-too-large", { max: spec.body });
    if ((await sha256hex(bytes)) !== shaH) return err(400, "bad-sha");
    try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { return err(400, "bad-body"); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return err(400, "bad-body");
  }
  const q = { op: spec.op, uid, dev, body, action: spec.action };
  if (spec.op === "v2_commit") { q.ticket = typeof body.ticket === "string" ? body.ticket : ""; }
  if (spec.op === "v2_manifest") { q.since = url.searchParams.get("since"); q.game = url.searchParams.get("game"); }
  return reply(env, await budget(env, q));
}

async function publicRoute(request, env, spec) {
  const cl = request.headers.get("Content-Length");
  if (cl && Number(cl) > spec.body) return err(413, "body-too-large", { max: spec.body });
  const text = await request.text();
  if (text.length > spec.body) return err(413, "body-too-large", { max: spec.body });
  let b;
  try { b = JSON.parse(text); } catch { return err(400, "bad-body"); }
  if (!b || typeof b !== "object") return err(400, "bad-body");
  const ip = (request.headers.get("CF-Connecting-IP") || "local").slice(0, 45);
  return reply(env, await budget(env, { op: spec.op, hash: b.hash, ip }));
}

async function blobRoute(request, env, url, spec, uid, dev) {
  if (request.method === "GET") {
    const g = await budget(env, { op: "v2_blob_get", uid, dev, game: url.searchParams.get("game"), path: url.searchParams.get("path"), ver: url.searchParams.get("ver") });
    if (g.r !== "ok") return reply(env, g);
    const range = /^bytes=(\d+)-$/.exec(request.headers.get("Range") || "");
    const off = range ? Number(range[1]) : 0;
    if (off >= g.stored && g.stored > 0) return err(416, "bad-range");
    const obj = off ? await env.SAVES.get(g.rkey, { range: { offset: off }, onlyIf: { etagMatches: g.rawEtag } })
                    : await env.SAVES.get(g.rkey, { onlyIf: { etagMatches: g.rawEtag } });
    if (!obj || !obj.body) return err(409, "changed-during-read", { retryAfter: 2 });
    let storedSha = g.enc === "none" ? g.sha : "";
    try { if (!storedSha && obj.checksums && obj.checksums.sha256) storedSha = hex(obj.checksums.sha256); } catch { /* optional */ }
    return new Response(obj.body, {
      status: off ? 206 : 200,
      headers: {
        "content-type": "application/octet-stream",
        ...(storedSha ? { "X-RH-Sha": storedSha } : {}),
        "X-RH-Plain-Sha": g.sha, "X-RH-Enc": g.enc, "X-RH-Size": String(g.size), "X-RH-Stored": String(g.stored),
        "X-RH-Ver": String(g.ver), "X-RH-Mtime": String(g.mtime),
        ...(off ? { "Content-Range": `bytes ${off}-${g.stored - 1}/${g.stored}` } : {}),
      },
    });
  }

  // PUT: one blob of a ticket. Body must be exactly Content-Length bytes and hash to X-RH-Sha (enforced by R2 while it streams).
  const len = Number(request.headers.get("Content-Length"));
  const plain = (url.searchParams.get("sha") || "").toLowerCase();
  const ticket = url.searchParams.get("ticket") || "";
  const storedSha = (request.headers.get("X-RH-Sha") || "").toLowerCase();
  if (!HEX64.test(plain) || !ticket) return err(400, "bad-sha");
  if (!HEX64.test(storedSha)) return err(400, "sha-required");
  const b = await budget(env, { op: "v2_blob_begin", uid, dev, sha: plain, ticket, len });
  if (b.r === "unchanged") return json({ ok: true, unchanged: true });
  if (b.r !== "ok") return reply(env, b);
  const { rkey, tok, mtime } = b;
  const abort = (unknown) => budget(env, { op: "put_abort", rkey, tok, unknown }).catch(() => {});
  let put;
  try {
    const stream = len === 0 || !request.body ? new Uint8Array(0) : request.body.pipeThrough(new FixedLengthStream(len));
    put = await env.SAVES.put(rkey, stream, { sha256: storedSha, customMetadata: { sha: plain, mtime }, onlyIf: { etagDoesNotMatch: "*" } });
  } catch (e) { await abort(true); return err(400, "bad-body"); }
  if (!put) { await abort(false); return json({ ok: true, unchanged: true }); }
  const commit = { op: "put_commit", uid, rkey, tok, size: put.size, etag: put.etag, hetag: put.httpEtag || put.etag, sha: storedSha, mtime };
  try { await budget(env, commit); }
  catch { try { await budget(env, commit); } catch { return err(503, "cloud-saves-retry", { retryAfter: 30 }); } }
  return json({ ok: true });
}
