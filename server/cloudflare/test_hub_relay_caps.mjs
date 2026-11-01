// /hub (RetroHub rooms) relay caps and cost guards (NC-H5 / SV-F1): per-room frame bucket, per-socket text bucket, per-address
// socket and room limits, relay_denied when a frame is not relayed, daily-budget gates for new relay sessions, and idempotent
// storage writes (the launch replay, the /ws relay flag). Starts its own LOCAL wrangler dev servers (isolated registry, short
// --persist-to under C:\rhq\<port>). Usage: node test_hub_relay_caps.mjs   (RELAY_CAPS_PORT and RELAY_CAPS_PORT2)
import { startServer, sleep, makeChecker } from "./test_v2_lib.mjs";
import {
  SocketLimiter, HUB_ROOMS_PER_IP_PER_MIN, HUB_SOCKETS_PER_IP_PER_MIN, TEXT_MSGS_PER_SEC, TEXT_BURST, TEXT_ABUSE_MS,
  RELAY_BYTES_PER_SEC, RELAY_BURST_BYTES, RELAY_ABUSE_MS, LAUNCH_WRITES_PER_HOUR, IDENT_TRIES_PER_SOCKET,
} from "./src/limits.js";
import { RELAY_ROOM_MSGS_PER_SEC } from "./src/reqbudget_core.js";

const { st, check } = makeChecker();
const P1 = Number(process.env.RELAY_CAPS_PORT) || 10710, P2 = Number(process.env.RELAY_CAPS_PORT2) || 10711;
const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const code = () => Array.from({ length: 6 }, () => A[Math.floor(Math.random() * A.length)]).join("");
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const rnd = (n) => Array.from({ length: n }, () => B32[Math.floor(Math.random() * 32)]).join("");

// ---------------------------------------------------------------------------------------------------------------- pure
{
  check(RELAY_ROOM_MSGS_PER_SEC === 400, "a room's relay is capped at 400 frames/s (burst 2x), like /ws");
  let t = 0;
  const lim = new SocketLimiter(TEXT_MSGS_PER_SEC, TEXT_BURST, TEXT_ABUSE_MS, () => t);
  const ws = {}, other = {};
  let passed = 0;
  for (let i = 0; i < TEXT_BURST; i++) if (lim.check(ws) === 0) passed++;
  check(passed === TEXT_BURST, `a burst of ${TEXT_BURST} text frames passes`);
  check(lim.check(ws) === 1, "the next frame is dropped, not a close");
  check(lim.check(other) === 0, "another socket has its own budget");
  t += 1000;
  let p2 = 0; while (lim.check(ws) === 0) p2++;
  check(p2 === TEXT_MSGS_PER_SEC, `${TEXT_MSGS_PER_SEC} frames a second refill`);
  // A flood of 1000 frames a second: dropped throughout, closed once the drop streak reaches TEXT_ABUSE_MS.
  t = 100000;
  let firstClose = 0, firstDrop = 0;
  for (let i = 0; i < 20000 && !firstClose; i++) {
    t += 1;
    const r = lim.check(ws);
    if (r >= 1 && !firstDrop) firstDrop = t;
    if (r === 2) firstClose = t - firstDrop;
  }
  check(firstClose >= TEXT_ABUSE_MS && firstClose <= TEXT_ABUSE_MS + 100, `a flood is closed after ~${TEXT_ABUSE_MS} ms of drops (${firstClose} ms)`);
  // A quiet gap ends the streak: a client that bursts, pauses, bursts again is never closed.
  const lim2 = new SocketLimiter(TEXT_MSGS_PER_SEC, TEXT_BURST, TEXT_ABUSE_MS, () => t);
  const w2 = {};
  let closed = false;
  t = 500000;
  for (let round = 0; round < 6; round++) {
    for (let i = 0; i < 2500; i++) { t += 1; if (lim2.check(w2) === 2) closed = true; }   // 2.5 s over budget
    t += 1500;                                                                              // then quiet
  }
  check(!closed, "bursts over budget separated by quiet gaps never close the socket");
  // Real traffic never comes near the relay budget: a 4-player match is ~270 frames/s of ~100 bytes.
  const lim3 = new SocketLimiter(RELAY_BYTES_PER_SEC, RELAY_BURST_BYTES, RELAY_ABUSE_MS, () => t);
  const w3 = {};
  let any = false;
  for (let i = 0; i < 60 * 60; i++) { t += 1000 / 60; if (lim3.check(w3, 1200) !== 0) any = true; }
  check(!any, "60 frames/s of full-size 1200-byte frames fits the per-socket relay budget");
  check(LAUNCH_WRITES_PER_HOUR >= 10 && LAUNCH_WRITES_PER_HOUR <= 60 && IDENT_TRIES_PER_SOCKET >= 2 && IDENT_TRIES_PER_SOCKET <= 5, "launch-write and ident-attempt limits are small numbers");
}

