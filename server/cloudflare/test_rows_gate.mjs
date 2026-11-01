// REQ_BUDGET rows-written axis, end to end (SV-F3): Durable Object storage writes count against a daily cap with the same
// 50/70/90% gates as the request units. Needs a server started with --var DAILY_ROWS_CAP:80 (run_all_tests.mjs does this):
//   node test_rows_gate.mjs [ws://127.0.0.1:8773]
// Registering an account writes tens of rows (profile, directory, presence, schema estimate), so a few accounts use up a cap of 80.
const BASE = process.argv.find((a) => /^wss?:\/\//.test(a)) || "ws://127.0.0.1:8773";
const HTTP = BASE.replace(/^ws/, "http");
let fails = 0;
const check = (c, m) => { if (!c) { fails++; console.log("FAIL:", m); } else console.log("ok:  ", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const rnd = (n) => Array.from({ length: n }, () => B32[Math.floor(Math.random() * 32)]).join("");
const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const code = () => Array.from({ length: 6 }, () => A[Math.floor(Math.random() * A.length)]).join("");

function sock(url) {
  const c = { msgs: [], closed: null };
  c.ws = new WebSocket(url);
  c.ws.onmessage = (e) => { try { c.msgs.push(JSON.parse(e.data)); } catch { /* binary */ } };
  c.ws.onclose = (e) => { c.closed = { code: e.code, reason: e.reason }; };
  c.send = (o) => c.ws.send(JSON.stringify(o));
  c.wait = async (fn, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const r = fn(); if (r) return r; await sleep(25); } return null; };
  return c;
}
async function hubHost() {
  const c = sock(`${BASE}/hub?room=${code()}&role=host&name=t&caps=hostmig,reasons`);
  await c.wait(() => c.msgs.find((m) => m.type === "welcome" || m.type === "error") || c.closed);
  return c;
}
async function account() {
  const uid = rnd(26), secret = rnd(40);
  const c = sock(`${BASE}/friends?uid=${uid}`);
  c.uid = uid;
  await c.wait(() => c.ws.readyState === 1, 4000);
  c.send({ type: "hello", secret, name: "Rows" + rnd(3) });
  c.welcome = await c.wait(() => c.msgs.find((m) => m.type === "welcome"));
  return c;
}

const first = await hubHost();
check(first.msgs.some((m) => m.type === "welcome"), "fresh server: a new /hub room is accepted");
first.ws.close();

const accounts = [];
let refusedAfter = 0;
for (let i = 1; i <= 6; i++) {
  const a = await account();
  if (!a.welcome) { check(false, `account ${i} registered`); break; }
  accounts.push(a);
  const h = await hubHost();
  const busy = h.msgs.find((m) => m.type === "error" && m.reason === "server-busy");
  h.ws.close();
  if (busy) { refusedAfter = i; break; }
}
check(refusedAfter >= 1 && refusedAfter <= 4, `after ${refusedAfter} account registrations (tens of rows each) the rows axis passed 70% of its cap: new /hub rooms are refused with server-busy`);

// Over 90% (the cap of 80 is long gone after a few more registrations): new /friends sockets are refused, with the same reason.
for (let i = 0; i < 3; i++) accounts.push(await account());
const late = sock(`${BASE}/friends?uid=${rnd(26)}`);
const refused = await late.wait(() => late.msgs.find((m) => m.type === "error" && m.reason === "server-busy"), 4000);
check(!!refused, "past 90% of the rows cap a NEW /friends socket is refused with server-busy");

// Existing sockets keep working: the gate only stops new work.
const old = accounts[0];
const before = old.msgs.length;
old.send({ type: "history", with: accounts[1].uid });
check(!!(await old.wait(() => old.msgs.slice(before).find((m) => m.type === "history"), 4000)), "an account that is already connected still gets answers");

for (const a of accounts) try { a.ws.close(); } catch { /* closed */ }
void HTTP;
console.log(fails ? `${fails} FAILED` : "ALL PASSED");
process.exit(fails ? 1 : 0);
