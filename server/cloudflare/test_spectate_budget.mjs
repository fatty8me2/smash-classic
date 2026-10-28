// (d) spectate budget gate. Server must run with DAILY_REQ_CAP=60 (run_all_tests.mjs passes it).
// Below 50% (30 units) a watcher is accepted; after burning requests it gets spectate-busy.
const BASE = process.argv[2] || "ws://127.0.0.1:8799";
let fails = 0;
const check = (c, m) => { if (!c) { fails++; console.log("FAIL:", m); } else console.log("ok:  ", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function open(room, role) {
  const ws = new WebSocket(`${BASE}/hub?room=${room}&role=${role}&name=t&caps=reasons`);
  const c = { ws, text: [], closed: null };
  ws.onmessage = (e) => { if (typeof e.data === "string") c.text.push(JSON.parse(e.data)); };
  ws.onclose = (e) => { c.closed = { code: e.code }; };
  c.last = (t) => [...c.text].reverse().find((m) => m.type === t);
  c.wait = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(20); } return false; };
  return c;
}
const room = "BUDGET".replace("B", "K");
const h = open(room, "host");
await h.wait(() => h.last("welcome"));
const w1 = open(room, "watch");
check(await w1.wait(() => w1.last("welcome")?.spec === true), "below 50%: watcher accepted");
w1.ws.close();
let busy = null;
for (let i = 0; i < 40 && !busy; i++) {
  const burn = open("ZZZZZ" + "Z".repeat(1), "join");   // no such room: costs a worker + DO request each
  await burn.wait(() => burn.closed);
  const w = open(room, "watch");
  await w.wait(() => w.closed || w.last("welcome"));
  if (w.last("error")?.reason === "spectate-busy") busy = w; else w.ws.close();
}
check(!!busy, "above 50%: watcher refused with spectate-busy");
check(busy && (await busy.wait(() => busy.closed)) && busy.closed.code === 4000, "spectate-busy closes 4000");
h.ws.close();
console.log(fails ? `${fails} FAILED` : "ALL PASSED");
process.exit(fails ? 1 : 0);
