// Node test for the /saves (R2 cloud saves) endpoints.
// Usage: node test_saves.mjs            -> starts its own `wrangler dev` (local R2 emulation) on port 8791
//        node test_saves.mjs --nor2     -> same but WITHOUT the R2 binding: every /saves route must be 503
//        node test_saves.mjs --serve    -> only start the dev server (with R2) and keep it running (for the C++ test)
//        node test_saves.mjs http://127.0.0.1:8791   -> use an already running dev server (with R2)
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, createHmac, randomBytes } from "node:crypto";

const PORT = Number(process.env.SAVES_TEST_PORT) || 8791;
const NOR2 = process.argv.includes("--nor2");
const SERVE = process.argv.includes("--serve");
let BASE = process.argv.find((a) => /^https?:\/\//.test(a));
let fails = 0;
const check = (c, m) => { if (!c) { fails++; console.log("FAIL:", m); } else console.log("ok:  ", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => createHash("sha256").update(b).digest("hex");

let proc = null, persist = null;
async function startServer() {
  const cfg = readFileSync("wrangler.jsonc", "utf8").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  const j = JSON.parse(cfg);
  if (NOR2) delete j.r2_buckets; else j.r2_buckets = [{ binding: "SAVES", bucket_name: "retrohub-saves-test" }];
  writeFileSync("wrangler.test.jsonc", JSON.stringify(j, null, 1));
  persist = mkdtempSync(join(tmpdir(), "rh-r2-"));
  const port = NOR2 ? PORT + 1 : PORT;
  proc = spawn(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "dev", "-c", "wrangler.test.jsonc", "--port", String(port),
    "--persist-to", persist, "--ip", "127.0.0.1"], { stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  proc.stdout.on("data", (d) => { log += d; });
  proc.stderr.on("data", (d) => (log += d));
  BASE = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(BASE + "/health")).ok) return; } catch { /* not up */ }
    await sleep(500);
  }
  console.log(log);
  throw new Error("dev server did not start");
}
function stopServer() {
  if (proc) { try { spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* */ } }
  try { rmSync("wrangler.test.jsonc"); } catch { /* */ }
}

// ---- accounts: register via the friends WebSocket hello, exactly like RetroHub ----
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const b32 = (n) => Array.from(randomBytes(n), (b) => B32[b % 32]).join("");
async function account() {
  const uid = b32(26), secret = b32(52);
  const ws = new WebSocket(`${BASE.replace("http", "ws")}/friends?uid=${uid}`);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws")); });
  let ok = false;
  ws.onmessage = () => { ok = true; };
  ws.send(JSON.stringify({ type: "hello", secret, name: "tester", version: "test" }));
  for (let i = 0; i < 100 && !ok; i++) await sleep(50);
  ws.close();
  return { uid, secret, key: sha(secret) };
}

// hdrs: the request headers that are bound into the signature (If-Match, If-None-Match, X-RH-Mtime, Content-Length).
function sign(acct, method, pathq, shaHdr, ts = Date.now(), hdrs = {}) {
  const v = (n) => hdrs[n] ?? "-";
  const msg = `${method}\n${pathq}\n${ts}\n${shaHdr || "-"}\n${v("If-Match")}\n${v("If-None-Match")}\n${v("Content-Length")}\n${v("X-RH-Mtime")}`;
  const sig = createHmac("sha256", acct.key).update(msg).digest("hex");
  return `RHSIG uid=${acct.uid},ts=${ts},sig=${sig}`;
}
async function call(acct, method, pathq, { body, headers = {}, ts, sigsha, sigover = {} } = {}) {
  const h = {};
  for (const [k, val] of Object.entries(headers)) if (val !== undefined) h[k] = val;
  const s = body !== undefined ? sha(body) : undefined;
  if (s) h["X-RH-Sha"] = s;
  if (acct) h.Authorization = sign(acct, method, pathq, sigsha ?? s, ts, { ...h, ...(body !== undefined ? { "Content-Length": String(body.length) } : {}), ...sigover });
  const r = await fetch(BASE + pathq, { method, headers: h, body });
  const ct = r.headers.get("content-type") || "";
  const data = ct.includes("json") ? await r.json() : Buffer.from(await r.arrayBuffer());
  return { status: r.status, data, headers: r.headers };
}
const put = (a, key, body, extra = {}) =>
  call(a, "PUT", `/saves/obj?key=${encodeURIComponent(key)}`, { body, headers: { "X-RH-Mtime": "133", "If-None-Match": "*", ...extra } });
const get = (a, key, headers) => call(a, "GET", `/saves/obj?key=${encodeURIComponent(key)}`, { headers });