// ----------------------------------------------------------------------------------------------------------------- live
function hub(base, room, role, { ip, slot, caps = "hostmig,reasons", name = "t", extra = "" } = {}) {
  const q = `room=${room}&role=${role}&name=${name}${caps ? `&caps=${caps}` : ""}${slot !== undefined ? `&slot=${slot}` : ""}${extra}`;
  const ws = new WebSocket(`${base}/hub?${q}`, ip ? { headers: { "CF-Connecting-IP": ip } } : undefined);
  ws.binaryType = "arraybuffer";
  const c = { ws, text: [], bin: [], closed: null };
  ws.onmessage = (e) => { if (typeof e.data === "string") c.text.push(JSON.parse(e.data)); else c.bin.push(new Uint8Array(e.data)); };
  ws.onclose = (e) => { c.closed = { code: e.code, reason: e.reason }; };
  c.send = (o) => { const d = typeof o === "string" || o instanceof Uint8Array ? o : JSON.stringify(o); if (ws.readyState === 0) ws.addEventListener("open", () => ws.send(d), { once: true }); else ws.send(d); };
  c.last = (type) => [...c.text].reverse().find((m) => m.type === type);
  c.wait = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(20); } return false; };
  return c;
}
async function pair(base, room) {
  const h = hub(base, room, "host"); await h.wait(() => h.last("welcome"));
  const g = hub(base, room, "join", { slot: 1 }); await g.wait(() => g.last("welcome"));
  return { h, g };
}
function smash(base, room, role) {
  const ws = new WebSocket(`${base}/ws?room=${room}&role=${role}&v=2&hm=1`);
  ws.binaryType = "arraybuffer";
  const c = { ws, text: [], bin: [] };
  ws.onmessage = (e) => { if (typeof e.data === "string") c.text.push(JSON.parse(e.data)); else c.bin.push(new Uint8Array(e.data)); };
  c.send = (o) => { const d = JSON.stringify(o); if (ws.readyState === 0) ws.addEventListener("open", () => ws.send(d), { once: true }); else ws.send(d); };
  c.last = (type) => [...c.text].reverse().find((m) => m.type === type);
  c.wait = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(20); } return false; };
  return c;
}

