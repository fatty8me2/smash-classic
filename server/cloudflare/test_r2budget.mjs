// Tests for the global R2 budget guard (src/r2budget.js) against a LOCAL `wrangler dev` (simulated R2, never the
// real Cloudflare account). Tiny caps are injected with --var.  Usage: node test_r2budget.mjs   (port 8793)
import { request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { client as v2client } from "./test_v2_lib.mjs";

const PORT = Number(process.env.BUDGET_TEST_PORT) || 8793;
const BASE = `http://127.0.0.1:${PORT}`;
let fails = 0;
const check = (c, m) => { if (!c) { fails++; console.log("FAIL:", m); } else console.log("ok:  ", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => createHash("sha256").update(b).digest("hex");
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const b32 = (n) => Array.from(randomBytes(n), (b) => B32[b % 32]).join("");

let proc;
async function start(vars) {
  const cfg = readFileSync("wrangler.jsonc", "utf8").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  const j = JSON.parse(cfg);
  j.r2_buckets = [{ binding: "SAVES", bucket_name: "retrohub-saves-test" }];
  writeFileSync("wrangler.budget.jsonc", JSON.stringify(j, null, 1));
  const persist = mkdtempSync(join(tmpdir(), "rh-r2b-"));
  const args = ["node_modules/wrangler/bin/wrangler.js", "dev", "-c", "wrangler.budget.jsonc", "--port", String(PORT), "--persist-to", persist, "--ip", "127.0.0.1"];
  for (const [k, v] of Object.entries(vars)) args.push("--var", `${k}:${v}`);
  proc = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  proc.stdout.on("data", (d) => (log += d)); proc.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 120; i++) { try { if ((await fetch(BASE + "/health")).ok) return; } catch { /* */ } await sleep(500); }
  console.log(log); throw new Error("dev server did not start");
}
function stop() {
  if (proc) { try { spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* */ } }
  try { rmSync("wrangler.budget.jsonc"); } catch { /* */ }
}

async function account() {
  const uid = b32(26), secret = b32(52);
  const ws = new WebSocket(`${BASE.replace("http", "ws")}/friends?uid=${uid}`);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws")); });
  let ok = false; ws.onmessage = () => { ok = true; };
  ws.send(JSON.stringify({ type: "hello", secret, name: "t", version: "test" }));
  for (let i = 0; i < 100 && !ok; i++) await sleep(50);
  ws.close();
  return { uid, key: sha(secret) };
}
function sign(a, method, pathq, shaHdr, hdrs) {
  const ts = Date.now(), v = (n) => hdrs[n] ?? "-";
  const msg = `${method}\n${pathq}\n${ts}\n${shaHdr || "-"}\n${v("If-Match")}\n${v("If-None-Match")}\n${v("Content-Length")}\n${v("X-RH-Mtime")}`;
  return `RHSIG uid=${a.uid},ts=${ts},sig=${createHmac("sha256", a.key).update(msg).digest("hex")}`;
}
async function call(a, method, pathq, body, extra = {}) {
  const h = { ...extra };
  if (body !== undefined) h["X-RH-Sha"] = sha(body);
  h.Authorization = sign(a, method, pathq, h["X-RH-Sha"], { ...h, ...(body !== undefined ? { "Content-Length": String(body.length) } : {}) });
  const r = await fetch(BASE + pathq, { method, headers: h, body });
  const ct = r.headers.get("content-type") || "";
  return { status: r.status, data: ct.includes("json") ? await r.json() : Buffer.from(await r.arrayBuffer()) };
}
const P = (k) => `/saves/obj?key=${encodeURIComponent(k)}`;
const put = (a, k, body) => call(a, "PUT", P(k), body, { "X-RH-Mtime": "1", "If-None-Match": "*" });
const get = (a, k) => call(a, "GET", P(k));
const del = (a, k) => call(a, "DELETE", P(k));
const status = async () => (await (await fetch(BASE + "/saves/_test/status")).json());
const test = (path) => fetch(BASE + path).then((r) => r.json());

const PH1 = { BUDGET_TEST: "1", BUDGET_STORAGE_MAX: "1000", BUDGET_A_MAX: "6", BUDGET_B_MAX: "4", SAVES_QUOTA: "600", SAVES_MAX_FILES: "50" };
const PH3 = { BUDGET_TEST: "1", SAVES_QUOTA: "100000", DAILY_READS_MAX: "40", EST_MS: "1000", DAILY_MS_MAX: "1000000" };
const PH2 = { BUDGET_TEST: "1", BUDGET_STORAGE_MAX: "100000", SAVES_QUOTA: "100000", PENDING_TTL_MS: "1500", DAILY_ROWS_MAX: "300" };

// PUT whose body arrives in two parts, `gap` ms apart (a slow upload).
function slowPut(a, k, body, gap, ifMatch) {
  const path = P(k), s = sha(body);
  const hdrs = { "X-RH-Sha": s, "X-RH-Mtime": "1", ...(ifMatch ? { "If-Match": ifMatch } : { "If-None-Match": "*" }), "Content-Length": String(body.length) };
  hdrs.Authorization = sign(a, "PUT", path, s, hdrs);
  return new Promise((res, rej) => {
    const rq = httpRequest({ host: "127.0.0.1", port: PORT, path, method: "PUT", headers: hdrs }, (r) => {
      let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => res({ status: r.statusCode, data: JSON.parse(d || "{}") }));
    });
    rq.on("error", rej);
    rq.write(body.subarray(0, 1));
    setTimeout(() => rq.end(body.subarray(1)), gap);
  });
}

async function phase2() {
  const A = await account(), B = await account();
  const sum = async () => (await test("/saves/_test/sum")).sum;
  const consistent = async (m) => { const st = await status(); check(st.total === (await sum()), `${m}: total ${st.total} == index sum ${await sum()}`); };

  // slow upload outliving the 1.5 s pending TTL: another put_begin expires it, the late commit must re-apply bytes
  const slow = slowPut(A, "slow.sav", Buffer.alloc(400, 5), 2500);
  await sleep(2000);
  check((await put(B, "other.sav", Buffer.alloc(10, 1))).status === 200, "other put during slow upload ok (expires the stale pending)");
  check((await status()).total === 10, "expired pending released its bytes");
  const sr = await slow;
  check(sr.status === 200, `slow upload still succeeds (${sr.status})`);
  await consistent("after late commit");
  check((await get(A, "slow.sav")).status === 200, "late-committed object is readable");

  // delete during an in-flight upload is refused (busy), upload stays tracked
  const rp = await put(A, "slow2.sav", Buffer.alloc(100, 6));
  const slow2 = slowPut(A, "slow2.sav", Buffer.alloc(300, 6), 800, rp.data.etag);
  await sleep(300);
  const d = await del(A, "slow2.sav");
  check(d.status === 409 && d.data.error === "busy", `delete during upload -> 409 busy (${d.status})`);
  check((await slow2).status === 200, "upload finishes");
  await consistent("after delete-during-upload");
  check((await del(A, "slow2.sav")).data.deleted === true, "delete works after upload");
  await consistent("after delete");

  // put_commit failure: Worker retries once (ok), then twice failing -> 503 retryable; index heals via reconcile
  await test("/saves/_test/commitfail?n=1");
  check((await put(A, "cf1.sav", Buffer.alloc(20, 7))).status === 200, "one commit failure is retried");
  await consistent("after 1 commit failure");
  await test("/saves/_test/commitfail?n=2");
  const cf = await put(A, "cf2.sav", Buffer.alloc(30, 8));
  check(cf.status === 503 && cf.data.error === "cloud-saves-retry", `two commit failures -> 503 retryable (${cf.status})`);
  await sleep(1800);                                           // pending expires on the next begin; dirty
  check((await put(B, "after.sav", Buffer.alloc(5, 2))).status === 200, "service continues");
  check((await status()).dirty === 1, "expired upload marks the index dirty");
  await test("/saves/_test/reconcile");
  check((await status()).dirty === 1, "reconcile defers while an expired upload may still be landing");
  await sleep(1700);
  await test("/saves/_test/reconcile");
  await consistent("after reconcile");
  check((await get(A, "cf2.sav")).status === 200, "reconcile recovered the object that landed without a commit");
  check((await status()).dirty === 0, "reconcile clears dirty");

  // reconcile adopts objects written behind the index's back, drops index rows for vanished ones
  await fetch(BASE + `/saves/_test/rawput?rkey=${encodeURIComponent(`saves/${A.uid}/raw.sav`)}&n=77`);
  await test("/saves/_test/reconcile");
  const l = await call(A, "GET", "/saves/list");
  check(l.data.files.some((f) => f.key === "raw.sav" && f.size === 77), "reconcile adopted the raw object");
  await consistent("after raw adopt");

  // daily row guard
  let code = null, n = 0;
  for (let i = 0; i < 200 && !code; i++) { const r = await put(B, `d${i}`, Buffer.from("z" + i)); n++; if (r.status !== 200) code = r; }
  check(code && code.status === 429 && code.data.error === "cloud-saves-busy-today", `daily rows guard -> 429 cloud-saves-busy-today after ${n} puts`);
  check((await get(B, "d0")).status === 429, "gets pause too");
  check((await del(B, "d0")).status === 200, "delete still allowed (frees storage)");
  await test("/saves/_test/day?d=2099-12-31");
  check((await put(B, "newday.sav", Buffer.from("q"))).status === 200, "new UTC day resets the guard");
}

async function phase3() {
  const A = await account(), B = await account();
  const s0 = await status();
  await put(A, "w1", Buffer.alloc(50, 1));
  const s1 = await status();
  check(s1.rows - s0.rows >= 3, `real rowsWritten counted for a put (${s1.rows - s0.rows} rows, want >= 3)`);
  const r0 = (await status()).reads;
  await get(A, "w1");
  check((await status()).reads > r0, "rowsRead counted");
  await put(A, "w2", Buffer.alloc(60, 2)); await put(B, "b1", Buffer.alloc(70, 3));
  await del(A, "w1");
  const ac = await test("/saves/_test/acct");
  check(JSON.stringify(ac.acct) === JSON.stringify(ac.real), `per-account table matches the index (${JSON.stringify(ac.acct)})`);
  const st = await status();
  check(st.ms >= 1000 * 6, `wall-time meter counts requests (${st.ms} ms)`);
  let code = null;
  for (let i = 0; i < 80 && !code; i++) { const r = await put(B, `r${i}`, Buffer.from("k" + i)); if (r.status !== 200) code = r; }
  check(code && code.status === 429 && code.data.error === "cloud-saves-busy-today", "rows-read daily cap -> busy-today");
  check((await status()).reads < 40 * 2, "reads stay near the cap");
  await test("/saves/_test/day?d=2099-12-30");
  check((await put(B, "ok", Buffer.from("q"))).status === 200, "reads reset on a new day");
}

// v2 (versioned blobs) share the same guards: Class A/B per blob, storage cap, per-account table, fail closed.
const PH4 = { BUDGET_TEST: "1", BUDGET_STORAGE_MAX: "3000", BUDGET_A_MAX: "5", BUDGET_B_MAX: "3" };
async function phase4() {
  const api = v2client(BASE);
  const A = await account();
  const blob = (n, b) => Buffer.alloc(n, b);
  let r = await api.push(A, "n64/g", [{ path: "battery/a.sav", data: blob(1000, 1) }, { path: "battery/b.sav", data: blob(1000, 2) }]);
  check(r.commit.data.results.every((x) => x.cloud === "synced"), "v2: two blobs committed");
  let st = await status();
  check(st.a === 2 && st.total === 2000, `v2: one Class A op per blob (a=${st.a}), bytes tracked (${st.total})`);
  const a0 = st.a;
  r = await api.push(A, "n64/g", [{ path: "battery/c.sav", data: blob(1000, 1) }]);
  check(r.ups.length === 0 && (await status()).a === a0 && (await status()).total === 2000, "v2: dedup costs no Class A and no bytes");
  const ac = await test("/saves/_test/acct");
  check(JSON.stringify(ac.acct.map((x) => [x.uid, x.used, x.n])) === JSON.stringify(ac.real.map((x) => [x.uid, x.used, x.n])), "v2: per-account table matches the index (blobs included)");
  const big = await api.plan(A, "n64/g", [{ path: "battery/big.sav", sha: sha(blob(1500, 9)), size: 1500, stored: 1500, enc: "none", mtime: 1, base: 0 }]);
  check(big.status === 507 && big.data.error === "cloud-saves-full", "v2: global storage cap -> 507 cloud-saves-full");
  const gs = [];
  for (let i = 0; i < 5; i++) gs.push((await api.blobGet(A, "n64/g", "battery/a.sav")).status);
  check(gs.slice(0, 3).every((x) => x === 200) && gs[3] === 429 && gs[4] === 429, `v2: Class B cap (3) -> 429 after 3 blob GETs (${gs})`);
  check((await api.manifest(A)).status === 200, "v2: manifest costs no R2 op and still answers");
  await test("/saves/_test/month?m=2099-03");
  check((await api.blobGet(A, "n64/g", "battery/a.sav")).status === 200, "v2: new month resets the op counters");
  for (let i = 0; i < 5; i++) await api.push(A, "n64/g", [{ path: `battery/s${i}.sav`, data: blob(10, 20 + i) }]);
  const pa = await api.plan(A, "n64/g", [{ path: "battery/z.sav", sha: sha(blob(10, 99)), size: 10, stored: 10, enc: "none", mtime: 1, base: 0 }]);
  check(pa.status === 429 && pa.data.error === "cloud-saves-paused", "v2: Class A cap -> plan answers 429 cloud-saves-paused");
  await test("/saves/_test/fail?on=1");
  const fr = [await api.manifest(A), await api.blobGet(A, "n64/g", "battery/a.sav"), await api.status(A)];
  check(fr.every((x) => x.status === 429 && x.data.error === "cloud-saves-unavailable"), `v2: budget DO failure refuses everything (${fr.map((x) => x.status)})`);
  await test("/saves/_test/fail?on=0");
  check((await api.manifest(A)).status === 200, "v2: recovers once the DO is healthy");
}

async function main() {
  await start(PH1);
  const A = await account(), B = await account(), C = await account();

  // --- storage: global cap 1000 bytes, per-account 600 ---
  check((await put(A, "a1", Buffer.alloc(500, 1))).status === 200, "put 500 B ok");               // A: 1 Class A
  const over = await put(A, "a2", Buffer.alloc(200, 2));
  check(over.status === 507 && over.data.error === "quota-exceeded", "per-account quota (600) enforced");
  check((await put(B, "b1", Buffer.alloc(450, 3))).status === 200, "second account fits");        // total 950
  const fullr = await put(C, "c1", Buffer.alloc(100, 4));
  check(fullr.status === 507 && fullr.data.error === "cloud-saves-full", "global storage cap -> 507 cloud-saves-full");
  let st = await status();
  check(st.total === 950, `tracked total bytes = 950 (got ${st.total})`);
  // delete frees storage
  check((await del(A, "a1")).data.deleted === true, "delete works");
  st = await status();
  check(st.total === 450, `delete freed storage (total ${st.total})`);
  check((await put(C, "c1", Buffer.alloc(100, 4))).status === 200, "put fits after delete");     // A ops so far: a1,b1,c1 = 3 (+ rejected ones spent none)
  // replace accounting
  const g0 = await get(C, "c1"); // B op 1
  check(g0.status === 200 && g0.data.length === 100, "get works");
  const l = await call(C, "GET", "/saves/list");
  check(l.status === 200 && l.data.files.length === 1 && l.data.used === 100, "list served from index");
  st = await status();
  check(st.a === 3 && st.b === 1, `ops counted: A=${st.a} B=${st.b} (want 3/1; list+delete cost nothing)`);

  // --- concurrent puts must not overshoot the global cap (450 + 100 = 550; room for 450 more) ---
  const D = await account(), E = await account();
  const rs = await Promise.all([D, E, D, E].map((a, i) => put(a, `race${i}`, Buffer.alloc(300, 9 + i))));
  const okc = rs.filter((r) => r.status === 200).length;
  st = await status();
  check(okc === 1 && st.total <= 1000, `concurrent puts: ${okc} accepted (want 1), total ${st.total} <= cap`);
  check(rs.every((r) => r.status === 200 || r.status === 507 || r.status === 429), "concurrent losers refused cleanly");

  // --- Class A cap (6): reconcile/other ops count; exhaust it ---
  st = await status();
  const leftA = 6 - st.a;
  let refused = null;
  for (let i = 0; i < leftA + 2; i++) {
    const r = await put(C, `cap${i}`, Buffer.alloc(1, i));
    if (r.status !== 200) { refused = r; break; }
  }
  check(refused && refused.status === 429 && refused.data.error === "cloud-saves-paused", "Class A cap -> 429 cloud-saves-paused");
  st = await status();
  check(st.a === 6, `Class A counter stops at the cap (${st.a})`);
  check((await del(C, "c1")).data.deleted === true, "delete still allowed while paused");

  // --- Class B cap (4): gets until refused ---
  const F = await account();
  // new month first so A has room for one put
  await test("/saves/_test/month?m=2099-01");
  st = await status();
  check(st.month === "2099-01" && st.a === 0 && st.b === 0, "month rollover resets counters");
  check((await put(F, "f1", Buffer.from("xyz"))).status === 200, "put works in the new month");
  let gs = [];
  for (let i = 0; i < 6; i++) gs.push((await get(F, "f1")).status);
  check(gs.slice(0, 4).every((s) => s === 200) && gs[4] === 429 && gs[5] === 429, `Class B cap (4) -> 429 after 4 gets (${gs})`);
  await test("/saves/_test/month?m=2099-02");
  check((await get(F, "f1")).status === 200, "next month: gets work again");

  // --- fail closed ---
  await test("/saves/_test/fail?on=1");
  const fr = [await put(F, "f2", Buffer.from("q")), await get(F, "f1"), await call(F, "GET", "/saves/list"), await del(F, "f1")];
  check(fr.every((r) => r.status === 429 && r.data.error === "cloud-saves-unavailable"), `budget DO failure refuses everything (${fr.map((r) => r.status)})`);
  await test("/saves/_test/fail?on=0");
  check((await get(F, "f1")).status === 200, "recovers once the DO is healthy");
  stop(); await sleep(1500);
  await start(PH2);
  await phase2();
  stop(); await sleep(1500);
  await start(PH3);
  await phase3();
  stop(); await sleep(1500);
  await start(PH4);
  await phase4();
}

main().catch((e) => { fails++; console.log("ERROR:", e); }).finally(() => {
  stop();
  console.log(fails ? `${fails} FAILED` : "ALL PASSED");
  process.exit(fails ? 1 : 0);
});
