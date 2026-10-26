// Friends' play time: playtime (write) / playtime_get (read) on the friends socket.
// Run: npx wrangler dev --ip 127.0.0.1 --port 9100 --var TEST_PT_STALE_MS:0 (fresh --persist-to), then: node test_playtime.mjs ws://127.0.0.1:9100
// (run_all_tests.mjs starts an isolated server with the variable set)
const base = process.argv.find((a) => /^wss?:\/\//.test(a)) || "ws://127.0.0.1:9100";
let fails = 0;
const check = (c, m) => { if (!c) { fails++; console.log("FAIL:", m); } else console.log("ok:  ", m); };
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const rnd = (n) => Array.from({ length: n }, () => B32[Math.floor(Math.random() * 32)]).join("");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function user(name) {
  const u = { uid: rnd(26), secret: rnd(40), name, msgs: [] };
  await new Promise((resolve) => {
    u.ws = new WebSocket(`${base}/friends?uid=${u.uid}`);
    u.ws.onopen = () => u.ws.send(JSON.stringify({ type: "hello", secret: u.secret, name, ...(/^qa-/.test(name) ? { test: true } : {}) }));
    u.ws.onmessage = (e) => { const m = JSON.parse(e.data); u.msgs.push(m); if (m.type === "welcome") { u.code = m.code; resolve(); } };
    u.ws.onclose = resolve;
  });
  u.send = (o) => u.ws.send(JSON.stringify(o));
  u.wait = async (fn, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const r = fn(); if (r) return r; await sleep(20); } return null; };
  u.get = async () => { const n = u.msgs.length; u.send({ type: "playtime_get" }); const m = await u.wait(() => u.msgs.slice(n).find((x) => x.type === "playtime")); return m ? m.friends : null; };
  return u;
}
async function befriend(a, b) {
  a.send({ type: "add_friend", code: b.code });
  await b.wait(() => b.msgs.some((m) => m.type === "request"));
  b.send({ type: "accept", uid: a.uid });
  await a.wait(() => a.msgs.some((m) => m.type === "friend_added" && m.friend.uid === b.uid));
}
const G = (k, t, m) => ({ k, t, m });

// 1. basics: write, friend reads, sorted, whole minutes, bounded
{
  const A = await user("Mickey"), B = await user("camer");
  await befriend(A, B);
  A.send({ type: "playtime", share: true, games: [G("n64:aaa", "Smash 64", 840), G("gba:bbb", "Metroid Fusion", 90.7), G("gb:ccc", "Tetris", 0), G("bad", "x", -5), { t: "no key", m: 5 }, G("n64:aaa", "Smash 64", 840)] });
  await sleep(200);
  const f = await B.get();
  const rows = f && f[A.uid];
  check(Array.isArray(rows) && rows.length === 2, "friend sees 2 valid games (zero/negative/keyless dropped, duplicate merged)");
  check(rows && rows[0].k === "n64:aaa" && rows[0].m === 840 && rows[0].t === "Smash 64", "sorted by minutes, title kept");
  check(rows && rows[1].m === 90, "minutes are whole numbers");
  const none = await A.get();
  check(none && Object.keys(none).length === 0, "my own data is not in my own reply");

  // bounded to the top 30
  A.send({ type: "playtime", share: true, games: Array.from({ length: 50 }, (_, i) => G("n64:g" + i, "Game " + i, 10 + i)) });
  await sleep(200);
  const f2 = await B.get();
  check(f2[A.uid].length === 30 && f2[A.uid][0].m === 59 && f2[A.uid][29].m === 30, "only the top 30 games are stored");

  // 2. share off erases
  A.send({ type: "playtime", share: false });
  await sleep(200);
  const f3 = await B.get();
  check(!f3[A.uid], "share:false -> friends see nothing");
  A.send({ type: "playtime", share: true, games: [G("n64:aaa", "Smash 64", 100)] });
  await sleep(200);
  check((await B.get())[A.uid]?.[0]?.m === 100, "share back on -> visible again");

  // 3. block: neither side sees the other
  B.send({ type: "playtime", share: true, games: [G("n64:aaa", "Smash 64", 5)] });
  await sleep(200);
  check((await A.get())[B.uid]?.[0]?.m === 5, "friendship is symmetric");
  B.send({ type: "block", uid: A.uid });
  await sleep(400);
  check(!(await B.get())[A.uid], "blocker no longer sees the blocked user's play time");
  check(!(await A.get())[B.uid], "blocked user no longer sees the blocker's play time");
  B.send({ type: "unblock", uid: A.uid });
  await sleep(100);
  check(!(await B.get())[A.uid], "unblock alone does not bring it back (not friends)");
  A.ws.close(); B.ws.close();
}

// 4. removed friend, non-friend, test account
{
  const A = await user("Alice"), B = await user("Bobby"), C = await user("Carol");
  await befriend(A, B);
  A.send({ type: "playtime", share: true, games: [G("gba:x", "X", 60)] });
  await sleep(200);
  check((await B.get())[A.uid]?.[0]?.m === 60, "friend sees it");
  check(!(await C.get())[A.uid], "a non-friend sees nothing");
  A.send({ type: "remove_friend", uid: B.uid });
  await sleep(400);
  check(!(await B.get())[A.uid], "removed friend sees nothing");
  A.ws.close(); B.ws.close(); C.ws.close();

  const T = await user("qa-pt-test"), D = await user("Dave");
  await befriend(T, D);
  T.send({ type: "playtime", share: true, games: [G("gba:x", "X", 60)] });
  await sleep(200);
  check(!(await D.get())[T.uid], "test accounts are excluded");
  T.ws.close(); D.ws.close();
}

// 5. rate limits
{
  const A = await user("Spammer");
  for (let i = 0; i < 14; i++) A.send({ type: "playtime", share: true, games: [G("gba:x", "X", i + 1)] });
  check(await A.wait(() => A.msgs.some((m) => m.type === "error" && m.reason === "rate-limited" && m.ref === "playtime")), "writes are rate limited (12/hour)");
  let limited = false;
  for (let i = 0; i < 33 && !limited; i++) { const n = A.msgs.length; A.send({ type: "playtime_get" }); await sleep(30); limited = A.msgs.slice(n).some((m) => m.type === "error" && m.ref === "playtime_get"); }
  check(limited, "reads are rate limited (30/hour)");
  A.ws.close();
}

console.log(fails ? `${fails} FAILED` : "ALL PASSED");
process.exit(fails ? 1 : 0);
