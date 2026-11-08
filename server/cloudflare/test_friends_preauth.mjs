// Junk frames before auth (SV-F2): a stranger who knows a uid (friends see it, the admin's is public) can open a socket for it.
// Local vars (run_all_tests.mjs sets the same by default): --var REG_APPROVAL_DEFAULT:0 --var ALLOW_TEST_FLAG:1 --var TEST_REG:1 --var BUDGET_TEST:1
// Unauthenticated frames must never spend the real owner's per-account message budget (300 a minute), parked sockets are
// bounded, and a socket must say hello within a deadline. Needs a server started with --var HELLO_DEADLINE_MS:2000
// (run_all_tests.mjs does this): node test_friends_preauth.mjs [ws://127.0.0.1:8773]
const BASE = process.argv.find((a) => /^wss?:\/\//.test(a)) || "ws://127.0.0.1:8773";
let fails = 0;
const check = (c, m) => { if (!c) { fails++; console.log("FAIL:", m); } else console.log("ok:  ", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const rnd = (n) => Array.from({ length: n }, () => B32[Math.floor(Math.random() * 32)]).join("");

// `closed` = the close event (a socket the server closes from its own message handler completes the handshake: code + reason).
// `shut()` = the server has closed it, whether or not the handshake finished: a socket the server closes from ANOTHER socket's
// event (the sweep of parked sockets) is left CLOSING on the client (readyState 2) by workerd, with no close event.
function sock(uid) {
  const c = { msgs: [], closed: null };
  c.ws = new WebSocket(`${BASE}/friends?uid=${uid}`);
  c.shut = () => !!c.closed || c.ws.readyState >= WebSocket.CLOSING;
  c.ws.onmessage = (e) => c.msgs.push(JSON.parse(e.data));
  c.ws.onclose = (e) => { c.closed = { code: e.code, reason: e.reason }; };
  c.opened = new Promise((res) => { c.ws.onopen = () => res(true); c.ws.onerror = () => res(false); });
  c.send = (o) => c.ws.send(typeof o === "string" ? o : JSON.stringify(o));
  c.wait = async (fn, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const r = fn(); if (r) return r; await sleep(25); } return null; };
  return c;
}
async function login(uid, secret, name = "Victim") {
  const c = sock(uid);
  await c.opened;
  c.send({ type: "hello", secret, name });
  c.welcome = await c.wait(() => c.msgs.find((m) => m.type === "welcome"));
  return c;
}

const uid = rnd(26), secret = rnd(40);
const victim = await login(uid, secret);
check(!!victim.welcome, "the account owner connects");

// 1. The stranger floods the uid with junk frames over many sockets (350 > the 300 a minute an account is allowed).
const junk = [];
for (let batch = 0; batch < 7; batch++) {
  const part = [];
  for (let i = 0; i < 50; i++) {
    const s = sock(uid);
    s.opened.then((ok) => { if (ok) { try { s.send({ type: "x" }); s.send({ type: "message", to: uid, text: "spam" }); } catch { /* closed */ } } });
    part.push(s);
  }
  junk.push(...part);
  await Promise.all(part.map((s) => s.wait(() => s.shut(), 8000)));
}
const shutAll = junk.filter((s) => s.shut()).length;
const code4002 = junk.filter((s) => s.closed && s.closed.code === 4002).length;
check(shutAll === junk.length, `every junk socket is closed by the server (${shutAll}/${junk.length}; ${code4002} closed on their own first frame with 4002, the rest swept as surplus parked sockets)`);
check(junk.every((s) => !s.msgs.some((m) => m.type === "error" && m.reason === "rate-limited")), "unauthenticated junk is not even answered with rate-limited (it never touches the budget)");

// 2. The owner's real actions still work: a request that the old order of checks answered with rate-limited.
const before = victim.msgs.length;
for (let i = 0; i < 5; i++) victim.send({ type: "history", with: uid });
const replies = await victim.wait(() => victim.msgs.slice(before).filter((m) => m.type === "history").length >= 5, 5000);
check(!!replies, "the owner's requests are answered after the flood");
check(!victim.msgs.slice(before).some((m) => m.type === "error" && m.reason === "rate-limited"), "...and none is answered with rate-limited");

// 3. Pre-auth rules on a single socket.
{
  const s = sock(rnd(26));
  await s.opened;
  s.send("this is not json");
  check(!!(await s.wait(() => s.closed, 3000)) && s.closed.code === 4002, "a socket's first frame must be a hello: garbage closes it (4002)");
}
{
  const s = sock(rnd(26));
  await s.opened;
  s.send({ type: "hello", secret: "short" });
  check(!!(await s.wait(() => s.closed, 3000)) && s.closed.code === 4002, "a hello with an unusable secret closes the socket (4002)");
}
{
  const s = sock(rnd(26));
  await s.opened;
  s.send({ type: "hello", secret: rnd(40), name: "Late" });
  const w = await s.wait(() => s.msgs.find((m) => m.type === "welcome"), 6000);
  check(!!w, "a normal hello within the deadline works");
  s.ws.close();
}

// 4. The hello deadline (2 s in this test): a socket that waits too long is closed, by a later upgrade or by its own late frame.
{
  const late = sock(rnd(26));
  await late.opened;
  await sleep(2600);
  late.send({ type: "hello", secret: rnd(40), name: "TooLate" });
  const closed = await late.wait(() => late.closed, 3000);
  check(!!closed && late.closed.code === 4002 && !late.msgs.some((m) => m.type === "welcome"), "a hello after the deadline is refused (4002 hello-timeout)");
}
{
  const u = rnd(26);
  const parked = sock(u);
  await parked.opened;
  await sleep(2600);
  const next = sock(u);   // the upgrade sweeps expired parked sockets
  await next.opened;
  check(!!(await parked.wait(() => parked.shut(), 3000)), "a parked socket past the deadline is closed when the next one arrives");
  next.ws.close();
}

// 5. At most MAX_UNAUTHED_SOCKETS (8) parked sockets per account; the newest always fits and can still log in.
{
  const u = rnd(26), sec = rnd(40);
  const socks = [];
  for (let i = 0; i < 14; i++) { const s = sock(u); await s.opened; socks.push(s); await sleep(20); }
  await sleep(300);
  const stillOpen = socks.filter((s) => !s.shut()).length;
  check(stillOpen <= 8, `parked unauthenticated sockets are capped at 8 (${stillOpen} open of 14)`);
  const newest = socks[socks.length - 1];
  check(!newest.shut(), "the newest socket is never the one evicted");
  newest.send({ type: "hello", secret: sec, name: "Fits" });
  check(!!(await newest.wait(() => newest.msgs.find((m) => m.type === "welcome"), 6000)), "...and it can still authenticate");
  check(socks.slice(0, 3).every((s) => s.shut()), "the oldest parked sockets were the ones closed");
  for (const s of socks) try { s.ws.close(); } catch { /* closed */ }
}

victim.ws.close();
console.log(fails ? `${fails} FAILED` : "ALL PASSED");
process.exit(fails ? 1 : 0);
