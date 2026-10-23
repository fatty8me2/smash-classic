// Node test for host migration in the /ws room (protocol v2, hm=1) and the cases where it must not happen.
// Run: npx wrangler dev --port 8799   (in another shell), then: node test_hostmig.mjs ws://127.0.0.1:8799
// Usage: node test_hostmig.mjs [ws://127.0.0.1:8799] [--no-hibernate]   (against `wrangler dev`)
const BASE = process.argv.find((a) => /^wss?:\/\//.test(a)) || "ws://127.0.0.1:8799";
const SKIP_HIBERNATE = process.argv.includes("--no-hibernate");
let fails = 0;
const check = (c, m) => { if (!c) { fails++; console.log("FAIL:", m); } else console.log("ok:  ", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function open(room, role, { v = 2, hm = true } = {}) {
  const ws = new WebSocket(`${BASE}/ws?room=${room}&role=${role}${v ? `&v=${v}` : ""}${hm ? "&hm=1" : ""}`);
  ws.binaryType = "arraybuffer";
  const c = { ws, text: [], bin: [], closed: null };
  ws.onmessage = (e) => {
    if (typeof e.data === "string") c.text.push(JSON.parse(e.data));
    else c.bin.push(new Uint8Array(e.data));
  };
  ws.onclose = (e) => { c.closed = { code: e.code, reason: e.reason }; };
  c.send = (o) => ws.send(JSON.stringify(o));
  c.last = (type) => [...c.text].reverse().find((m) => m.type === type);
  c.all = (type) => c.text.filter((m) => m.type === type);
  c.wait = async (fn, ms = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(20); }
    return false;
  };
  c.slot = () => c.last("welcome")?.slot;
  c.roster = () => c.last("peers")?.peers.map((p) => p.slot).sort().join(",");
  return c;
}
const code = () => {
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = ""; for (let i = 0; i < 6; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
};
async function room(n, opts) {
  const id = code();
  const p = [open(id, "host", opts)];
  await p[0].wait(() => p[0].last("welcome"));
  for (let i = 1; i < n; i++) {
    p.push(open(id, "join", opts));
    await p[i].wait(() => p[i].last("welcome"));
  }
  for (let i = 0; i < n; i++) p[i].send({ type: "endpoint", public: `1.1.1.${i}:100${i}`, local: `10.0.0.${i}:100${i}` });
  await p[n - 1].wait(() => p[n - 1].last("peers")?.peers.length === n && p[n - 1].last("peers").peers.every((x) => x.public !== "-"));
  return { id, p };
}

// ---- basic migration, relay, join into the freed slot, second migration ----
{
  const { id, p } = await room(3);
  check(p[0].last("welcome").host === 0 && p[1].last("welcome").host === 0, "welcome carries host = 0");
  check(p[2].last("peers").host === 0, "roster carries host = 0");
  p[0].ws.close();
  check(await p[1].wait(() => p[1].last("host")), "slot 1 told about the new host");
  check(await p[2].wait(() => p[2].last("host")), "slot 2 told about the new host");
  check(p[1].last("host").slot === 1 && p[1].last("host").prev === 0, "lowest remaining slot (1) promoted, prev = 0");
  check(p[1].last("peer_left")?.slot === 0 && p[2].last("peer_left")?.slot === 0, "peer_left for the old host still sent");
  check(await p[2].wait(() => p[2].last("peers")?.host === 1 && p[2].roster() === "1,2"), "roster: host 1, slots 1,2");
  check(p[1].closed === null && p[2].closed === null, "survivors stay connected");

  p[2].send({ type: "relay" });
  check(await p[1].wait(() => p[1].last("relaying")), "relay can still be enabled");
  p[1].ws.send(new Uint8Array([1 << 2, 0xAB]));
  check(await p[2].wait(() => p[2].bin.length === 1 && p[2].bin[0][0] === 1 && p[2].bin[0][1] === 0xAB), "relay between survivors works");
  p[1].ws.send(new Uint8Array([1 << 0, 0xCD]));   // to the vanished slot 0
  await sleep(200);
  check(p[2].bin.length === 1, "frame to the empty slot is dropped");

  // A new player joins with the same code and takes the free slot 0 (but is not the host).
  const j = open(id, "join");
  check(await j.wait(() => j.last("welcome")), "new joiner accepted with the old code");
  check(j.slot() === 0 && j.last("welcome").host === 1, "joiner fills slot 0; host stays 1");
  j.send({ type: "endpoint", public: "9.9.9.9:999", local: "10.0.0.9:999" });
  check(await p[1].wait(() => p[1].roster() === "0,1,2" && p[1].last("peers").host === 1), "everyone sees roster 0,1,2 with host 1");
  p[1].ws.send(new Uint8Array([1 << 0, 0x11]));
  check(await j.wait(() => j.bin.length === 1 && j.bin[0][0] === 1), "relay reaches the joiner in slot 0 (relay flag persisted)");

  // A game that doesn't know migration can't join a migrated room.
  const old = open(id, "join", { hm: false });
  check(await old.wait(() => old.closed), "non-hm joiner refused after a migration");
  check(/changed hosts/.test(old.last("error")?.reason || ""), "with a readable reason");

  // The new host leaves too: the lowest remaining slot (0, the late joiner) leads.
  p[1].ws.close();
  check(await j.wait(() => j.last("host")?.slot === 0 && j.last("host").prev === 1), "second migration: slot 0 promoted");
  check(await p[2].wait(() => p[2].last("peers")?.host === 0 && p[2].roster() === "0,2"), "roster: host 0, slots 0,2");

  // Hibernation: leave the room idle so the Durable Object can be evicted, then migrate again.
  if (!SKIP_HIBERNATE) {
    await sleep(15000);
    j.ws.close();
    check(await p[2].wait(() => p[2].last("host")?.slot === 2 && p[2].last("host").prev === 0, 5000), "after idle (hibernation) the next host is promoted from stored state");
  }

  // Last player leaves: the room is gone.
  if (SKIP_HIBERNATE) j.ws.close();
  await sleep(100);
  p[2].ws.close();
  await sleep(300);
  const late = open(id, "join");
  check(await late.wait(() => late.closed), "joining an empty room is refused");
  check(late.last("error")?.reason === "no-such-room", "no-such-room");
  const again = open(id, "host");
  check(await again.wait(() => again.last("welcome")?.slot === 0 && again.last("welcome").host === 0), "the code can be hosted afresh once empty");
  again.ws.close();
}

// ---- host leaves a room with a game that can't migrate: closed as before ----
{
  const id = code();
  const h = open(id, "host");
  await h.wait(() => h.last("welcome"));
  const oldJoin = open(id, "join", { hm: false });
  check(await oldJoin.wait(() => oldJoin.last("welcome")), "old-style joiner accepted while the original host leads");
  const newJoin = open(id, "join");
  await newJoin.wait(() => newJoin.last("welcome"));
  for (const c of [h, oldJoin, newJoin]) c.send({ type: "endpoint", public: "1.1.1.1:1", local: "10.0.0.1:1" });   // (workerd only delivers the 4001 close to sockets that have spoken)
  await sleep(200);
  h.ws.close();
  check(await oldJoin.wait(() => oldJoin.closed), "room with a non-hm member closes when the host leaves");
  check(await newJoin.wait(() => newJoin.closed) && oldJoin.closed.code === 4001 && newJoin.closed.code === 4001, "everyone closed with 4001 host-left");
  check(oldJoin.last("peer_left")?.slot === 0, "peer_left sent first");
}

// ---- a non-migratable host leave must not leave a joinable ghost room (hostSlot null window) ----
for (let round = 0; round < 5; round++) {
  const id = code();
  const h = open(id, "host");
  await h.wait(() => h.last("welcome"));
  const oldJoin = open(id, "join", { hm: false });
  await oldJoin.wait(() => oldJoin.last("welcome"));
  oldJoin.send({ type: "endpoint", public: "1.1.1.2:1", local: "10.0.0.2:1" });
  h.send({ type: "endpoint", public: "1.1.1.1:1", local: "10.0.0.1:1" });
  await sleep(100);
  h.ws.close();
  const racer = open(id, "join");          // arrives while the room is closing
  await sleep(700);
  check(racer.last("welcome")?.host !== null, `round ${round}: no welcome with host null`);
  check(racer.closed !== null, `round ${round}: the joiner of a closing room does not stay in it`);
  const late = open(id, "join");
  check(await late.wait(() => late.closed) && late.last("error")?.reason === "no-such-room", `round ${round}: room is gone afterwards`);
}

// ---- legacy v1 room: unchanged ----
{
  const id = code();
  const h = open(id, "host", { v: 0, hm: false });
  await h.wait(() => h.last("welcome"));
  const j = open(id, "join", { v: 0, hm: false });
  await j.wait(() => j.last("welcome"));
  check(h.last("welcome").slot === undefined && j.last("welcome").host === undefined, "v1 welcome has no slot/host");
  h.send({ type: "endpoint", public: "1.1.1.1:1", local: "10.0.0.1:1" });
  j.send({ type: "endpoint", public: "1.1.1.2:1", local: "10.0.0.2:1" });
  await sleep(200);
  h.ws.close();
  check(await j.wait(() => j.closed), "v1 room closes when the host leaves");
  check(j.closed.code === 4001, "with 4001 host-left");
  await sleep(200);
  const late = open(id, "join", { v: 0, hm: false });
  check(await late.wait(() => late.closed) && late.last("error")?.reason === "no-such-room", "v1 room is gone");
}

// ---- races: two near-simultaneous closes; a join during promotion ----
for (let round = 0; round < 5; round++) {
  const { id, p } = await room(4);
  p[0].ws.close();
  p[1].ws.close();
  const joiner = open(id, "join");
  await sleep(600);
  const live = [p[2], p[3], joiner].filter((c) => !c.closed && c.last("welcome"));
  const hosts = new Set(live.map((c) => c.last("peers")?.host));
  const slots = live.map((c) => c.slot());
  check(hosts.size === 1, `round ${round}: one host agreed by all survivors (${[...hosts]}) slots ${slots}`);
  const h = [...hosts][0];
  check(slots.includes(h), `round ${round}: the host is a member of the room`);
  check(new Set(slots).size === slots.length, `round ${round}: no duplicate slots`);
  // the "host" messages never name two different hosts at the end
  const lastHosts = new Set(live.map((c) => c.last("host")?.slot).filter((x) => x !== undefined));
  check(lastHosts.size <= 1 && (lastHosts.size === 0 || [...lastHosts][0] === h), `round ${round}: last host message matches the roster`);
  for (const c of [p[2], p[3], joiner]) c.ws.close();
  await sleep(100);
}

// ---- host and every other player leave at once ----
{
  const { id, p } = await room(3);
  for (const c of p) c.ws.close();
  await sleep(400);
  const late = open(id, "join");
  check(await late.wait(() => late.closed) && late.last("error")?.reason === "no-such-room", "everyone gone at once: room closed");
}

console.log(fails === 0 ? "\nALL PASSED" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
