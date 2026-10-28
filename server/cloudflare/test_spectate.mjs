// Node test for /hub role=watch (spectator seats). Run: node test_spectate.mjs ws://127.0.0.1:<port> (server started by run_all_tests.mjs)
const BASE = process.argv[2] || "ws://127.0.0.1:8799";
let fails = 0;
const check = (c, m) => { if (!c) { fails++; console.log("FAIL:", m); } else console.log("ok:  ", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function open(room, role, { caps = "hostmig,reasons", slot, name = "t" } = {}) {
  const q = `room=${room}&role=${role}&name=${name}${caps ? `&caps=${caps}` : ""}${slot !== undefined ? `&slot=${slot}` : ""}`;
  const ws = new WebSocket(`${BASE}/hub?${q}`);
  ws.binaryType = "arraybuffer";
  const c = { ws, text: [], bin: [], closed: null };
  ws.onmessage = (e) => { if (typeof e.data === "string") c.text.push(JSON.parse(e.data)); else c.bin.push(new Uint8Array(e.data)); };
  ws.onclose = (e) => { c.closed = { code: e.code, reason: e.reason }; };
  c.send = (o) => { const d = typeof o === "string" || o instanceof Uint8Array ? o : JSON.stringify(o); if (ws.readyState === 0) ws.addEventListener("open", () => ws.send(d), { once: true }); else ws.send(d); };
  c.last = (type) => [...c.text].reverse().find((m) => m.type === type);
  c.wait = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(20); } return false; };
  return c;
}
const code = () => { const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; let s = ""; for (let i = 0; i < 6; i++) s += a[Math.floor(Math.random() * a.length)]; return s; };
const refused = async (c, reason, m) => check(await c.wait(() => c.closed) && c.last("error")?.reason === reason && c.closed.code === 4000, m);

