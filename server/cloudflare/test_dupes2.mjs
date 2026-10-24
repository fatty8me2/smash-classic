// Duplicate-friend causes round 2: retired-uid alias map + stale requests. Usage:
//   npx wrangler dev --ip 127.0.0.1 --port 8772 --var TEST_ALIAS:1 --var ADMIN_UID:aaaaaaaaaaaaaaaaaaaaaaaaaa   (another shell)
//   node test_dupes2.mjs [ws://127.0.0.1:8772]
const base = process.argv[2] || "ws://127.0.0.1:8772";
const http = base.replace(/^ws/, "http");
let fails = 0;
const check = (c, m) => { if (!c) { fails++; console.log("FAIL:", m); } else console.log("ok:  ", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const rnd = (n) => Array.from({ length: n }, () => B32[Math.floor(Math.random() * 32)]).join("");
const codeOf = (uid) => { const p = uid.slice(0, 8).toUpperCase(); return `RH-${p.slice(0, 4)}-${p.slice(4)}`; };

class User {
  constructor(name) { this.name = name; this.uid = rnd(26); this.secret = rnd(40); this.events = []; this.ws = null; }
  connect() {
    return new Promise((resolve) => {
      this.events = []; this.welcome = null;
      const ws = this.ws = new WebSocket(`${base}/friends?uid=${this.uid}`);
      ws.onopen = () => ws.send(JSON.stringify({ type: "hello", secret: this.secret, name: this.name }));
      ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.type === "welcome") { this.welcome = m; resolve(m); } this.events.push(m); };
      ws.onclose = () => resolve(null);
    });
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  async reconnect() { try { this.ws.close(); } catch {} await sleep(150); return this.connect(); }
  async wait(pred, ms = 4000) { const t = Date.now(); while (Date.now() - t < ms) { if (pred()) return true; await sleep(30); } return false; }
  has(type, f = () => true) { return this.events.some((e) => e.type === type && f(e)); }
  close() { try { this.ws.close(); } catch {} }
}
const all = [];
const mk = async (name) => { const u = new User(name); all.push(u); await u.connect(); return u; };
const alias = async (old, to) => (await fetch(`${http}/__test/alias`, { method: "POST", body: JSON.stringify({ old, to }) })).status;
async function befriend(a, b) {
  a.send({ type: "add_friend", code: codeOf(b.uid) });
  await b.wait(() => b.has("request", (e) => e.dir === "in" && e.req.uid === a.uid));
  b.send({ type: "accept", uid: a.uid });
  await a.wait(() => a.has("friend_added", (e) => e.friend.uid === b.uid));
}
const uniq = (a) => new Set(a).size === a.length;

// 1) a friend still lists a retired uid that no fan-out replaced: the alias map swaps it, both sides
{
  const f = await mk("aliasF"), a = await mk("aliasA"), b = await mk("aliasA");   // b = same person, new identity
  await befriend(f, a);
  check(await alias(a.uid, b.uid) === 200, "alias registered");
  let w = await f.reconnect();
  const ids = w.friends.map((x) => x.uid);
  check(ids.includes(b.uid) && !ids.includes(a.uid) && uniq(ids), "friend's old uid swapped for the new one, no duplicate");
  w = await b.reconnect();
  check(w.friends.map((x) => x.uid).includes(f.uid), "new identity lists the friend back (two-sided)");
  check(await alias(b.uid, a.uid) === 409, "alias cycle refused");
}
// 2) alias chain A -> B -> C resolves to the last identity
{
  const f = await mk("chainF"), a = await mk("chain"), b = await mk("chain"), c = await mk("chain");
  await befriend(f, a);
  await alias(a.uid, b.uid); await alias(b.uid, c.uid);
  const ids = (await f.reconnect()).friends.map((x) => x.uid);
  check(ids.includes(c.uid) && !ids.includes(a.uid) && !ids.includes(b.uid), "chain resolves to the newest identity");
}
// 3) the new identity blocked the friend: the old row is dropped and nothing is added
{
  const f = await mk("blkF"), a = await mk("blk"), b = await mk("blk");
  await befriend(f, a);
  b.send({ type: "block", uid: f.uid }); await sleep(200);
  await alias(a.uid, b.uid);
  const ids = (await f.reconnect()).friends.map((x) => x.uid);
  check(!ids.includes(a.uid) && !ids.includes(b.uid), "blocked successor: old row removed, no new row");
}
// 4) pending incoming request from a retired uid becomes a request from the new uid
{
  const f = await mk("reqF"), a = await mk("reqA"), b = await mk("reqA");
  a.send({ type: "add_friend", code: codeOf(f.uid) });
  await f.wait(() => f.has("request", (e) => e.dir === "in" && e.req.uid === a.uid));
  await alias(a.uid, b.uid);
  const w = await f.reconnect();
  const inc = w.requests.incoming.map((x) => x.uid);
  check(inc.includes(b.uid) && !inc.includes(a.uid) && uniq(inc), "pending request re-pointed to the new identity");
}
// 5) a real retire stores the alias (cycle refused afterwards) and bad-secret errors name the uid
{
  const old = await mk("rt"), nu = await mk("rt"), f = await mk("rtF");
  await befriend(old, f);
  nu.send({ type: "retire_old", uid: old.uid, secret: old.secret });
  check(await nu.wait(() => nu.has("retired", (e) => e.uid === old.uid)), "retire completes");
  check(await alias(nu.uid, old.uid) === 409, "completed retire left old -> new alias behind");
  const other = await mk("rt2");
  nu.events = [];
  nu.send({ type: "retire_old", uid: other.uid, secret: "x".repeat(40) });
  check(await nu.wait(() => nu.has("error", (e) => e.detail === "bad-secret" && e.uid === other.uid)), "bad-secret error carries the uid");
}
all.forEach((u) => u.close());
console.log(fails ? `${fails} FAILED` : "ALL OK");
process.exit(fails ? 1 : 0);
