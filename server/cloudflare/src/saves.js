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
//   sig = HMAC-SHA256(key = sha256hex(account secret), "METHOD\n/saves/...?query\nts\nX-RH-Sha or -")
// The Worker never sees the secret itself; the account's UserHub Durable Object holds sha256hex(secret) (the same
// value the friends hello checks) and hands it to this module over the internal route "saves_auth", which also
// applies the per-account rate limit. The R2 key is always saves/<uid>/<rel> with uid taken from the verified
// signature, so one account can never address another's objects.
//
// If the SAVES R2 binding is absent every /saves route answers 503 {error:"cloud-saves-disabled"}.

const UID_RE = /^[a-z2-7]{26}$/;
export const MAX_OBJECT = 16 * 1024 * 1024;
export const QUOTA = 500 * 1024 * 1024;
export const MAX_FILES = 3000;
const MAX_KEY = 240;
const MAX_SEGMENTS = 8;
const SKEW_MS = 5 * 60 * 1000;
const HEX64 = /^[0-9a-f]{64}$/;

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...extra } });
}
const err = (status, code, extra = {}) => json({ ok: false, error: code, ...extra }, status);

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

// Relative path inside the account's vault, "/" separated, validated hard.
export function cleanKey(raw) {
  if (typeof raw !== "string" || !raw || raw.length > MAX_KEY) return null;
  const segs = raw.split("/");
  if (segs.length > MAX_SEGMENTS) return null;
  for (const s of segs) {
    if (!s || s === "." || s === "..") return null;
    if (s.length > 120 || /[\x00-\x1f\x7f\\:*?"<>|]/.test(s)) return null;
    if (/[. ]$/.test(s)) return null;
  }
  if (segs[0].toLowerCase() === "_identity") return null; // the account secret never goes to the cloud
  if (/\.hubtmp$/i.test(raw)) return null;
  return segs.join("/");
}

async function authenticate(request, env, url, write) {
  const h = request.headers.get("Authorization") || "";
  const m = /^RHSIG uid=([a-z2-7]{26}),ts=(\d{10,16}),sig=([0-9a-f]{64})$/.exec(h);
  if (!m) return { res: err(401, "unauthorized") };
  const [, uid, ts, sig] = m;
  if (Math.abs(Date.now() - Number(ts)) > SKEW_MS) return { res: err(401, "stale-timestamp") };
  const hub = env.USER_HUBS.get(env.USER_HUBS.idFromName(uid));
  const r = await hub.fetch("https://userhub/i/saves_auth", {
    method: "POST",
    headers: { "x-rh-internal": "1", "content-type": "application/json" },
    body: JSON.stringify({ uid, write }),
  });
  const a = await r.json();
  if (a.r === "limited") return { res: err(429, "rate-limited", { retryAfter: 60 }) };
  if (a.r !== "ok" || typeof a.key !== "string") return { res: err(401, "unauthorized") };
  const body = request.headers.get("X-RH-Sha") || "-";
  const want = await hmacHex(a.key, `${request.method}\n${url.pathname}${url.search}\n${ts}\n${body}`);
  if (!safeEq(want, sig)) return { res: err(401, "unauthorized") };
  return { uid };
}

function metaOf(o) {
  const c = o.customMetadata || {};
  return { key: null, size: o.size, etag: o.httpEtag || o.etag, sha: c.sha || "", mtime: c.mtime || "0" };
}

async function listAll(env, prefix) {
  const files = [];
  let cursor;
  let used = 0;
  do {
    const page = await env.SAVES.list({ prefix, cursor, limit: 1000, include: ["customMetadata"] });
    for (const o of page.objects) {
      const m = metaOf(o);
      m.key = o.key.slice(prefix.length);
      files.push(m);
      used += o.size;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor && files.length <= MAX_FILES + 1000);
  return { files, used };
}

export async function savesFetch(request, env) {
  if (!env.SAVES) return err(503, "cloud-saves-disabled");
  const url = new URL(request.url);
  const route = url.pathname;
  const method = request.method;
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
    const { files, used } = await listAll(env, prefix);
    return json({ ok: true, files, used, quota: QUOTA, maxObject: MAX_OBJECT });
  }

  const key = cleanKey(url.searchParams.get("key"));
  if (!key) return err(400, "bad-key");
  const rkey = prefix + key;

  if (method === "GET") {
    const range = /^bytes=(\d+)-$/.exec(request.headers.get("Range") || "");
    const head = await env.SAVES.head(rkey);
    if (!head) return err(404, "not-found");
    const off = range ? Number(range[1]) : 0;
    if (off >= head.size && head.size > 0) return err(416, "bad-range");
    const obj = off ? await env.SAVES.get(rkey, { range: { offset: off }, onlyIf: { etagMatches: head.etag } })
                    : await env.SAVES.get(rkey, { onlyIf: { etagMatches: head.etag } });
    if (!obj || !obj.body) return err(409, "changed-during-read");
    const m = metaOf(head);
    return new Response(obj.body, {
      status: off ? 206 : 200,
      headers: {
        "content-type": "application/octet-stream",
        ETag: m.etag,
        "X-RH-Sha": m.sha,
        "X-RH-Mtime": m.mtime,
        "X-RH-Size": String(head.size),
        ...(off ? { "Content-Range": `bytes ${off}-${head.size - 1}/${head.size}` } : {}),
      },
    });
  }

  if (method === "DELETE") {
    const head = await env.SAVES.head(rkey);
    if (!head) return json({ ok: true, deleted: false });
    const im = request.headers.get("If-Match");
    if (im && im !== head.httpEtag && im !== head.etag) return err(412, "conflict", { current: metaOf(head) });
    await env.SAVES.delete(rkey);
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

  const head = await env.SAVES.head(rkey);
  if (ifNone === "*" && head) return err(412, "conflict", { current: metaOf(head) });
  if (ifMatch && (!head || (ifMatch !== head.httpEtag && ifMatch !== head.etag))) {
    return err(412, "conflict", { current: head ? metaOf(head) : null });
  }
  const len = Number(request.headers.get("Content-Length"));
  // Idempotent retry: identical content already stored -> success without rewriting.
  if (head && head.customMetadata && head.customMetadata.sha === sha && head.size === len) {
    return json({ ok: true, etag: head.httpEtag || head.etag, unchanged: true });
  }
  const { files, used } = await listAll(env, prefix);
  const old = head ? head.size : 0;
  if (!head && files.length >= MAX_FILES) return err(507, "too-many-files", { max: MAX_FILES });
  if (used - old + len > QUOTA) return err(507, "quota-exceeded", { used, quota: QUOTA });

  let put;
  try {
    put = await env.SAVES.put(rkey, request.body, {
      sha256: sha,
      customMetadata: { sha, mtime },
      onlyIf: head ? { etagMatches: head.etag } : undefined,
    });
  } catch (e) {
    return err(400, "bad-body");   // digest mismatch / truncated upload
  }
  if (!put) return err(412, "conflict", { current: metaOf((await env.SAVES.head(rkey)) || { size: 0 }) });
  if (put.size !== len) { await env.SAVES.delete(rkey); return err(400, "bad-length"); }
  return json({ ok: true, etag: put.httpEtag || put.etag });
}
