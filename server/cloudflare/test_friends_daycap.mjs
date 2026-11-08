// Node test: per-account per-DAY caps on direct messages, reactions and invites (server-F8). Caps are lowered with test-only vars.
//   npx wrangler dev --ip 127.0.0.1 --port 8741 --var ALLOW_TEST_FLAG:1 --var REG_APPROVAL_DEFAULT:0 --var TEST_REG:1 --var BUDGET_TEST:1 --var DAYCAP_DAYMS:12000 --var DAYCAP_MSG:5 --var DAYCAP_REACT:3 --var DAYCAP_INVITE:2      (fresh --persist-to dir)
//   node test_friends_daycap.mjs [http://127.0.0.1:8741]
// Throwaway accounts only; refuses anything but a 127.0.0.1/localhost server.
import { randomBytes } from "node:crypto";

const HTTP = process.argv[2] || "http://127.0.0.1:8741";
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
const limitedCount = (c) => c.msgs.filter((m) => m.type === "error" && m.reason === "rate-limited").length;

const A = await client(newUid(), "CapA");
const B = await client(newUid(), "CapB");
await befriend(A, B);

// start right after a (12 s) day boundary so the whole first section falls inside one test day
await sleep(12000 - (Date.now() % 12000) + 50);

// DMs: cap 5 per day. Spaced out of nothing: the per-minute limit (60) is far above, so only the day cap can answer here.
for (let i = 0; i < 5; i++) A.send({ type: "message", to: B.uid, text: "hi " + i });
await sleep(600);
check(limitedCount(A) === 0, "5 DMs (the day cap) all go through");
check(B.msgs.filter((m) => m.type === "msg" && m.msg && m.msg.kind === "text").length === 5, "B received all 5");
A.send({ type: "message", to: B.uid, text: "one too many" });
check(await A.wait(() => limitedCount(A) === 1), "6th DM of the day -> the existing rate-limited error");
const e = A.msgs.find((m) => m.type === "error" && m.reason === "rate-limited");
check(!!e && e.type === "error" && e.reason === "rate-limited" && (e.ref === "message" && e.detail === B.uid), "error uses the normal error shape (type error, reason rate-limited)");
await sleep(300);
check(B.msgs.filter((m) => m.type === "msg" && m.msg && m.msg.kind === "text").length === 5, "the 6th was not delivered");
// the cap is per account: B can still talk
B.send({ type: "message", to: A.uid, text: "reply" });
check(await A.wait(() => A.find("msg", (m) => m.msg && m.msg.text === "reply")), "the other account has its own day count");

// Reactions: cap 3
A.msgs.length = 0;
const target = "t-" + randomBytes(4).toString("hex");
for (let i = 0; i < 3; i++) A.send({ type: "react", to: B.uid, target, emoji: "up", on: i % 2 === 0 });
await sleep(500);
check(limitedCount(A) === 0, "3 reactions (the day cap) go through");
A.send({ type: "react", to: B.uid, target, emoji: "up" });
check(await A.wait(() => limitedCount(A) === 1), "4th reaction of the day -> rate-limited");
// ...and reactions did not use up the invite count
A.msgs.length = 0;
const inv = { lobby_code: "ABCDEF", game_id: "mk64", game_title: "Mario Kart 64", system: "n64" };
A.send({ type: "invite", to: [B.uid], invite: inv });
A.send({ type: "invite", to: [B.uid], invite: inv });
await sleep(500);
check(limitedCount(A) === 0, "2 invites (the day cap) go through");
A.msgs.length = 0;
A.send({ type: "invite", to: [B.uid], invite: inv });
check(await A.wait(() => A.find("invite_result")), "3rd invite still answers with an invite_result");
const ir = A.find("invite_result");
check(ir.results.some((r) => r.uid === B.uid && r.ok === false && r.reason === "rate-limited"), "3rd invite of the day is reported rate-limited for that friend");
check(limitedCount(A) >= 1, "...with the normal rate-limited error too");

// Day rollover: the test "day" is 12 s long; after it ends the counters start again
await sleep(12500);
A.msgs.length = 0;
for (let i = 0; i < 5; i++) A.send({ type: "message", to: B.uid, text: "new day " + i });
await sleep(600);
check(limitedCount(A) === 0, "after the day rolls over, A can send again (5 more DMs)");
A.send({ type: "message", to: B.uid, text: "cap again" });
check(await A.wait(() => limitedCount(A) === 1), "...and the new day has its own cap");

for (const c of [A, B]) c.ws.close();
console.log(fails ? `${fails} FAILED` : "ALL PASSED");
process.exit(fails ? 1 : 0);
