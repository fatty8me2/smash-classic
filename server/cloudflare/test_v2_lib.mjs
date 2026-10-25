// Shared helpers for the cloud saves v2 tests: an isolated local `wrangler dev` (own registry, short --persist-to
// under C:\rhq\<port>, never production), friends-hello accounts, RHSIG signing and small v2 client helpers.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { deflateRawSync } from "node:zlib";

export const sha = (b) => createHash("sha256").update(b).digest("hex");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
export const b32 = (n) => Array.from(randomBytes(n), (b) => B32[b % 32]).join("");
export const devId = () => "d-" + randomBytes(5).toString("hex");

export function makeChecker() {
  const st = { fails: 0 };
  const check = (c, m) => { if (!c) { st.fails++; console.log("FAIL:", m); } else console.log("ok:  ", m); };
  return { st, check };
}

export async function startServer({ port, vars = {}, nor2 = false, saves = true }) {
  const root = process.env.RHQ_ROOT || "C:\\rhq";
  const persist = join(root, String(port));
  const registry = join(root, "reg" + port);
  rmSync(persist, { recursive: true, force: true });
  rmSync(registry, { recursive: true, force: true });
  mkdirSync(persist, { recursive: true });
  mkdirSync(registry, { recursive: true });
  const cfg = readFileSync("wrangler.jsonc", "utf8").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  const j = JSON.parse(cfg);
  if (nor2) delete j.r2_buckets; else j.r2_buckets = [{ binding: "SAVES", bucket_name: "retrohub-saves-test" }];
  const cfgName = `wrangler.v2test.${port}.jsonc`;
  writeFileSync(cfgName, JSON.stringify(j, null, 1));
  const args = ["node_modules/wrangler/bin/wrangler.js", "dev", "-c", cfgName, "--port", String(port), "--persist-to", persist, "--ip", "127.0.0.1"];
  for (const [k, v] of Object.entries({ BUDGET_TEST: "1", ...vars })) args.push("--var", `${k}:${v}`);
  const proc = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_REGISTRY_PATH: registry, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" } });
  let log = "";
  proc.stdout.on("data", (d) => (log += d)); proc.stderr.on("data", (d) => (log += d));
  const BASE = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 160 && !up; i++) {
    try { up = (await fetch(BASE + "/health")).ok; } catch { /* not yet */ }
    if (!up) await sleep(500);
  }
  if (!up) { console.log(log); try { proc.kill(); } catch { /* */ } throw new Error("dev server did not start on " + port); }
  const stop = () => {
    try { spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* own pid only */ }
    try { rmSync(cfgName); } catch { /* */ }
  };
  return { BASE, stop, log: () => log };
}

export async function account(BASE) {
  const uid = b32(26), secret = b32(52);
  const ws = new WebSocket(`${BASE.replace("http", "ws")}/friends?uid=${uid}`);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws")); });
  let ok = false; ws.onmessage = () => { ok = true; };
  ws.send(JSON.stringify({ type: "hello", secret, name: "tester", version: "test" }));
  for (let i = 0; i < 100 && !ok; i++) await sleep(50);
  ws.close();
  return { uid, secret, key: sha(secret) };
}

export function sign(acct, method, pathq, shaHdr, ts = Date.now(), cl = "-") {
  const msg = `${method}\n${pathq}\n${ts}\n${shaHdr || "-"}\n-\n-\n${method === "PUT" ? cl : "-"}\n-`;
  return `RHSIG uid=${acct.uid},ts=${ts},sig=${createHmac("sha256", acct.key).update(msg).digest("hex")}`;
}