// ================================================================= A. default budget: caps, limits, idempotent writes
const s1 = await startServer({ port: P1, vars: { TEST_BUDGET: "1" } });
const W1 = s1.BASE.replace("http", "ws");
const budget1 = async () => (await fetch(`${s1.BASE}/__test/budget`)).json();
const open = [];
try {
  // A1. Per-room frame cap: 1500 frames in a burst, the room's bucket (800 burst) passes about that many and says why once.
  {
    const { h, g } = await pair(W1, code() + "-1");
    const N = 4000;
    for (let i = 0; i < N; i++) h.ws.send(new Uint8Array([1, i & 255, i >> 8]));
    await sleep(2000);
    const got = g.bin.length;
    check(got >= 700 && got <= 2400, `room frame bucket: ${got} of ${N} burst frames relayed (the 800 burst plus 400/s while they arrive)`);
    const denied = h.text.filter((m) => m.type === "relay_denied");
    check(denied.length >= 1 && denied.length <= 2 && denied[0].reason === "rate-limited" && typeof denied[0].detail === "string",
      `the sender is told once why (relay_denied rate-limited, ${denied.length} notice(s))`);
    check(!h.closed && !g.closed, "a short over-budget burst never closes a socket");
    await sleep(2500);   // the bucket refills (400/s)
    const before = g.bin.length;
    for (let i = 0; i < 60; i++) h.ws.send(new Uint8Array([1, 7, i]));
    check(await g.wait(() => g.bin.length >= before + 60, 4000), "after a pause the relay carries frames again");
    open.push(h.ws, g.ws);
  }

  // A2. Per-address limits (an injected CF-Connecting-IP; loopback is never limited).
  {
    const X = "203.0.113.50";
    let ok = 0, limited = 0, other = 0;
    for (let i = 0; i < HUB_ROOMS_PER_IP_PER_MIN + 1; i++) {
      const c = hub(W1, code(), "host", { ip: X });
      await c.wait(() => c.last("welcome") || c.closed);
      if (c.last("welcome")) ok++; else if (c.last("error") && c.last("error").reason === "rate-limited" && c.closed && c.closed.code === 4000) limited++; else other++;
      open.push(c.ws);
    }
    check(ok === HUB_ROOMS_PER_IP_PER_MIN && limited === 1 && other === 0, `one address may open ${HUB_ROOMS_PER_IP_PER_MIN} rooms a minute, the next is refused as rate-limited (${ok} ok, ${limited} refused)`);

    const Y = "203.0.113.51";
    let nsr = 0, lim = 0, odd = 0;
    const total = HUB_SOCKETS_PER_IP_PER_MIN + 5;
    for (let b = 0; b < total; b += 25) {
      const batch = [];
      for (let i = b; i < Math.min(total, b + 25); i++) batch.push(hub(W1, code(), "join", { ip: Y }));
      await Promise.all(batch.map((c) => c.wait(() => c.closed)));
      for (const c of batch) { const r = c.last("error") && c.last("error").reason; if (r === "no-such-room") nsr++; else if (r === "rate-limited") lim++; else odd++; }
    }
    check(nsr === HUB_SOCKETS_PER_IP_PER_MIN && lim === 5 && odd === 0, `one address may open ${HUB_SOCKETS_PER_IP_PER_MIN} sockets a minute of any kind (${nsr} served, ${lim} refused)`);

    const Z = "2001:db8:9:9::1", Z2 = "2001:db8:9:9:ffff::2";
    const hz = [];
    for (let i = 0; i < HUB_ROOMS_PER_IP_PER_MIN; i++) { const c = hub(W1, code(), "host", { ip: i % 2 ? Z : Z2 }); await c.wait(() => c.last("welcome") || c.closed); hz.push(c); open.push(c.ws); }
    const extra = hub(W1, code(), "host", { ip: Z });
    await extra.wait(() => extra.closed);
    check(extra.last("error") && extra.last("error").reason === "rate-limited", "two IPv6 addresses of one /64 share the limit");

    let loopOk = 0;
    for (let i = 0; i < HUB_ROOMS_PER_IP_PER_MIN + 10; i++) { const c = hub(W1, code(), "host"); await c.wait(() => c.last("welcome") || c.closed); if (c.last("welcome")) loopOk++; open.push(c.ws); }
    check(loopOk === HUB_ROOMS_PER_IP_PER_MIN + 10, `loopback (a local wrangler) is never limited (${loopOk} rooms)`);
  }

  // A3. Text frames: a burst passes whole, a sustained flood is dropped and the socket closed (1008); the room carries on.
  {
    const { h, g } = await pair(W1, code());
    for (let i = 0; i < 500; i++) h.send({ type: "msg", body: { kind: "chat", n: i } });   // e.g. a library of 7000 games announced in 3000-byte parts
    check(await g.wait(() => g.text.filter((m) => m.type === "msg" && m.body.kind === "chat").length === 500, 8000), "a burst of 500 lobby messages (a huge game-library announcement) is delivered whole");
    const t0 = Date.now();
    while (!h.closed && Date.now() - t0 < 12000) {
      for (let i = 0; i < 20; i++) h.ws.send(JSON.stringify({ type: "msg", body: { kind: "spam", n: i } }));
      await sleep(10);
    }
    const dur = Date.now() - t0;
    check(!!h.closed && h.closed.code === 1008 && dur >= TEXT_ABUSE_MS - 500, `a sustained flood is cut with 1008 after ~${TEXT_ABUSE_MS / 1000} s (${h.closed ? h.closed.code : "still open"} after ${dur} ms)`);
    const spam = g.text.filter((m) => m.type === "msg" && m.body.kind === "spam").length;
    check(spam < TEXT_BURST + TEXT_MSGS_PER_SEC * 8, `the flood reached the other member only up to the budget (${spam} frames)`);
    check(!g.closed, "the other member is unaffected");
    open.push(g.ws);
  }

  // A4. Storage rows: the /ws relay flag and the hub's launch replay are written once, not per message.
  {
    const room = code();
    const h = smash(W1, room, "host"); await h.wait(() => h.last("welcome"));
    const g = smash(W1, room, "join"); await g.wait(() => g.last("welcome"));
    const b0 = await budget1();
    for (let i = 0; i < 60; i++) { h.send({ type: "relay" }); await sleep(66); }   // 15 a second, inside the text budget
    const b1 = await budget1();
    check(await g.wait(() => g.last("relaying")), "relay turns on");
    h.ws.send(new Uint8Array([2, 1, 2, 3]));
    check(await g.wait(() => g.bin.length === 1 && g.bin[0][0] === 0), "...and frames are relayed");
    const d = b1.rows - b0.rows;
    check(d <= 8, `60 relay requests wrote ${d} rows (was one per request)`);
    open.push(h.ws, g.ws);
  }
  {
    const room = code();
    const { h, g } = await pair(W1, room);
    const b0 = await budget1();
    for (let i = 0; i < 60; i++) { h.send({ type: "msg", body: { kind: "launch", game: "ssb64", dropin: 2 } }); await sleep(66); }
    const b1 = await budget1();
    const same = b1.rows - b0.rows;
    check(same <= 8, `60 identical launch messages wrote ${same} rows (was one per message)`);
    for (let i = 0; i < 40; i++) { h.send({ type: "msg", body: { kind: "launch", game: "g" + i, dropin: 2 } }); await sleep(66); }
    const b2 = await budget1();
    const distinct = b2.rows - b1.rows;
    check(distinct <= LAUNCH_WRITES_PER_HOUR + 8, `40 different launches wrote ${distinct} rows (at most ${LAUNCH_WRITES_PER_HOUR} an hour)`);
    const w = hub(W1, room, "watch");
    await w.wait(() => w.last("welcome"));
    check(await w.wait(() => w.text.some((m) => m.type === "msg" && m.body && m.body.game === "g39" && m.body.watch === true)), "a late spectator still gets the LATEST launch replayed");
    open.push(h.ws, g.ws, w.ws);
  }

  // A5. ident: a seat cannot make the server look up account after account; the room keeps working.
  {
    const { h, g } = await pair(W1, code());
    for (let i = 0; i < IDENT_TRIES_PER_SOCKET + 4; i++) h.send({ type: "ident", uid: rnd(26), secret: rnd(40) });
    await sleep(500);
    h.send({ type: "msg", body: { kind: "chat", text: "still alive" } });
    check(await g.wait(() => g.text.some((m) => m.type === "msg" && m.body && m.body.text === "still alive")), "idents with unknown accounts are ignored and the room carries on");
    open.push(h.ws, g.ws);
  }
} finally {
  for (const ws of open) try { ws.close(); } catch { /* closed */ }
  s1.stop();
}
await sleep(1000);

