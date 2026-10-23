// Tests for the global R2 budget guard (src/r2budget.js) against a LOCAL `wrangler dev` (simulated R2, never the
// real Cloudflare account). Tiny caps are injected with --var.  Usage: node test_r2budget.mjs   (port 8793)
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, createHmac, randomBytes } from "node:crypto";

const PORT = Number(process.env.BUDGET_TEST_PORT) || 8793;
const BASE = `http://127.0.0.1:${PORT}`;
let fails = 0;
const check = (c, m) => { if (!c) { fails++; console.log("FAIL:", m); } else console.log("ok:  ", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => createHash("sha256").update(b).digest("hex");
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const b32 = (n) => Array.from(randomBytes(n), (b) => B32[b % 32]).join("");

let proc;
async function start() {
  const cfg = readFileSync("wrangler.jsonc", "utf8").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  const j = JSON.parse(cfg);
  j.r2_buckets = [{ binding: "SAVES", bucket_name: "retrohub-saves-test" }];
  writeFileSync("wrangler.budget.jsonc", JSON.stringify(j, null, 1));
  const persist = mkdtempSync(join(tmpdir(), "rh-r2b-"));
  const vars = { BUDGET_TEST: "1", BUDGET_STORAGE_MAX: "1000", BUDGET_A_MAX: "6", BUDGET_B_MAX: "4", SAVES_QUOTA: "600", SAVES_MAX_FILES: "50" };
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

async function main() {
  await start();
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
  check(fr.every((r) => r.status === 429 && r.data.error === "cloud-saves-paused"), `budget DO failure refuses everything (${fr.map((r) => r.status)})`);
  await test("/saves/_test/fail?on=0");
  check((await get(F, "f1")).status === 200, "recovers once the DO is healthy");
  // the object really was not touched while failing closed
}

main().catch((e) => { fails++; console.log("ERROR:", e); }).finally(() => {
  stop();
  console.log(fails ? `${fails} FAILED` : "ALL PASSED");
  process.exit(fails ? 1 : 0);
});