export function client(BASE) {
  // Generic v2 call. json -> POST body (X-RH-Sha = sha256(body)); raw -> PUT bytes.
  async function call(acct, method, pathq, { json, raw, dev, headers = {}, ts, badSig, noSha, shaOverride } = {}) {
    const h = { ...headers };
    let body;
    let shaHdr;
    if (json !== undefined) { body = Buffer.from(JSON.stringify(json)); shaHdr = sha(body); }
    if (raw !== undefined) { body = raw; shaHdr = headers["X-RH-Sha"] || sha(raw); }
    if (shaOverride) shaHdr = shaOverride;
    if (noSha) shaHdr = undefined;
    if (shaHdr) h["X-RH-Sha"] = shaHdr;
    if (dev) h["X-RH-Device"] = dev;
    if (acct) h.Authorization = sign(badSig ? { ...acct, key: sha("x") } : acct, method, pathq, shaHdr, ts, body ? String(body.length) : "-");
    if (json !== undefined) h["content-type"] = "application/json";
    const r = await fetch(BASE + pathq, { method, headers: h, body });
    const ct = r.headers.get("content-type") || "";
    const data = ct.includes("json") ? await r.json() : Buffer.from(await r.arrayBuffer());
    return { status: r.status, data, headers: r.headers };
  }
  const P = "/saves/v2";
  const api = {
    call,
    status: (a, dev) => call(a, "GET", `${P}/status`, { dev }),
    manifest: (a, q = "", dev) => call(a, "GET", `${P}/manifest${q}`, { dev }),
    device: (a, dev, name) => call(a, "POST", `${P}/device`, { json: { dev, name } }),
    plan: (a, game, files, o = {}) => call(a, "POST", `${P}/plan`, { json: { game, played_at: o.played ?? Math.floor(Date.now() / 1000), mode: o.mode || "rw", files }, dev: o.dev }),
    commit: (a, ticket, dev) => call(a, "POST", `${P}/commit`, { json: { ticket }, dev }),
    blobPut: (a, plainSha, ticket, bytes, dev, storedSha) => call(a, "PUT", `${P}/blob?sha=${plainSha}&ticket=${ticket}`, { raw: bytes, headers: { "X-RH-Sha": storedSha || sha(bytes) }, dev }),
    blobGet: (a, game, path, ver, headers) => call(a, "GET", `${P}/blob?game=${encodeURIComponent(game)}&path=${encodeURIComponent(path)}${ver != null ? "&ver=" + ver : ""}`, { headers }),
    restore: (a, game, path, ver, base) => call(a, "POST", `${P}/restore`, { json: { game, path, ver, base } }),
    gameOp: (a, body) => call(a, "POST", `${P}/game`, { json: body }),
    lease: (a, game, mode, dev, take) => call(a, "POST", `${P}/lease`, { json: { game, mode, ...(take ? { take: true } : {}) }, dev }),
    beat: (a, game, dev) => call(a, "POST", `${P}/lease/beat`, { json: { game }, dev }),
    release: (a, game, dev) => call(a, "POST", `${P}/lease/release`, { json: { game }, dev }),
    hook: async (name, q = {}) => (await fetch(`${BASE}/saves/_test/${name}?${new URLSearchParams(q)}`)).json(),
  };
  // push helper: plan -> upload needed blobs -> commit. files: [{path, data(Buffer), mtime, base, deflate}]
  api.push = async (a, game, files, o = {}) => {
    const specs = files.map((f) => {
      const plain = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
      const comp = f.deflate ? deflateRawSync(plain) : null;
      const stored = comp || plain;
      return { path: f.path, sha: sha(plain), size: plain.length, stored: stored.length, enc: comp ? "deflate" : "none", mtime: f.mtime ?? 1000, base: f.base ?? 0, _bytes: stored };
    });
    const pl = await api.plan(a, game, specs.map(({ _bytes, ...s }) => s), o);
    if (pl.status !== 200) return { plan: pl };
    const ups = [];
    for (const r of pl.data.files) {
      if (r.action !== "upload") continue;
      const sp = specs.find((s) => s.path === r.path);
      ups.push(await api.blobPut(a, sp.sha, pl.data.ticket, sp._bytes, o.dev, sha(sp._bytes)));
    }
    if (!pl.data.ticket) return { plan: pl, ups };
    const cm = await api.commit(a, pl.data.ticket, o.dev);
    return { plan: pl, ups, commit: cm };
  };
  return api;
}
export { deflateRawSync };
