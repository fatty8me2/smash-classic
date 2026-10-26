// Friend game libraries (metadata only). Usage: wrangler dev (local, fresh --persist-to), then: node test_gamelib.mjs ws://127.0.0.1:PORT
// Pure helper tests run without the server too.
import { sanitizeGames, isLibraryFrame, MAX_LIB_ENTRIES } from "./src/gamelib.js";

const base = process.argv.find((a) => /^wss?:\/\//.test(a)) || "";
let fails = 0;
const check = (c, m) => { if (!c) { fails++; console.log("FAIL:", m); } else console.log("ok:  ", m); };
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const rnd = (n) => Array.from({ length: n }, () => B32[Math.floor(Math.random() * 32)]).join("");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- pure ----
{
  const g = sanitizeGames([{ s: "n64", k: "n64:abc", c: "mp1", t: "Mario Party" }, { s: "N64", k: "x", t: "bad system" }, { s: "gba", t: "no key" },
    { s: "gba", k: "gba:1", t: "" }, { s: "n64", k: "n64:abc", t: "dup" }, null, 5, { s: "gb", k: "k".repeat(100), t: "T".repeat(200), c: "c".repeat(60) }]);
  check(g.length === 2, "pure: invalid/duplicate entries dropped");
  check(g[1].k.length === 64 && g[1].t.length === 80 && g[1].c.length === 32, "pure: field lengths clipped");
  const many = Array.from({ length: 3000 }, (_, i) => ({ s: "n64", k: "k" + i, t: "T" + i }));
  check(sanitizeGames(many).length === MAX_LIB_ENTRIES, "pure: capped at 2000");
  check(sanitizeGames("nope").length === 0, "pure: non-array -> empty");
  check(isLibraryFrame('{"type":"library","x":1}') && !isLibraryFrame('{"type":"status"}'), "pure: frame detection");
}

if (!base) { console.log(fails ? `FAILED ${fails}` : "all passed"); process.exit(fails ? 1 : 0); }

async function user(name, extra = {}) {
  const u = { uid: rnd(26), secret: rnd(40), name, msgs: [], extra };
  await connect(u);
  return u;
}
function connect(u) {
  return new Promise((resolve) => {
    u.ws = new WebSocket(`${base}/friends?uid=${u.uid}`);
    u.ws.onopen = () => u.ws.send(JSON.stringify({ type: "hello", secret: u.secret, name: u.name, ...u.extra }));
    u.ws.onmessage = (e) => { const m = JSON.parse(e.data); u.msgs.push(m); if (m.type === "welcome") { u.welcome = m; resolve(); } };
    u.ws.onclose = () => resolve();
  });
}
const send = (u, o) => u.ws.send(JSON.stringify(o));
const last = (u, type, fn = () => true) => [...u.msgs].reverse().find((m) => m.type === type && fn(m));
async function waitFor(fn, ms = 5000) { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(25); } return null; }
async function befriend(a, b) {
  send(a, { type: "add_friend", code: b.welcome.code });
  await waitFor(() => last(b, "request"));
  send(b, { type: "accept", uid: a.uid });
  await waitFor(() => last(a, "friend_added", (m) => m.friend.uid === b.uid));
  await sleep(100);
}
async function ask(u, uid, have = 0) {
  const n = u.msgs.length;
  send(u, { type: "friend_library", uid, have });
  return waitFor(() => u.msgs.slice(n).find((m) => m.type === "friend_library" || m.type === "error"));
}
const games = (n, tag = "g") => Array.from({ length: n }, (_, i) => ({ s: "n64", k: `n64:${tag}${i}`, c: i % 3 ? "" : "mp" + i, t: `Game ${tag}${i}` }));
async function publish(u, share, gs, h = "h1") {
  const n = u.msgs.length;
  send(u, { type: "library", share, h, games: gs });
  return waitFor(() => u.msgs.slice(n).find((m) => m.type === "library_ack" || m.type === "error"));
}

const A = await user("qa-lib-a"), B = await user("qa-lib-b"), S = await user("qa-lib-stranger");
await befriend(A, B);
check(A.welcome.lib && A.welcome.lib.ver === 0 && A.welcome.lib.share === false, "welcome carries own lib {ver:0}");

// publish + friend sees ver in presence
let ack = await publish(A, true, games(10));
check(ack.type === "library_ack" && ack.ver === 1 && ack.share === true && ack.h === "h1", "publish -> ack ver 1");
check(await waitFor(() => last(B, "presence", (m) => m.uid === A.uid && m.lib === 1)), "friend's presence carries lib ver 1");
let r = await ask(B, A.uid, 0);
check(r.type === "friend_library" && r.ver === 1 && r.games.length === 10, "friend fetches 10 games");
check(r.games[0].t === "Game g0" && r.games[0].c === "mp0" && r.games[0].s === "n64", "game fields intact");