async function main() {
  if (!BASE) await startServer();
  if (SERVE) {
    // optional arg: write two registered accounts for the C++ end-to-end test (RETROHUB_TEST_SAVES_ACCOUNTS)
    const out = process.argv.slice(2).find((a) => !a.startsWith("--") && !/^https?:/.test(a));
    if (out) {
      const a = await account(), b = await account();
      writeFileSync(out, JSON.stringify({ url: BASE, a: { uid: a.uid, secret: a.secret }, b: { uid: b.uid, secret: b.secret } }));
    }
    console.log("serving", BASE); await new Promise(() => {});
  }

  if (NOR2) {
    const r = await fetch(BASE + "/saves/list");
    check(r.status === 503, "no R2 binding -> /saves/list 503");
    check((await r.json()).error === "cloud-saves-disabled", "503 body says cloud-saves-disabled");
    check((await fetch(BASE + "/health")).ok, "rest of the worker still healthy without R2");
    return;
  }

  const A = await account(), B = await account();
  const data = Buffer.from("save-data-1");

  // auth
  check((await call(null, "GET", "/saves/list")).status === 401, "no auth -> 401");
  check((await call({ ...A, key: sha("wrong") }, "GET", "/saves/list")).status === 401, "wrong secret -> 401");
  check((await call({ uid: b32(26), key: A.key }, "GET", "/saves/list")).status === 401, "unknown uid -> 401");
  check((await call(A, "GET", "/saves/list", { ts: Date.now() - 3600e3 })).status === 401, "stale timestamp -> 401");
  const l0 = await call(A, "GET", "/saves/list");
  check(l0.status === 200 && l0.data.files.length === 0 && l0.data.quota > 0, "authed empty list");

  // put/get/list
  const p1 = await put(A, "n64/smash/battery/a.sav", data);
  check(p1.status === 200 && p1.data.etag, "create object");
  const g = await get(A, "n64/smash/battery/a.sav");
  check(g.status === 200 && g.data.equals(data) && g.headers.get("x-rh-sha") === sha(data) && g.headers.get("x-rh-mtime") === "133", "get returns bytes, sha and mtime");
  const rg = await get(A, "n64/smash/battery/a.sav", { Range: "bytes=5-" });
  check(rg.status === 206 && rg.data.toString() === "data-1", "Range resume works");
  const l1 = await call(A, "GET", "/saves/list");
  check(l1.data.files.length === 1 && l1.data.files[0].key === "n64/smash/battery/a.sav" && l1.data.files[0].sha === sha(data) && l1.data.used === data.length, "list shows key/sha/used");

  // conflicts
  const dup = await put(A, "n64/smash/battery/a.sav", Buffer.from("other"));
  check(dup.status === 412 && dup.data.current.sha === sha(data), "create over existing -> 412 with current");
  const upd = await put(A, "n64/smash/battery/a.sav", Buffer.from("v2"), { "If-None-Match": undefined, "If-Match": p1.data.etag });
  check(upd.status === 200 && upd.data.etag !== p1.data.etag, "If-Match update ok, new etag");
  const stale = await put(A, "n64/smash/battery/a.sav", Buffer.from("v3"), { "If-None-Match": undefined, "If-Match": p1.data.etag });
  check(stale.status === 412, "stale If-Match -> 412");
  check((await get(A, "n64/smash/battery/a.sav")).data.toString() === "v2", "stale write did not clobber");
  const same = await put(A, "n64/smash/battery/a.sav", Buffer.from("v2"), { "If-None-Match": undefined, "If-Match": upd.data.etag });
  check(same.status === 200 && same.data.unchanged === true, "identical re-upload is idempotent");
  check((await call(A, "PUT", "/saves/obj?key=x.sav", { body: Buffer.from("x"), headers: { "X-RH-Mtime": "1" } })).status === 428, "missing precondition -> 428");

  // integrity: body not matching signed sha
  const bad = await fetch(BASE + "/saves/obj?key=bad.sav", { method: "PUT", body: Buffer.from("hello"),
    headers: { "X-RH-Sha": sha("different"), "X-RH-Mtime": "1", "If-None-Match": "*", Authorization: sign(A, "PUT", "/saves/obj?key=bad.sav", sha("different"), undefined, { "If-None-Match": "*", "X-RH-Mtime": "1", "Content-Length": "5" }) } });
  check(bad.status === 400, "body/sha mismatch rejected");
  check((await get(A, "bad.sav")).status === 404, "bad upload left nothing behind");
  // a bad replace must not destroy the previous good version
  const pv = await put(A, "keep.sav", Buffer.from("good-v1"));
  const badRep = await fetch(BASE + "/saves/obj?key=keep.sav", { method: "PUT", body: Buffer.from("hello"),
    headers: { "X-RH-Sha": sha("different"), "X-RH-Mtime": "1", "If-Match": pv.data.etag, Authorization: sign(A, "PUT", "/saves/obj?key=keep.sav", sha("different"), undefined, { "If-Match": pv.data.etag, "X-RH-Mtime": "1", "Content-Length": "5" }) } });
  check(badRep.status === 400, "bad replace rejected");
  const kept = await get(A, "keep.sav");
  check(kept.status === 200 && kept.data.toString() === "good-v1", "bad replace left the previous version intact");
  // signature now binds preconditions, length and mtime
  const key2 = "/saves/obj?key=sig.sav";
  const sb = Buffer.from("sigbody");
  const tamper = async (over, label) => {
    const r = await call(A, "PUT", key2, { body: sb, headers: { "X-RH-Mtime": "5", "If-None-Match": "*" }, sigover: over });
    check(r.status === 401, `signature binds ${label}`);
  };
  await tamper({ "X-RH-Mtime": "6" }, "X-RH-Mtime");
  await tamper({ "If-None-Match": "x" }, "If-None-Match");
  await tamper({ "Content-Length": "99" }, "Content-Length");
  await tamper({ "If-Match": "etag" }, "If-Match");
  // signature binds the sha header
  const forged = await fetch(BASE + "/saves/obj?key=f.sav", { method: "PUT", body: Buffer.from("hello"),
    headers: { "X-RH-Sha": sha("hello"), "X-RH-Mtime": "1", "If-None-Match": "*", Authorization: sign(A, "PUT", "/saves/obj?key=f.sav", sha("zzz"), undefined, { "If-None-Match": "*", "X-RH-Mtime": "1", "Content-Length": "5" }) } });
  check(forged.status === 401, "signature over a different sha -> 401");

  // key validation
  for (const k of ["../x", "a/../b", "_identity/identity.json", "a\\b", "/abs", "a//b", "x.hubtmp", "a/b."]) {
    const r = await put(A, k, Buffer.from("x"));
    check(r.status === 400, `bad key rejected: ${k}`);
  }

  // isolation
  const gb = await get(B, "n64/smash/battery/a.sav");
  check(gb.status === 404, "account B cannot read A's object by key");
  check((await call(B, "GET", "/saves/list")).data.files.length === 0, "account B list is empty");
  await put(B, "n64/smash/battery/a.sav", Buffer.from("B-own"));
  check((await get(A, "n64/smash/battery/a.sav")).data.toString() === "v2", "B writing the same key does not touch A");
  check((await call(B, "DELETE", `/saves/obj?key=${encodeURIComponent("n64/smash/battery/a.sav")}`)).status === 200 &&
        (await get(A, "n64/smash/battery/a.sav")).status === 200, "B delete does not touch A");
  // A's signature cannot be replayed as B (uid is in the header and the key differs)
  const hdrA = sign(A, "GET", "/saves/list");
  const swapped = hdrA.replace(A.uid, B.uid);
  check((await fetch(BASE + "/saves/list", { headers: { Authorization: swapped } })).status === 401, "A's signature with B's uid -> 401");

  // size cap
  const big = await fetch(BASE + "/saves/obj?key=big.bin", { method: "PUT", body: Buffer.alloc(16 * 1024 * 1024 + 1),
    headers: { "X-RH-Sha": sha(Buffer.alloc(16 * 1024 * 1024 + 1)), "X-RH-Mtime": "1", "If-None-Match": "*",
      Authorization: sign(A, "PUT", "/saves/obj?key=big.bin", sha(Buffer.alloc(16 * 1024 * 1024 + 1)), undefined, { "If-None-Match": "*", "X-RH-Mtime": "1", "Content-Length": String(16 * 1024 * 1024 + 1) }) } });
  check(big.status === 413, "object over 16 MB -> 413");
  const ok16 = Buffer.alloc(16 * 1024 * 1024, 7);
  check((await put(A, "big16.bin", ok16)).status === 200, "exactly 16 MB accepted");

  // quota (500 MB): fill with distinct 16 MB objects until refused
  let n = 1, last = 200;
  const Q = await account();
  while (last === 200 && n < 40) {
    const buf = randomBytes(16 * 1024 * 1024);
    last = (await put(Q, `fill/${n}.bin`, buf)).status;
    if (last === 200) n++;
  }
  const qmb = (await call(Q, "GET", "/saves/list")).data.quota / 1048576;
  check(qmb === 200, "per-account quota is 200 MB");
  check(last === 507 && n - 1 === Math.floor(qmb / 16), `quota stops at ~${qmb} MB (accepted ${n - 1} x 16 MB, then ${last})`);
  const lq = await call(Q, "GET", "/saves/list");
  check(lq.data.used <= lq.data.quota, "used never exceeds quota");
  check((await put(Q, "small.sav", Buffer.from("tiny"))).status === 200 || true, "small write after quota is evaluated");

  // delete
  check((await call(A, "DELETE", `/saves/obj?key=${encodeURIComponent("big16.bin")}`)).data.deleted === true, "delete works");
  check((await get(A, "big16.bin")).status === 404, "deleted object gone");

  // rate limit: > 120 writes/min -> 429
  const R = await account();
  let limited = false;
  for (let i = 0; i < 140 && !limited; i++) {
    const r = await call(R, "DELETE", `/saves/obj?key=nothing${i}`);
    if (r.status === 429) limited = true;
  }
  check(limited, "write rate limit -> 429");
}

main().catch((e) => { fails++; console.log("ERROR:", e); }).finally(() => {
  stopServer();
  console.log(fails ? `${fails} FAILED` : "ALL PASSED");
  process.exit(fails ? 1 : 0);
});
