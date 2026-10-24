// Room auto-friending (joiner<->host on join, everyone<->everyone on launch). Usage:
//   npx wrangler dev --ip 127.0.0.1 --port 9100 --var TEST_FRIEND_CAP:2     (another shell; fresh --persist-to dir)
//   node test_autofriend.mjs [ws://127.0.0.1:9100]
const base = process.argv[2] || "ws://127.0.0.1:9100";
let fails = 0;
const check = (c, m) => { if (!c) { fails++; console.log("FAIL:", m); } else console.log("ok:  ", m); };
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const rnd = (n) => Array.from({ length: n }, () => B32[Math.floor(Math.random() * 32)]).join("");
const ROOMCH = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const room = () => Array.from({ length: 6 }, () => ROOMCH[Math.floor(Math.random() * ROOMCH.length)]).join("");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function user(name, extra = {}) {
  const u = { uid: rnd(26), secret: rnd(40), name, msgs: [] };
  await new Promise((resolve) => {
    u.ws = new WebSocket(`${base}/friends?uid=${u.uid}`);
    u.ws.onopen = () => u.ws.send(JSON.stringify({ type: "hello", secret: u.secret, name, ...extra }));
    u.ws.onmessage = (e) => { const m = JSON.parse(e.data); u.msgs.push(m); if (m.type === "welcome") resolve(); };
    u.ws.onclose = resolve;
  });
  return u;
}
// Reconnect with the same uid to read the stored friend list.
function listOf(u) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${base}/friends?uid=${u.uid}`);
    ws.onopen = () => ws.send(JSON.stringify({ type: "hello", secret: u.secret, name: u.name, ...(u.extra || {}) }));
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.type === "welcome") { ws.close(); resolve(m.friends.map((f) => f.uid)); } };
  });
}
function seat(u, code, role, ident = true) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${base}/hub?room=${code}&role=${role}&name=${encodeURIComponent(u.name)}&caps=hostmig,reasons`);
    const s = { ws };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === "welcome") { if (ident) ws.send(JSON.stringify({ type: "ident", uid: u.uid, secret: u.secret })); resolve(s); }
      else if (m.type === "error") resolve(null);
    };
    ws.onclose = () => resolve(null);
  });
}
const launch = (s) => s.ws.send(JSON.stringify({ type: "msg", body: { kind: "launch", game: "x" } }));
const areFriends = async (a, b) => (await listOf(a)).includes(b.uid) && (await listOf(b)).includes(a.uid);
const notFriends = async (a, b) => !(await listOf(a)).includes(b.uid) && !(await listOf(b)).includes(a.uid);

// 1. join -> friends with the host; live friend_added is flagged auto
{
  const H = await user("Hosty"), G = await user("Guesty");
  const c = room();
  const sh = await seat(H, c, "host"), sg = await seat(G, c, "join");
  await sleep(600);
  check(await areFriends(H, G), "joiner and host become friends");
  check(H.msgs.some((m) => m.type === "friend_added" && m.auto === true && m.friend.uid === G.uid), "host got friend_added auto:true");
  check(G.msgs.some((m) => m.type === "friend_added" && m.auto === true && m.friend.uid === H.uid), "guest got friend_added auto:true");
  // 7. removed friends are not re-added in a later room
  H.ws.send(JSON.stringify({ type: "remove_friend", uid: G.uid }));
  await sleep(300);
  sh.ws.close(); sg.ws.close();
  const c2 = room();
  const s2h = await seat(H, c2, "host"), s2g = await seat(G, c2, "join");
  launch(s2h);
  await sleep(600);
  check(await notFriends(H, G), "a removed friend is not auto re-added");
  s2h.ws.close(); s2g.ws.close();
}

