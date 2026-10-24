// Node test: invite_result per-target outcomes, accept of a vanished request (error + request_update), welcome presence lease.
// Run: npx wrangler dev --port 8731   (in BattleShip\server\cloudflare, local only), then:
//   node test_friends_fixes.mjs [http://127.0.0.1:8731]
// Throwaway accounts only; refuses anything but a 127.0.0.1/localhost server.
import { randomBytes } from "node:crypto";

const HTTP = process.argv[2] || "http://127.0.0.1:8731";
if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(HTTP)) { console.log("refusing non-local server"); process.exit(2); }
const BASE = HTTP.replace(/^http/, "ws");
let fails = 0;
const check = (c, m) => { if (!c) { fails++; console.log("FAIL:", m); } else console.log("ok:  ", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UIDCHARS = "abcdefghijklmnopqrstuvwxyz234567";
const newUid = () => [...randomBytes(26)].map((b) => UIDCHARS[b % 32]).join("");

async function client(uid, name, secret = randomBytes(16).toString("hex")) {
  const ws = new WebSocket(`${BASE}/friends?uid=${uid}`);
  const c = { ws, msgs: [], uid };
  ws.onmessage = (e) => c.msgs.push(JSON.parse(e.data));
  c.send = (o) => ws.send(JSON.stringify(o));
  c.find = (type, pred = () => true) => c.msgs.find((m) => m.type === type && pred(m));
  c.wait = async (fn, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(25); } return false; };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  c.send({ type: "hello", secret, name });
  c.secret = secret;
  await c.wait(() => c.find("welcome"));
  c.code = c.find("welcome").code;
  return c;
}
async function befriend(a, b) {
  a.send({ type: "add_friend", code: b.code });
  await b.wait(() => b.find("request"));
  b.send({ type: "accept", uid: a.uid });
  await a.wait(() => a.find("friend_added"));
  await sleep(150);
}

const A = await client(newUid(), "FixA");
const B = await client(newUid(), "FixB");
const C = await client(newUid(), "FixC");   // not a friend of A
await befriend(A, B);

// invite_result: B reached (ok), C not a friend (reported, not ok)
A.send({ type: "invite", to: [B.uid, C.uid], invite: { lobby_code: "ABCDEF", game_id: "mk64", game_title: "Mario Kart 64", system: "n64" } });
check(await A.wait(() => A.find("invite_result")), "A gets invite_result");
const ir = A.find("invite_result");
check(ir.results.some((r) => r.uid === B.uid && r.ok === true), "friend B reported ok");
check(ir.results.some((r) => r.uid === C.uid && r.ok === false && r.reason === "not-friends"), "non-friend C reported not-friends");
check(await B.wait(() => B.find("msg", (m) => m.msg?.kind === "invite")), "B received the invite");

// accept of a vanished request: C asks A, C cancels while A's row is stale -> simulate by C cancel after A sees it, then A accepts
C.send({ type: "add_friend", code: A.code });
await A.wait(() => A.find("request", (m) => m.dir === "in"));
C.send({ type: "cancel", uid: A.uid });
await A.wait(() => A.find("request_update", (m) => m.result === "cancelled"));
A.msgs.length = 0;
A.send({ type: "accept", uid: C.uid });
check(await A.wait(() => A.find("error", (m) => m.detail === "no-such-request")), "accept of a vanished request returns an error");

// presence lease: B closes without a clean offline? Normal close sets offline; just verify welcome friends carry a status object.
const A2 = await client(A.uid, "FixA", A.secret);
const w = A2.find("welcome");
check(w.friends.some((f) => f.uid === B.uid && f.status && typeof f.status.state === "string"), "welcome lists friend with status");
for (const c of [A, A2, B, C]) { try { c.ws.close(); } catch {} }
console.log(fails ? `FAILED (${fails})` : "all ok");
process.exit(fails ? 1 : 0);