// ================================================================= B. daily budget gates (DAILY_REQ_CAP 400: 50% = 200 units)
const s2 = await startServer({ port: P2, vars: { DAILY_REQ_CAP: "400" } });
const W2 = s2.BASE.replace("http", "ws");
const open2 = [];
const burn = async (n) => { await Promise.all(Array.from({ length: n }, () => fetch(s2.BASE + "/health").then((r) => r.text()))); };
const frame = (c, tag) => c.ws.send(new Uint8Array([1, tag, 0]));
try {
  const r1 = await pair(W2, code() + "-1");
  open2.push(r1.h.ws, r1.g.ws);
  frame(r1.h, 1);
  check(await r1.g.wait(() => r1.g.bin.length === 1), "below 50%: a room's first relayed frame goes through (its relay session starts)");
  const probes = [];
  for (let i = 0; i < 10; i++) { const p = await pair(W2, code() + "-" + (i + 2)); probes.push(p); open2.push(p.h.ws, p.g.ws); }
  let denied = null;
  for (let step = 0; step < 10 && !denied; step++) {
    await burn(40);
    const p = probes[step];
    frame(p.h, 9);
    await p.g.wait(() => p.g.bin.length > 0 || p.h.last("relay_denied"), 1500);
    if (p.h.last("relay_denied")) denied = p;
  }
  check(!!denied, "at >= 50% the first frame of a room is refused: the sender gets relay_denied");
  const note = denied && denied.h.last("relay_denied");
  check(note && note.reason === "server-busy" && typeof note.detail === "string" && note.detail.length > 10, `...with reason server-busy and a sentence (${note && note.reason})`);
  check(denied && denied.g.bin.length === 0, "...and nothing was relayed to the other player");
  const before = r1.g.bin.length;
  frame(r1.h, 2);
  check(await r1.g.wait(() => r1.g.bin.length === before + 1, 3000), "a room whose relay session already exists keeps relaying below 90%");
  const nh = hub(W2, code(), "host");
  await nh.wait(() => nh.closed || nh.last("welcome"));
  open2.push(nh.ws);
  let busy = nh.last("error") && nh.last("error").reason === "server-busy";
  if (!busy) {
    await burn(100);
    const nh2 = hub(W2, code(), "host");
    await nh2.wait(() => nh2.closed || nh2.last("welcome"));
    open2.push(nh2.ws);
    busy = nh2.last("error") && nh2.last("error").reason === "server-busy";
  }
  check(!!busy, "at >= 70% a new /hub room is refused with server-busy");
  let stopped = false;
  for (let step = 0; step < 12 && !stopped; step++) {
    await burn(50);
    const n0 = r1.g.bin.length;
    frame(r1.h, 3);
    await r1.g.wait(() => r1.g.bin.length > n0 || r1.h.text.filter((m) => m.type === "relay_denied").length > 0, 1200);
    stopped = r1.g.bin.length === n0 && !!r1.h.last("relay_denied");
  }
  check(stopped, "at >= 90% even a running relay stops, and the sender is told (relay_denied) instead of silence");
} finally {
  for (const ws of open2) try { ws.close(); } catch { /* closed */ }
  s2.stop();
}

console.log(st.fails ? `${st.fails} FAILED` : "ALL PASSED");
process.exit(st.fails ? 1 : 0);
