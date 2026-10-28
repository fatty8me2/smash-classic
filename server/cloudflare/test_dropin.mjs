// Node test for drop-in (/hub role=watch&dropin=1 on lobby rooms, role=join&dropin=1 on game rooms).
// Run: node test_dropin.mjs ws://127.0.0.1:<port> (server started by run_all_tests.mjs)
const BASE = process.argv[2] || "ws://127.0.0.1:8799";
let fails = 0;
const check = (c, m) => { if (!c) { fails++; console.log("FAIL:", m); } else console.log("ok:  ", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function open(room, role, { caps = "hostmig,reasons", slot, name = "t", dropin = false } = {}) {
  const q = `room=${room}&role=${role}&name=${name}${caps ? `&caps=${caps}` : ""}${slot !== undefined ? `&slot=${slot}` : ""}${dropin ? "&dropin=1" : ""}`;
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
const launch = (extra = {}) => ({ type: "msg", body: { kind: "launch", game: "ssb64", port: 7777, ...extra } });

{
  // lobby
  {
    const room = code();
    const h = open(room, "host", { name: "H" });
    await h.wait(() => h.last("welcome"));
    const g = open(room, "join", { name: "G" });
    await g.wait(() => g.last("welcome"));
    await refused(open(room, "watch", { dropin: true }), "no-such-game", "no stored launch -> no-such-game");
    h.send(launch());
    await sleep(300);
    await refused(open(room, "watch", { dropin: true }), "host-too-old", "launch without dropin field -> host-too-old");
    h.send(launch({ dropin: "1" }));
    await sleep(300);
    await refused(open(room, "watch", { dropin: true }), "host-too-old", "non-integer dropin -> host-too-old");
    h.send(launch({ dropin: 0 }));
    await sleep(300);
    await refused(open(room, "watch", { dropin: true }), "no-free-port", "dropin:0 -> no-free-port");
    h.send(launch({ dropin: 1 }));
    await sleep(300);
    const d1 = open(room, "watch", { name: "D1", dropin: true });
    check(await d1.wait(() => d1.last("welcome")), "dropin seat welcome");
    const w = d1.last("welcome");
    check(w?.spec === true && w?.dropin === true && w?.slot === 6, "welcome spec:true dropin:true slot 6 (own pool, not a spectator slot)");
    check(await d1.wait(() => d1.last("msg")), "dropin seat gets stored launch");
    const l = d1.last("msg");
    check(l?.from === 0 && l.body.kind === "launch" && l.body.watch === true && l.body.dropin_join === true && l.body.dropin === 1, "launch replayed with watch:true, dropin_join:true");
    await sleep(200);
    check((h.last("members")?.members || []).length === 2, "dropin seat is not a member");
    // the server does not count ports (the host runner is the authority): a second seat is accepted, up to the seat cap of 2
    const d2 = open(room, "watch", { name: "D2", dropin: true });
    check(await d2.wait(() => d2.last("welcome")?.dropin === true) && d2.last("welcome").slot === 7, "second drop-in seat accepted (no server-side port counter), slot 7");
    await refused(open(room, "watch", { name: "D4", dropin: true }), "spectators-full", "drop-in seat cap of 2 -> spectators-full");
    d2.ws.close();
    const pw = open(room, "watch", { name: "PW" });
    await pw.wait(() => pw.last("msg"));
    check(pw.last("welcome")?.dropin === undefined && pw.last("msg")?.body.dropin_join === undefined && pw.last("msg")?.body.watch === true, "plain watcher unaffected by dropin counter, no dropin flags");
    const pw2 = open(room, "watch", { name: "PW2" });
    await pw2.wait(() => pw2.last("welcome"));
    await refused(open(room, "watch", { name: "PW3" }), "spectators-full", "spectators-full still applies to plain watchers");
    pw2.ws.close();
    d1.ws.close(); pw.ws.close();
    await sleep(300);
    h.send(launch({ dropin: 1 }));
    await sleep(300);
    const d3 = open(room, "watch", { name: "D3", dropin: true });
    check(await d3.wait(() => d3.last("welcome")?.dropin === true), "a new launch is served again");
    d3.ws.close();
    const j = open(room, "join", { name: "J", dropin: true });
    await j.wait(() => j.last("welcome"));
    check(j.last("welcome")?.spec === undefined && j.last("welcome")?.dropin === undefined, "lobby join with dropin=1 is a plain join");
    // no state survives a seat: any number of seats one after another is fine (nothing to leak), a launch with dropin:0 stays refused
    for (let k = 0; k < 4; k++) {
      const sk = open(room, "watch", { name: "S" + k, dropin: true });
      check(await sk.wait(() => sk.last("welcome")?.dropin === true), "repeated seat " + k + " accepted (no leaked port count)");
      sk.ws.close(); await sleep(150);
    }
    // a game-room dropin join and a later seat: the server holds no per-port state at all
    const gh = open(room + "-1", "host"); await gh.wait(() => gh.last("welcome"));
    const gj = open(room + "-1", "join", { slot: 2, dropin: true }); await gj.wait(() => gj.last("welcome"));
    gj.ws.close(); await sleep(300);
    const gj2 = open(room + "-1", "join", { slot: 2, dropin: true }); await gj2.wait(() => gj2.last("welcome"));
    check(gj2.last("welcome")?.slot === 2, "the same game-room slot can drop in again after a disconnect");
    const sl = open(room, "watch", { dropin: true });
    check(await sl.wait(() => sl.last("welcome")?.dropin === true), "a lobby seat is still served after game-room joins and leaves");
    sl.ws.close(); gh.ws.close(); gj2.ws.close();
    h.ws.close(); g.ws.close(); j.ws.close();
  }
  // no host
  await refused(open(code(), "watch", { dropin: true }), "no-such-room", "dropin watch without host -> no-such-room (same as spectate)");
  // game room
  {
    const room = code() + "-1";
    const h = open(room, "host", { name: "H" });
    await h.wait(() => h.last("welcome"));
    const g = open(room, "join", { name: "G", slot: 1 });
    await g.wait(() => g.last("welcome"));
    const d = open(room, "join", { name: "D", slot: 2, dropin: true });
    check(await d.wait(() => d.last("welcome")) && d.last("welcome").slot === 2 && d.last("welcome").spec === undefined, "game dropin join gets real slot 2, no spec");
    await sleep(200);
    const ml = h.last("members")?.members || [];
    check(ml.length === 3 && !ml.some((m) => "spec" in m), "members list has no spec flag");
    await refused(open(room, "join", { slot: 2, dropin: true }), "bad-slot", "taken slot -> bad-slot");
    const hb = h.bin.length, gb = g.bin.length, db = d.bin.length;
    h.send(new Uint8Array([2, 1, 1]));
    check(await d.wait(() => d.bin.length === db + 1) && d.bin[db][0] === 0, "host -> dropin relayed");
    d.send(new Uint8Array([0, 2, 2]));
    check(await h.wait(() => h.bin.length === hb + 1) && h.bin[hb][0] === 2, "dropin -> host relayed (src slot 2)");
    g.send(new Uint8Array([0xff, 3, 3]));
    check(await d.wait(() => d.bin.length === db + 2) && d.bin[db + 1][0] === 1, "guest 0xFF broadcast reaches dropin");
    d.send(new Uint8Array([0xff, 4, 4]));
    check(await g.wait(() => g.bin.length > gb), "dropin 0xFF reaches guest");
    const d4 = open(room, "join", { slot: 3, dropin: true });
    await d4.wait(() => d4.last("welcome"));
    await refused(open(room, "join", { dropin: true }), "room-full", "4 members max -> room-full");
    h.ws.close(); g.ws.close(); d.ws.close(); d4.ws.close();
  }
  await refused(open(code() + "-2", "join", { slot: 1, dropin: true }), "no-such-room", "game dropin without host -> no-such-room");
  console.log(fails ? `${fails} FAILED` : "ALL PASSED");
  process.exit(fails ? 1 : 0);
}
