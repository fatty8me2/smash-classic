// Drop-in budget gate. Server must run with DAILY_REQ_CAP=60 (run_all_tests.mjs passes it).
// Lobby role=watch&dropin=1 and game-room role=join&dropin=1 get spectate-busy above 50%; a normal join is never gated by it.
const BASE = process.argv[2] || "ws://127.0.0.1:8799";
let fails = 0;
const check = (c, m) => { if (!c) { fails++; console.log("FAIL:", m); } else console.log("ok:  ", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function open(room, role, extra = "") {
  const ws = new WebSocket(`${BASE}/hub?room=${room}&role=${role}&name=t&caps=reasons${extra}`);
  const c = { ws, text: [], closed: null };
  ws.onmessage = (e) => { if (typeof e.data === "string") c.text.push(JSON.parse(e.data)); };
  ws.onclose = (e) => { c.closed = { code: e.code }; };
  c.send = (o) => { const d = JSON.stringify(o); if (ws.readyState === 0) ws.addEventListener("open", () => ws.send(d), { once: true }); else ws.send(d); };
  c.last = (t) => [...c.text].reverse().find((m) => m.type === t);
  c.wait = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(20); } return false; };
  return c;
}
const lobby = "KDRPSS", game = "KDRPGG-1";
const h = open(lobby, "host"); await h.wait(() => h.last("welcome"));
h.send({ type: "msg", body: { kind: "launch", game: "ssb64", dropin: 2 } });
const gh = open(game, "host"); await gh.wait(() => gh.last("welcome"));
await sleep(300);
const w1 = open(lobby, "watch", "&dropin=1");
check(await w1.wait(() => w1.last("welcome")?.dropin === true), "below 50%: lobby dropin accepted");
w1.ws.close();
const g1 = open(game, "join", "&dropin=1&slot=1");
check(await g1.wait(() => g1.last("welcome")?.slot === 1), "below 50%: game dropin join accepted");
g1.ws.close();
let busyL = null, busyG = null;
for (let i = 0; i < 50 && !(busyL && busyG); i++) {
  const burn = open("ZZZZZZ", "join"); await burn.wait(() => burn.closed);
  if (!busyL) {
    const w = open(lobby, "watch", "&dropin=1");
    await w.wait(() => w.closed || w.last("welcome"));
    if (w.last("error")?.reason === "spectate-busy") busyL = w; else w.ws.close();
  }
  if (!busyG) {
    const g = open(game, "join", "&dropin=1&slot=2");
    await g.wait(() => g.closed || g.last("welcome"));
    if (g.last("error")?.reason === "spectate-busy") busyG = g; else g.ws.close();
  }
}
check(!!busyL && (await busyL.wait(() => busyL.closed)) && busyL.closed.code === 4000, "above 50%: lobby dropin -> spectate-busy, 4000");
check(!!busyG && (await busyG.wait(() => busyG.closed)) && busyG.closed.code === 4000, "above 50%: game dropin join -> spectate-busy, 4000");
const n = open(game, "join", "&slot=3");
check(await n.wait(() => n.last("welcome")?.slot === 3), "normal join (no dropin=1) is not budget gated");
h.ws.close(); gh.ws.close(); n.ws.close();
console.log(fails ? `${fails} FAILED` : "ALL PASSED");
process.exit(fails ? 1 : 0);
