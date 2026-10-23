// Node 24 test for the Smash /ws relay. Usage: node test_relay.mjs [ws://127.0.0.1:8796]
// Run: npx wrangler dev --port 8796   (in another shell), then: node test_relay.mjs ws://127.0.0.1:8796
const BASE = process.argv[2] || "ws://127.0.0.1:8796";
let fails = 0;
const check = (c, m) => { if (!c) { fails++; console.log("FAIL:", m); } else console.log("ok:  ", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Live Workers: ~1 s connects with multi-second spikes -> generous condition waits, longer negative settles.
const REMOTE = !/^wss?:\/\/(127\.0\.0\.1|localhost)/.test(BASE);
const settle = (ms) => sleep(REMOTE ? Math.max(ms, 2500) : ms);

function open(room, role) {
  const ws = new WebSocket(`${BASE}/ws?room=${room}&role=${role}`);
  ws.binaryType = "arraybuffer";
  const c = { ws, text: [], bin: [], closed: null };
  ws.onmessage = (e) => {
    if (typeof e.data === "string") c.text.push(JSON.parse(e.data));
    else c.bin.push(new Uint8Array(e.data));
  };
  ws.onclose = (e) => { c.closed = { code: e.code, reason: e.reason }; };
  c.send = (o) => {
    const data = JSON.stringify(o);
    if (ws.readyState === 0) ws.addEventListener("open", () => ws.send(data), { once: true });
    else ws.send(data);
  };
  c.last = (type) => [...c.text].reverse().find((m) => m.type === type);
  c.wait = async (fn, ms = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(20); }
    return false;
  };
  return c;
}
const code = () => {
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = ""; for (let i = 0; i < 6; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
};

const room = code();
const host = open(room, "host");
check(await host.wait(() => host.last("welcome")), "host welcome");
const join = open(room, "join");
check(await join.wait(() => join.last("welcome")), "join welcome");

// Before relay is on, binary frames are dropped.
host.ws.send(new Uint8Array([9, 9, 9]));
await settle(300);
check(join.bin.length === 0, "binary dropped before relay flag set");

// Endpoint introduction.
host.send({ type: "endpoint", public: "1.2.3.4:1000", local: "10.0.0.1:1000" });
join.send({ type: "endpoint", public: "5.6.7.8:2000", local: "10.0.0.2:2000" });
check(await host.wait(() => host.last("peer")), "host gets peer");
check(await join.wait(() => join.last("peer")), "join gets peer");

// Relay on.
host.send({ type: "relay" });
check(await host.wait(() => host.last("relaying")), "host relaying msg");
check(await join.wait(() => join.last("relaying")), "join relaying msg");

// Binary both directions, ordered.
const N = 200;
for (let i = 0; i < N; i++) {
  host.ws.send(new Uint8Array([1, i & 255, i >> 8]));
  join.ws.send(new Uint8Array([2, i & 255, i >> 8]));
}
check(await join.wait(() => join.bin.length >= N, 20000), "join received all host packets");
check(await host.wait(() => host.bin.length >= N, 20000), "host received all join packets");
const ordered = (c, tag) => c.bin.every((b, i) => b[0] === tag && (b[1] | (b[2] << 8)) === i);
check(ordered(join, 1), "host->join packets in order");
check(ordered(host, 2), "join->host packets in order");

// Oversize frames are dropped; still works after.
const before = join.bin.length;
host.ws.send(new Uint8Array(2000));
host.ws.send(new Uint8Array([7]));
await join.wait(() => join.bin.length > before, 2000);
check(join.bin.length === before + 1 && join.bin[before][0] === 7, "oversize dropped, next packet delivered");

// Relay flag survives a late packet burst after idle gap (storage/cached flag still on).
await sleep(1500);
host.ws.send(new Uint8Array([5, 5]));
check(await join.wait(() => join.bin.at(-1)?.[0] === 5), "relay still on after idle");

// New host in a fresh room code does not inherit relay; same-room restart resets it.
host.ws.close();
check(await join.wait(() => join.closed), "join closed when host leaves");
const host2 = open(room, "host");
check(await host2.wait(() => host2.last("welcome")), "new host welcome");
const join2 = open(room, "join");
check(await join2.wait(() => join2.last("welcome")), "new join welcome");
host2.ws.send(new Uint8Array([3]));
await settle(300);
check(join2.bin.length === 0, "relay flag cleared by new host");
host2.send({ type: "relay" });
check(await join2.wait(() => join2.last("relaying")), "relay re-enabled");
host2.ws.send(new Uint8Array([4]));
check(await join2.wait(() => join2.bin.length === 1 && join2.bin[0][0] === 4), "packet relayed after re-enable");

for (const c of [host2, join2, join]) try { c.ws.close(); } catch {}
console.log(fails ? `${fails} FAILED` : "ALL PASSED");
process.exit(fails ? 1 : 0);