// etag
r = await ask(B, A.uid, 1);
check(r.unchanged === true && r.ver === 1 && !r.games, "have===ver -> unchanged");
ack = await publish(A, true, games(10));
check(ack.ver === 1, "identical re-publish does not bump ver");
ack = await publish(A, true, games(11));
check(ack.ver === 2, "changed content bumps ver");
r = await ask(B, A.uid, 1);
check(r.ver === 2 && r.games.length === 11, "stale etag -> full list");
// reconnect: welcome has friend lib ver and own h
await new Promise((res) => { A.ws.onclose = res; A.ws.close(); }); await sleep(150);
A.msgs = []; await connect(A);
check(A.welcome.lib.ver === 2 && A.welcome.lib.h === "h1" && A.welcome.lib.share === true, "welcome lib {ver,h,share} after reconnect");
await sleep(200);
const Bf = (await (async () => { B.msgs = []; await connect(B); return B.welcome; })()).friends.find((f) => f.uid === A.uid);
check(Bf && Bf.lib === 2, "welcome friends[].lib = 2");

// visibility
r = await ask(S, A.uid, 0);
check(r.type === "error" && r.reason === "not-friends", "stranger -> not-friends");

// malformed + cap + oversize
ack = await publish(A, true, [{ s: "BAD", k: "x", t: "y" }, { foo: 1 }, "str", ...games(3, "m")]);
r = await ask(B, A.uid, 0);
check(r.games.length === 3, "malformed entries dropped server-side");
ack = await publish(A, true, games(2500, "c"), "h2");
r = await ask(B, A.uid, 0);
check(r.games.length === 2000, "capped at 2000 entries (" + r.games.length + ")");
const nBefore = A.msgs.length;
send(A, { type: "library", share: true, h: "x", games: games(5000, "zzzzzzzzzzzzzzzzzzzzzzzz") });
await sleep(600);
check(A.ws.readyState === 1, "oversize frame does not kill the socket");
const big = A.msgs.slice(nBefore).find((m) => m.type === "error" && m.detail === "too-large");
check(!!big, "oversize (>300000) library frame refused with too-large");
send(A, { type: "status", status: { state: "online", pad: "x".repeat(9000) } });
check(!!(await waitFor(() => last(A, "error", (m) => m.detail === "too-large"))), "other message types keep the 8 KB limit");

// ask host flag
const nb = B.msgs.length;
send(A, { type: "ask", to: B.uid, game_id: "mp1", game_title: "Mario Party", system: "n64", host: true });
const am = await waitFor(() => B.msgs.slice(nb).find((m) => m.type === "msg" && m.msg.kind === "ask"));
check(am && am.msg.ask.host === true, "ask host:true is forwarded");

// privacy toggle off
ack = await publish(A, false, []);
check(ack.ver === 0 && ack.share === false, "share:false -> ver 0");
check(await waitFor(() => last(B, "presence", (m) => m.uid === A.uid && m.lib === 0)), "friend's presence shows lib 0");
r = await ask(B, A.uid, 0);
check(r.ver === 0 && r.games.length === 0, "nothing served after turning sharing off");
ack = await publish(A, true, games(4, "n"), "h3");
check(ack.ver > 2, "re-enabling issues a new, higher ver");
r = await ask(B, A.uid, 0);
check(r.games.length === 4, "served again after re-enable");

// remove -> no access, no leak
send(B, { type: "remove_friend", uid: A.uid });
await sleep(300);
r = await ask(B, A.uid, 0);
check(r.type === "error" && r.reason === "not-friends" && !r.games, "removed friend: not-friends, no games");
await befriend(A, B);
// block by owner
send(A, { type: "block", uid: B.uid });
await sleep(300);
r = await ask(B, A.uid, 0);
check(r.type === "error" && r.reason === "not-friends", "blocked: no access");

// test-vs-real parity
const R1 = await user("RealPlayerOne"), R2 = await user("RealPlayerTwo"), T1 = await user("qa-parity");
await befriend(R1, R2);
await befriend(R1, T1);
await publish(R1, true, games(3, "r"));
r = await ask(R2, R1.uid, 0);
check(r.games && r.games.length === 3, "real friend sees real library");
r = await ask(T1, R1.uid, 0);
check(r.ver === 0 && r.games.length === 0, "test account does not see a real account's library");
await publish(T1, true, games(2, "t"));
r = await ask(R1, T1.uid, 0);
check(r.ver === 0 && r.games.length === 0, "real account does not see a test account's library");

// rate limits
const L = await user("qa-lib-rl");
let limited = false;
for (let i = 0; i < 14 && !limited; i++) { const a = await publish(L, true, games(i + 1, "rl")); if (a.type === "error" && a.reason === "rate-limited") limited = true; }
check(limited, "library publishes are rate limited");
const F1 = await user("qa-flib-1"), F2 = await user("qa-flib-2");
await befriend(F1, F2);
let fl = false;
for (let i = 0; i < 64 && !fl; i++) { const a = await ask(F1, F2.uid, 0); if (a.type === "error" && a.reason === "rate-limited") fl = true; }
check(fl, "friend_library fetches are rate limited");

for (const u of [A, B, S, R1, R2, T1, L, F1, F2]) try { u.ws.close(); } catch { /* */ }
console.log(fails ? `FAILED ${fails}` : "all passed");
process.exit(fails ? 1 : 0);
