// Tests for /admin/stats against a LOCAL `wrangler dev` (no real account). Usage: node test_stats.mjs (port 8796)
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.STATS_TEST_PORT) || 8796;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "test-admin-token-0123456789";
let fails = 0;
const check = (c, m) => { if (!c) { fails++; console.log("FAIL:", m); } else console.log("ok:  ", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let proc, persist;
async function start(vars) {
  persist = mkdtempSync(join(tmpdir(), "rh-stats-"));
  const args = ["node_modules/wrangler/bin/wrangler.js", "dev", "-c", "wrangler.jsonc", "--port", String(PORT),
    "--persist-to", persist, "--ip", "127.0.0.1"];
  for (const [k, v] of Object.entries(vars)) args.push("--var", `${k}:${v}`);
  proc = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  proc.stdout.on("data", (d) => (log += d)); proc.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 120; i++) { try { if ((await fetch(BASE + "/health")).ok) return; } catch { /* */ } await sleep(500); }
  console.log(log); throw new Error("dev server did not start");
}
function stop() {
  if (proc) { try { spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* */ } }
  try { rmSync(persist, { recursive: true, force: true }); } catch { /* */ }
}

async function admin(token) {
  const h = token === undefined ? {} : { authorization: `Bearer ${token}` };
  return fetch(BASE + "/admin/stats", { headers: h });
}

// Open a lobby socket, wait for welcome.
function openWs(query) {
  const ws = new WebSocket(`${BASE.replace("http", "ws")}/ws?${query}`);
  ws.binaryType = "arraybuffer";
  const inbox = [];
  ws.onmessage = (ev) => inbox.push(ev.data);
  const opened = new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws " + query)); });
  return { ws, inbox, opened };
}
async function waitFor(inbox, pred) {
  for (let i = 0; i < 100; i++) { const hit = inbox.find((m) => typeof m === "string" && pred(m)); if (hit) return hit; await sleep(50); }
  return null;
}

async function activity() {
  const room = "STATS2";   // valid code: lobby alphabet, 6 chars
  const ver = "9.9.9";
  const host = openWs(`room=${room}&role=host&v=2&hm=1&ver=${ver}`);
  await host.opened;
  check(!!(await waitFor(host.inbox, (m) => m.includes('"welcome"'))), "host welcome received");
  const join = openWs(`room=${room}&role=join&v=2&hm=1&ver=${ver}`);
  await join.opened;
  check(!!(await waitFor(join.inbox, (m) => m.includes('"welcome"'))), "joiner welcome received");
  join.ws.send(JSON.stringify({ type: "desync", reason: "test" }));
  join.ws.send(JSON.stringify({ type: "desync", reason: "test2" }));
  host.ws.send(JSON.stringify({ type: "relay" }));
  await waitFor(join.inbox, (m) => m.includes('"relaying"'));
  // Relayed binary frame so the relay path is exercised; then close the joiner to end the relay session.
  host.ws.send(new Uint8Array([0x02, 1, 2, 3]));
  await sleep(200);
  join.ws.close(); host.ws.close();
  await sleep(500);
}

async function main() {
  await start({ ADMIN_TOKEN: TOKEN });
  const noTok = await admin(undefined);
  check(noTok.status === 401, `no token -> 401 (got ${noTok.status})`);
  const badTok = await admin("nope");
  check(badTok.status === 401, `wrong token -> 401 (got ${badTok.status})`);
  const prefixTok = await admin(TOKEN.slice(0, 10));
  check(prefixTok.status === 401, `truncated token -> 401 (got ${prefixTok.status})`);
  const post = await fetch(BASE + "/admin/stats", { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } });
  check(post.status === 405, `POST -> 405 (got ${post.status})`);

  const before = await (await admin(TOKEN)).json();
  check(before.r2 && before.r2.classA && before.durableObjects && before.paused, "authorized read returns budget fields");
  const roomsBefore = before.counters.today.rooms, descBefore = before.counters.today.desync;

  await activity();

  const r = await admin(TOKEN);
  const text = await r.text();
  if (r.status !== 200) console.log("admin status", r.status, text.slice(0, 600));
  const s = JSON.parse(text);
  check(r.status === 200, "authorized read 200");
  check(s.counters.today.rooms === roomsBefore + 1, `rooms created +1 (${roomsBefore} -> ${s.counters.today.rooms})`);
  check(s.counters.today.desync === descBefore + 2, `desync +2 (${descBefore} -> ${s.counters.today.desync})`);
  check((s.counters.clientVersionsWeek["9.9.9"] || 0) >= 2, `client 9.9.9 seen >=2 connections (${s.counters.clientVersionsWeek["9.9.9"]})`);
  check(typeof s.counters.today.relayMinutes === "number", "relayMinutes present");
  check(s.r2.storageCapBytes === 7 * 1024 ** 3, "storage cap is 7 GB");
  check(s.paused.classA === false && s.paused.classB === false, "nothing paused on a fresh budget");

  stop();
  await sleep(1500);

  await start({});   // no ADMIN_TOKEN configured at all
  const off = await admin(TOKEN);
  check(off.status === 404, `no ADMIN_TOKEN configured -> 404 (got ${off.status})`);
  const off2 = await admin(undefined);
  check(off2.status === 404, `no ADMIN_TOKEN, no header -> 404 (got ${off2.status})`);
}

main().catch((e) => { fails++; console.log("ERROR:", e); }).finally(() => {
  stop();
  console.log(fails ? `${fails} FAILED` : "ALL PASSED");
  process.exit(fails ? 1 : 0);
});
