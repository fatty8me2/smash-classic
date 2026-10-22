// Node test for the 4-player /ws room (protocol v2) and legacy (v1) compatibility.
// Usage: node test_room4.mjs [ws://127.0.0.1:8799]   (against `npx wrangler dev --port 8799`)
const BASE = process.argv[2] || "ws://127.0.0.1:8799";
let fails = 0;
const check = (c, m) => { if (!c) { fails++; console.log("FAIL:", m); } else console.log("ok:  ", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function open(room, role, v = 2) {
  const ws = new WebSocket(`${BASE}/ws?room=${room}&role=${role}${v ? `&v=${v}` : ""}`);
  ws.binaryType = "arraybuffer";
  const c = { ws, text: [], bin: [], closed: null };
  ws.onmessage = (e) => {
    if (typeof e.data === "string") c.text.push(JSON.parse(e.data));
    else c.bin.push(new Uint8Array(e.data));
  };
  ws.onclose = (e) => { c.closed = { code: e.code, reason: e.reason }; };
  c.send = (o) => ws.send(JSON.stringify(o));
  c.last = (type) => [...c.text].reverse().find((m) => m.type === type);
  c.wait = async (fn, ms = 3000) => {
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

// ---- v2: four players ----
{
  const room = code();
  const p = [open(room, "host")];
  check(await p[0].wait(() => p[0].last("welcome")), "host welcome");
  check(p[0].last("welcome").slot === 0 && p[0].last("welcome").max === 4, "host is slot 0, max 4");
  for (let i = 1; i <= 3; i++) {
    p.push(open(room, "join"));
    check(await p[i].wait(() => p[i].last("welcome")), `joiner ${i} welcome`);
    check(p[i].last("welcome").slot === i, `joiner ${i} gets slot ${i}`);
  }
  const fifth = open(room, "join");
  check(await fifth.wait(() => fifth.closed), "fifth player rejected");
  check(fifth.last("error")?.reason === "room-full", "fifth player gets room-full");

  for (let i = 0; i < 4; i++) p[i].send({ type: "endpoint", public: `1.1.1.${i}:100${i}`, local: `10.0.0.${i}:100${i}` });
  check(await p[0].wait(() => p[0].last("peers")?.peers.length === 4 && p[0].last("peers").peers.every((x) => x.public !== "-")), "host sees all 4 endpoints");
  check(await p[3].wait(() => p[3].last("peers")?.peers.length === 4 && p[3].last("peers").peers.every((x) => x.public !== "-")), "slot 3 sees all 4 endpoints");

  // Relay is off: binary dropped.
  p[0].ws.send(new Uint8Array([1, 9, 9]));
  await sleep(300);
  check(p[1].bin.length === 0, "binary dropped before relay flag set");

  p[2].send({ type: "relay" });
  for (let i = 0; i < 4; i++) check(await p[i].wait(() => p[i].last("relaying")), `player ${i} gets relaying`);

  // Relay: [destination mask][payload] -> [source][payload].
  p[1].ws.send(new Uint8Array([1 << 3, 0xAA, 0xBB]));
  check(await p[3].wait(() => p[3].bin.length >= 1), "slot 3 receives slot 1's frame");
  check(p[3].bin[0][0] === 1 && p[3].bin[0][1] === 0xAA && p[3].bin[0][2] === 0xBB, "source byte rewritten to 1, payload intact");
  check(p[0].bin.length === 0 && p[2].bin.length === 0, "other players don't see it");
  p[1].ws.send(new Uint8Array([1 << 1, 7]));   // to itself
  p[1].ws.send(new Uint8Array([0x10, 7]));     // no valid destination
  await sleep(300);
  check(p[1].bin.length === 0, "self/invalid destinations dropped");

  // Multicast: one frame to slots 0, 2 and 3.
  const before = [p[0].bin.length, p[2].bin.length, p[3].bin.length];
  p[1].ws.send(new Uint8Array([0b1101, 0x42]));
  check(await p[0].wait(() => p[0].bin.length === before[0] + 1), "multicast reaches slot 0");
  check(await p[2].wait(() => p[2].bin.length === before[1] + 1), "multicast reaches slot 2");
  check(await p[3].wait(() => p[3].bin.length === before[2] + 1), "multicast reaches slot 3");
  check(p[3].bin.at(-1)[0] === 1 && p[3].bin.at(-1)[1] === 0x42, "multicast carries source slot and payload");
  p[0].bin.length = 0; p[2].bin.length = 0; p[3].bin.length = 0;

  // Ordered delivery both ways, many frames.
  const N = 200;
  for (let i = 0; i < N; i++) {
    p[0].ws.send(new Uint8Array([1 << 2, i & 255, i >> 8]));
    p[2].ws.send(new Uint8Array([1 << 0, i & 255, i >> 8]));
  }
  check(await p[2].wait(() => p[2].bin.length >= N, 5000), "slot 2 received all of host's frames");
  check(await p[0].wait(() => p[0].bin.length >= N, 5000), "host received all of slot 2's frames");
  let ordered = true;
  for (let i = 0; i < N; i++) if (p[2].bin[i][0] !== 0 || p[2].bin[i][1] !== (i & 255)) ordered = false;
  check(ordered, "frames in order with source = host");

  // A joiner leaves: others hear it and the roster shrinks; its slot is reusable.
  p[2].ws.close();
  check(await p[0].wait(() => p[0].last("peer_left")?.slot === 2), "host told slot 2 left");
  check(await p[0].wait(() => p[0].last("peers")?.peers.length === 3), "roster shrinks to 3");
  const again = open(room, "join");
  check(await again.wait(() => again.last("welcome")), "new joiner welcome");
  check(again.last("welcome").slot === 2, "freed slot 2 reused");

  // Host leaves: everyone is closed.
  p[0].ws.close();
  check(await p[1].wait(() => p[1].closed), "joiners closed when host leaves");
  check(p[1].closed?.code === 4001, "close code 4001 host-left");
  for (const c of [p[1], p[3], again]) c.ws.close();
}

// ---- legacy v1 (older game builds): two players, verbatim relay ----
{
  const room = code();
  const host = open(room, "host", 0);
  check(await host.wait(() => host.last("welcome")), "v1 host welcome");
  const join = open(room, "join", 0);
  check(await join.wait(() => join.last("welcome")), "v1 join welcome");
  host.send({ type: "endpoint", public: "1.2.3.4:1000", local: "10.0.0.1:1000" });
  join.send({ type: "endpoint", public: "5.6.7.8:2000", local: "10.0.0.2:2000" });
  check(await host.wait(() => host.last("peer")?.public === "5.6.7.8:2000"), "v1 host gets peer");
  check(await join.wait(() => join.last("peer")?.public === "1.2.3.4:1000"), "v1 join gets peer");
  host.send({ type: "relay" });
  check(await join.wait(() => join.last("relaying")), "v1 relaying");
  host.ws.send(new Uint8Array([5, 6, 7]));
  check(await join.wait(() => join.bin.length >= 1), "v1 frame forwarded");
  check(join.bin[0].length === 3 && join.bin[0][0] === 5, "v1 frame verbatim");
  const third = open(room, "join", 0);
  check(await third.wait(() => third.closed), "v1 third player rejected");
  check(third.last("error")?.reason === "room-full", "v1 room-full");

  // A v2 client can't join a v1 room and vice versa.
  const v2into1 = open(room, "join", 2);
  check(await v2into1.wait(() => v2into1.closed), "v2 joiner refused by v1 room");
  check(/older version/.test(v2into1.last("error")?.reason || ""), "v2->v1 reason is readable");
  const room2 = code();
  const h2 = open(room2, "host", 2);
  await h2.wait(() => h2.last("welcome"));
  const v1into2 = open(room2, "join", 0);
  check(await v1into2.wait(() => v1into2.closed), "v1 joiner refused by v2 room");
  check(/newer version/.test(v1into2.last("error")?.reason || ""), "v1->v2 reason is readable");
  for (const c of [host, join, h2]) c.ws.close();
}

// ---- hardening: two simultaneous hosts, non-object JSON ----
{
  const room = code();
  const h1 = open(room, "host", 2);
  const h2 = open(room, "host", 2);
  await sleep(500);
  const winners = [h1, h2].filter((h) => h.last("welcome"));
  check(winners.length === 1, "only one of two simultaneous hosts gets slot 0");
  const loser = [h1, h2].find((h) => !h.last("welcome"));
  check(loser?.last("error")?.reason === "room-in-use", "losing host told room-in-use");
  const host = winners[0];
  host.ws.send("null");
  host.ws.send("42");
  host.send({ type: "endpoint", public: "1.2.3.4:1", local: "10.0.0.1:1" });
  check(await host.wait(() => host.last("peers")), "host survives non-object JSON");
  const j = open(room, "join", 2);
  check(await j.wait(() => j.last("welcome")), "joiner still welcomed");
  for (const c of [h1, h2, j]) c.ws.close();
}

console.log(fails ? `${fails} FAILED` : "ALL OK");
process.exit(fails ? 1 : 0);