{
  // (a) lobby
  {
    const room = code();
    const h = open(room, "host", { name: "H" });
    await h.wait(() => h.last("welcome"));
    const g = open(room, "join", { name: "G" });
    await g.wait(() => g.last("welcome"));
    h.send({ type: "msg", body: { kind: "launch", game: "ssb64", launch: 1, port: 7777 } });
    await sleep(300);
    const w1 = open(room, "watch", { name: "W1" });
    check(await w1.wait(() => w1.last("welcome")), "lobby watcher welcome");
    check(w1.last("welcome")?.spec === true && w1.last("welcome")?.slot === 4, "welcome spec:true slot 4");
    check(await w1.wait(() => w1.last("msg")), "watcher gets stored launch");
    const l = w1.last("msg");
    check(l?.from === 0 && l.body.kind === "launch" && l.body.game === "ssb64" && l.body.watch === true, "stored launch has watch:true");
    await sleep(200);
    check(!(h.last("members")?.members || []).some((m) => m.slot >= 4) && (h.last("members")?.members || []).length === 2, "host members list excludes spectator");
    check(!(g.last("members")?.members || []).some((m) => m.slot >= 4), "joiner members list excludes spectator");
    const w2 = open(room, "watch", { name: "W2" });
    await w2.wait(() => w2.last("welcome"));
    check(w2.last("welcome")?.slot === 5, "second watcher slot 5");
    const w3 = open(room, "watch", { name: "W3" });
    await refused(w3, "spectators-full", "3rd watcher -> spectators-full");
    // binary injection dropped; host binary not delivered to watchers
    const gb = g.bin.length, hb = h.bin.length;
    w1.send(new Uint8Array([0, 1, 2, 3]));
    w1.send(new Uint8Array([0xff, 1, 2, 3]));
    h.send(new Uint8Array([0xff, 9, 9]));
    await sleep(400);
    check(h.bin.length === hb && g.bin.length === gb + 1, "watcher binary dropped; host broadcast reaches joiner only");
    check(w1.bin.length === 0 && w2.bin.length === 0, "watchers receive no binary");
    // new launch reaches watchers live
    h.send({ type: "msg", body: { kind: "launch", game: "ssb64", launch: 2 } });
    check(await w2.wait(() => w2.text.filter((m) => m.type === "msg" && m.body.launch === 2).length), "live launch broadcast to watcher");
    // watcher msg is ignored
    w1.send({ type: "msg", body: { kind: "chat" } });
    await sleep(300);
    check(!h.text.some((m) => m.type === "msg" && m.body.kind === "chat"), "watcher msg ignored");
    w1.ws.close(); await sleep(300);
    const w4 = open(room, "watch", { name: "W4" });
    await w4.wait(() => w4.last("welcome"));
    check(w4.last("welcome")?.slot === 4, "freed lobby watcher slot reused");
    w2.send({ type: "endpoint", public: "1.1.1.1:1", local: "-" });   // (workerd only delivers a 4001 close to sockets that have spoken)
    await sleep(200);
    h.ws.close(); // no migration for watchers
    check(await w2.wait(() => w2.closed) && w2.closed.code === 4001, "lobby host leaving closes watchers with 4001");
    w4.ws.close(); g.ws.close();
  }
  // (b) game room
  {
    const room = code() + "-1";
    const h = open(room, "host", { name: "H" });
    await h.wait(() => h.last("welcome"));
    const g = open(room, "join", { name: "G", slot: 1 });
    await g.wait(() => g.last("welcome"));
    const w1 = open(room, "watch", { name: "W1" });
    await w1.wait(() => w1.last("welcome"));
    const w2 = open(room, "watch", { name: "W2" });
    await w2.wait(() => w2.last("welcome"));
    check(w1.last("welcome")?.slot === 2 && w1.last("welcome")?.spec === true && w2.last("welcome")?.slot === 3, "game watchers slots 2 and 3, spec welcome");
    await sleep(200);
    const ml = h.last("members")?.members || [];
    check(ml.length === 4 && ml.filter((m) => m.spec).map((m) => m.slot).join() === "2,3" && !("spec" in ml[0]) && !("spec" in ml[1]), "members: spec flag only on spectators");
    const w3 = open(room, "watch", { name: "W3" });
    await refused(w3, "spectators-full", "game: 3rd watcher -> spectators-full");
    h.send({ type: "endpoint", public: "1.1.1.1:1", local: "10.0.0.1:1" });
    w1.send({ type: "endpoint", public: "1.1.1.2:1", local: "10.0.0.2:1" });
    await sleep(300);
    check((h.last("peers")?.peers || []).some((p) => p.slot === 2), "spectator listed in peers after endpoint");
    h.send(new Uint8Array([0xff, 7, 7]));
    await sleep(300);
    check(g.bin.length === 1 && w1.bin.length === 0 && w2.bin.length === 0, "0xFF from host not delivered to spectators");
    h.send(new Uint8Array([2, 5, 5]));
    check(await w1.wait(() => w1.bin.length === 1) && w1.bin[0][0] === 0 && w2.bin.length === 0, "explicit dest from host delivered to that spectator");
    g.send(new Uint8Array([2, 6, 6]));
    await sleep(300);
    check(w1.bin.length === 1, "guest -> spectator slot dropped");
    const hb = h.bin.length, gb = g.bin.length;
    w1.send(new Uint8Array([0xff, 1]));
    w1.send(new Uint8Array([1, 1]));
    w1.send(new Uint8Array([3, 1]));
    await sleep(300);
    check(h.bin.length === hb && g.bin.length === gb && w2.bin.length === 0, "spectator 0xFF / non-host dest dropped");
    w1.send(new Uint8Array([0, 4, 4]));
    check(await h.wait(() => h.bin.length === hb + 1) && h.bin[hb][0] === 2, "spectator -> host delivered (src slot 2)");
    h.ws.close();
    check(await w1.wait(() => w1.closed) && w1.closed.code === 4001 && w1.last("error")?.reason === "host-left-game", "game host leaving closes spectators 4001 + host-left-game");
    g.ws.close(); w2.ws.close();
  }
  // room-full in a 4-player game room
  {
    const room = code() + "-2";
    const h = open(room, "host"); await h.wait(() => h.last("welcome"));
    const gs = [1, 2, 3].map((s) => open(room, "join", { slot: s }));
    for (const g of gs) await g.wait(() => g.last("welcome"));
    const w = open(room, "watch");
    await refused(w, "room-full", "full 4-player game room -> room-full for watcher");
    h.ws.close();
  }
  // (c) no host
  {
    const w = open(code(), "watch");
    await refused(w, "no-such-room", "watch without host -> no-such-room");
    const w2 = open(code() + "-3", "watch", { caps: "" });
    await refused(w2, "no-such-room", "watch empty game room -> no-such-room");
  }
  console.log(fails ? `${fails} FAILED` : "ALL PASSED");
  process.exit(fails ? 1 : 0);
}