// 2. launch links guests with each other
{
  const H = await user("Host3"), A = await user("Alice"), B = await user("Bobby");
  const c = room();
  const sh = await seat(H, c, "host"), sa = await seat(A, c, "join"), sb = await seat(B, c, "join");
  await sleep(700);
  check(await areFriends(H, A) && await areFriends(H, B), "host linked with both guests on join");
  check(await notFriends(A, B), "guests not linked before launch");
  launch(sh);
  await sleep(700);
  check(await areFriends(A, B), "guests linked after launch");
  sh.ws.close(); sa.ws.close(); sb.ws.close();
}

// 3. toggle off (either side)
{
  const H = await user("Hosty2"), P = await user("Private", { auto_friend: false });
  const c = room();
  const sh = await seat(H, c, "host"), sp = await seat(P, c, "join");
  launch(sh);
  await sleep(600);
  check(await notFriends(H, P), "guest with toggle off is not linked");
  sh.ws.close(); sp.ws.close();
  const H2 = await user("Hosty3", { auto_friend: false }), Q = await user("Quincy");
  const c2 = room();
  const s2h = await seat(H2, c2, "host"), s2q = await seat(Q, c2, "join");
  launch(s2h);
  await sleep(600);
  check(await notFriends(H2, Q), "host with toggle off is not linked");
  s2h.ws.close(); s2q.ws.close();
}

// 3b. toggling off live (prefs) after the hello
{
  const H = await user("Hosty7"), P = await user("Liveoff");
  P.ws.send(JSON.stringify({ type: "prefs", auto_friend: false }));
  await sleep(300);
  const c = room();
  const sh = await seat(H, c, "host"), sp = await seat(P, c, "join");
  launch(sh);
  await sleep(600);
  check(await notFriends(H, P), "prefs auto_friend:false is honoured");
  sh.ws.close(); sp.ws.close();
}

// 4. blocks
{
  const H = await user("Hosty4"), K = await user("Blocker");
  K.ws.send(JSON.stringify({ type: "block", uid: H.uid }));
  await sleep(300);
  const c = room();
  const sh = await seat(H, c, "host"), sk = await seat(K, c, "join");
  launch(sh);
  await sleep(600);
  check(await notFriends(H, K), "blocked pair is not linked");
  sh.ws.close(); sk.ws.close();
}

// 5. test accounts, unauthenticated seats
{
  const H = await user("Hosty5"), T = await user("qa-bot1", { test: true }), U = await user("Unproven");
  const c = room();
  const sh = await seat(H, c, "host"), st = await seat(T, c, "join"), su = await seat({ ...U, secret: rnd(40) }, c, "join");
  launch(sh);
  await sleep(600);
  check(await notFriends(H, T), "test account is not linked");
  check(await notFriends(H, U), "wrong secret is not linked");
  const c2 = room();
  const sh2 = await seat(H, c2, "host"), sn = await seat(U, c2, "join", false);   // never sends ident
  launch(sh2);
  await sleep(500);
  check(await notFriends(H, U), "seat without ident is not linked");
  for (const s of [sh, st, su, sh2, sn]) s && s.ws.close();
}

// 6. cap full (server run with TEST_FRIEND_CAP:2): host stays at 2, a full side is skipped gracefully
{
  const H = await user("Hosty6"), G1 = await user("Gina"), G2 = await user("Gabe"), G3 = await user("Gwen");
  const c = room();
  const sh = await seat(H, c, "host"), s1 = await seat(G1, c, "join"), s2 = await seat(G2, c, "join");
  await sleep(700);
  const s3 = await seat(G3, c, "join");
  await sleep(500);
  check(await notFriends(H, G3), "full host is not linked to the third guest");
  check((await listOf(H)).length === 2, "host list stays at the cap");
  launch(sh);
  await sleep(2000);
  check((await listOf(G1)).length <= 2 && (await listOf(G2)).length <= 2 && (await listOf(G3)).length <= 2, "no list exceeds the cap after launch");
  const g3 = await listOf(G3);
  check(g3.length >= 1, "the guest the host could not take is linked with guests that have room");
  for (const s of [sh, s1, s2, s3]) s && s.ws.close();
}

console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exit(fails ? 1 : 0);
