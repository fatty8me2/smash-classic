// /hub host grace: an abnormal drop (TCP reset, no close frame -> 1006) of slot 0 is held for HOST_GRACE_MS.
// Run: wrangler dev --var HOST_GRACE_MS:1500 ..., then: node test_hostgrace.mjs ws://127.0.0.1:PORT
import net from "node:net";
const BASE = process.argv.find((a) => /^wss?:\/\//.test(a)) || "ws://127.0.0.1:8799";
const GRACE = 1500;
let fails = 0;
const check = (c, m) => { if (!c) { fails++; console.log("FAIL:", m); } else console.log("ok:  ", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function open(room, role, { caps = "hostmig,reasons", slot, name = "t" } = {}) {
  const q = `room=${room}&role=${role}&name=${name}${caps ? `&caps=${caps}` : ""}${slot !== undefined ? `&slot=${slot}` : ""}`;
  const ws = new WebSocket(`${BASE}/hub?${q}`);
  const c = { ws, text: [], closed: null };
  ws.onmessage = (e) => { if (typeof e.data === "string") c.text.push(JSON.parse(e.data)); };
  ws.onclose = (e) => { c.closed = { code: e.code, reason: e.reason }; };
  c.last = (type) => [...c.text].reverse().find((m) => m.type === type);
  c.wait = async (fn, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(20); } return false; };
  return c;
}
// A host over a raw TCP socket, so the test can drop it without a close frame (what a Wi-Fi blip looks like to the server).
function rawHost(room, name, caps = "hostmig,reasons") {
  const u = new URL(BASE);
  const sock = net.connect(Number(u.port || 80), u.hostname);
  const c = { sock, up: false };
  sock.on("data", (d) => { if (String(d).startsWith("HTTP/1.1 101")) c.up = true; });
  sock.on("error", () => {});
  sock.on("connect", () => sock.write(`GET /hub?room=${room}&role=host&name=${name}&caps=${caps} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`));
  c.wait = async (ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (c.up) return true; await sleep(20); } return false; };
  c.drop = () => sock.destroy();
  return c;
}
const code = () => { const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; let s = ""; for (let i = 0; i < 6; i++) s += a[Math.floor(Math.random() * a.length)]; return s; };

// ---- game room: blip, guest unaffected, same host reclaims slot 0 ----
{
  const room = code() + "-1";
  const h = rawHost(room, "n64run");
  check(await h.wait(), "raw host connected");
  const g = open(room, "join", { slot: 1, name: "g" });
  check(await g.wait(() => g.last("welcome")?.slot === 1), "guest joined slot 1");
  const nMembers = g.text.filter((m) => m.type === "members").length;
  h.drop();
  await sleep(400);
  check(!g.closed, "guest socket stays open during the grace");
  const lastM = g.last("members");
  check(lastM.members.some((m) => m.slot === 0), "members still lists the held host");
  check(g.text.filter((m) => m.type === "members").length >= nMembers, "no member list without the host was sent");
  const other = open(room, "host", { name: "intruder" });
  check(await other.wait(() => other.closed) && other.last("error")?.reason === "room-in-use", "a different identity cannot take the held seat (room-in-use)");
  const late = open(room, "join", { slot: 2, name: "late" });
  check(await late.wait(() => late.closed) && late.last("error")?.reason === "host-reconnecting", "new joiners are told host-reconnecting");
  const back = open(room, "host", { name: "n64run" });
  check(await back.wait(() => back.last("welcome")?.slot === 0), "same host reclaims slot 0 inside the grace");
  await sleep(GRACE + 800);
  check(!g.closed, "guest still connected after the grace window passed (alarm is a no-op)");
  check(!back.closed, "reclaimed host still connected");
  back.ws.close(); g.ws.close();
}

// ---- game room: host never returns -> guests closed 4001 after the grace ----
{
  const room = code() + "-2";
  const h = rawHost(room, "n64run");
  await h.wait();
  const g = open(room, "join", { slot: 1, name: "g" });
  await g.wait(() => g.last("welcome"));
  const t0 = Date.now();
    h.drop();
  check(await g.wait(() => g.last("error"), GRACE + 4000), "guest told host-left-game once the grace ran out");
  const dt = Date.now() - t0;
  check(g.last("error")?.reason === "host-left-game", "error host-left-game (then 4001 close)");
  check(dt >= GRACE - 200, `not before the grace (${dt} ms)`);
}

// ---- lobby room: blip -> same host reclaims; or migration after the grace ----
{
  const room = code();
  const h = rawHost(room, "alice");
  await h.wait();
  const g = open(room, "join", { name: "bob" });
  await g.wait(() => g.last("welcome"));
  h.drop();
  await sleep(300);
  check(!g.last("host_changed"), "no host change inside the grace");
  const back = open(room, "host", { name: "alice" });
  check(await back.wait(() => back.last("welcome")?.slot === 0), "lobby host reclaims slot 0 (no room-in-use)");
  await sleep(GRACE + 600);
  check(!g.last("host_changed"), "no host change after a successful reclaim");
  back.ws.close(); g.ws.close();
}
{
  const room = code();
  const h = rawHost(room, "alice");
  await h.wait();
  const g = open(room, "join", { name: "bob" });
  await g.wait(() => g.last("welcome"));
  h.drop();
  check(await g.wait(() => g.last("host_changed"), GRACE + 4000), "after the grace the guest is promoted");
  check(g.last("host_changed").slot === 0, "promoted to slot 0");
  g.ws.close();
}

// ---- a clean close migrates at once (no grace) ----
{
  const room = code();
  const h = open(room, "host", { name: "alice" });
  await h.wait(() => h.last("welcome"));
  const g = open(room, "join", { name: "bob" });
  await g.wait(() => g.last("welcome"));
  const t0 = Date.now();
  h.ws.close();
  check(await g.wait(() => g.last("host_changed"), 1200), "clean host close still migrates immediately");
  check(Date.now() - t0 < GRACE, "...without waiting for the grace");
  g.ws.close();
}

console.log(fails ? `${fails} FAILED` : "all ok");
process.exit(fails ? 1 : 0);
