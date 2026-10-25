// Node test: "Ask to join" friend message (type "ask" -> kind "ask" delivered to the host). Starts its own LOCAL wrangler dev
// (isolated registry, short --persist-to under C:\rhq\<port>). Usage: node test_ask.mjs   (ASK_TEST_PORT, default 10600)
import { randomBytes } from "node:crypto";
import { startServer, sleep, makeChecker } from "./test_v2_lib.mjs";

const PORT = Number(process.env.ASK_TEST_PORT) || 10600;
const { st, check } = makeChecker();
const srv = await startServer({ port: PORT });
const BASE = srv.BASE.replace("http", "ws");
const UIDCHARS = "abcdefghijklmnopqrstuvwxyz234567";
const newUid = () => [...randomBytes(26)].map((b) => UIDCHARS[b % 32]).join("");

async function client(name) {
  const uid = newUid(), secret = randomBytes(16).toString("hex");
  const ws = new WebSocket(`${BASE}/friends?uid=${uid}`);
  const c = { ws, msgs: [], uid, secret };
  ws.onmessage = (e) => c.msgs.push(JSON.parse(e.data));
  c.send = (o) => ws.send(JSON.stringify(o));
  c.find = (type, pred = () => true) => c.msgs.find((m) => m.type === type && pred(m));
  c.wait = async (fn, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(25); } return false; };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  c.send({ type: "hello", secret, name, test: true });
  await c.wait(() => c.find("welcome"));
  c.code = c.find("welcome").code;
  return c;
}
try {
  const A = await client("AskA"), B = await client("AskB"), C = await client("AskC");
  A.send({ type: "add_friend", code: B.code });
  await B.wait(() => B.find("request"));
  B.send({ type: "accept", uid: A.uid });
  await A.wait(() => A.find("friend_added"));
  await sleep(150);

  A.send({ type: "ask", to: B.uid, game_id: "smash64", game_title: "Smash Classic", system: "n64" });
  check(await A.wait(() => A.find("ask_result", (m) => m.ok === true)), "asker gets ask_result ok");
  check(await B.wait(() => B.find("msg", (m) => m.msg?.kind === "ask")), "host receives the ask");
  const m = B.find("msg", (x) => x.msg?.kind === "ask").msg;
  check(m.from === A.uid && m.ask.game_title === "Smash Classic" && m.ask.game_id === "smash64", "ask carries asker + game");

  A.send({ type: "ask", to: B.uid, game_id: "smash64", game_title: "Smash Classic" });
  check(await A.wait(() => A.find("ask_result", (r) => r.ok === false && r.reason === "rate-limited")), "second ask to the same host within 60s is rate limited");
  await sleep(200);
  check(B.msgs.filter((x) => x.msg?.kind === "ask").length === 1, "host got exactly one ask");

  A.send({ type: "ask", to: C.uid, game_id: "x" });
  check(await A.wait(() => A.find("error", (e) => e.reason === "not-friends")), "ask to a non-friend is refused");
  A.send({ type: "ask", to: A.uid });
  check(await A.wait(() => A.find("error", (e) => e.reason === "bad-request")), "ask to self is refused");

  // asks to many different friends are capped overall (10/min): befriend C..., here just assert the per-target path held.
  for (const c of [A, B, C]) { try { c.ws.close(); } catch { /* */ } }
} finally {
  srv.stop();
}
console.log(st.fails ? `FAILED (${st.fails})` : "all ok");
process.exit(st.fails ? 1 : 0);
