// Node test for the /hub lobby endpoint's distinct failure reasons (&caps=reasons) and legacy compatibility.
// Run: npx wrangler dev --ip 127.0.0.1 --port 8799   (other shell), then: node test_hub_reasons.mjs ws://127.0.0.1:8799
const BASE = process.argv[2] || "ws://127.0.0.1:8799";
let fails = 0;
const check = (c, m) => { if (!c) { fails++; console.log("FAIL:", m); } else console.log("ok:  ", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function open(room, role, { caps = "hostmig,reasons", slot, name = "t" } = {}) {
  const q = `room=${room}&role=${role}&name=${name}${caps ? `&caps=${caps}` : ""}${slot !== undefined ? `&slot=${slot}` : ""}`;
  const ws = new WebSocket(`${BASE}/hub?${q}`);
  const c = { ws, text: [], closed: null };
  ws.onmessage = (e) => { if (typeof e.data === "string") c.text.push(JSON.parse(e.data)); };
  ws.onclose = (e) => { c.closed = { code: e.code, reason: e.reason }; };
  c.send = (o) => { const d = JSON.stringify(o); if (ws.readyState === 0) ws.addEventListener("open", () => ws.send(d), { once: true }); else ws.send(d); };
  c.last = (type) => [...c.text].reverse().find((m) => m.type === type);
  c.wait = async (fn, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(20); } return false; };
  return c;
}
const code = () => { const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; let s = ""; for (let i = 0; i < 6; i++) s += a[Math.floor(Math.random() * a.length)]; return s; };

// bad-slot (new clients) vs room-full (legacy clients)
{
  const room = code();
  const h = open(room, "host");
  check(await h.wait(() => h.last("welcome")), "host welcome");
  const g1 = open(room, "join", { slot: 1 });
  check(await g1.wait(() => g1.last("welcome")?.slot === 1), "guest takes slot 1");
  const dup = open(room, "join", { slot: 1 });
  check(await dup.wait(() => dup.closed) && dup.last("error")?.reason === "bad-slot", "taken slot -> bad-slot");
  const zero = open(room, "join", { slot: 0 });
  check(await zero.wait(() => zero.closed) && zero.last("error")?.reason === "bad-slot", "slot 0 -> bad-slot");
  const legacy = open(room, "join", { slot: 1, caps: "hostmig" });
  check(await legacy.wait(() => legacy.closed) && legacy.last("error")?.reason === "room-full", "legacy client still gets room-full");
  h.ws.close(); g1.ws.close();
}

// game room: guest before host -> host-reconnecting once another guest waits; legacy keeps no-such-room
{
  const room = code() + "-7";
  const early = open(room, "join", { slot: 1 });
  check(await early.wait(() => early.closed) && early.last("error")?.reason === "no-such-room", "empty game room -> no-such-room");
  const h = open(room, "host");
  await h.wait(() => h.last("welcome"));
  const g = open(room, "join", { slot: 1 });
  check(await g.wait(() => g.last("welcome")), "game-room guest joins");
  h.send({ type: "endpoint", public: "1.1.1.1:1", local: "10.0.0.1:1" });
  g.send({ type: "endpoint", public: "1.1.1.2:1", local: "10.0.0.2:1" });
  await sleep(200);
  h.ws.close();
  check(await g.wait(() => g.closed), "game guest closed when host leaves");
  check(g.closed?.code === 4001 && g.last("error")?.reason === "host-left-game", "guest told host-left-game (then 4001)");
  g.ws.close();
}
{
  // host-reconnecting needs members but no host: only reachable transiently; verify the legacy path is untouched.
  const room = code() + "-8";
  const h = open(room, "host", { caps: "" });
  await h.wait(() => h.last("welcome"));
  const g = open(room, "join", { slot: 1, caps: "" });
  await g.wait(() => g.last("welcome"));
  g.send({ type: "endpoint", public: "1.1.1.2:1", local: "10.0.0.2:1" });
  h.send({ type: "endpoint", public: "1.1.1.1:1", local: "10.0.0.1:1" });
  await sleep(200);
  h.ws.close();
  check(await g.wait(() => g.closed) && g.closed.code === 4001 && !g.last("error"), "legacy guest: plain 4001, no extra error frame");
}
console.log(fails ? `${fails} FAILED` : "ALL OK");
process.exit(fails ? 1 : 0);
