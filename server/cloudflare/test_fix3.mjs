// Review fixes round 3: alias retry after retire marker, friend-cap-full keeps the old row. Usage:
//   npx wrangler dev --ip 127.0.0.1 --port 8773 --var TEST_ALIAS:1 --var TEST_ALIAS_FAIL_ONCE:1 --var TEST_FRIEND_CAP:2   (another shell)
//   node test_fix3.mjs [ws://127.0.0.1:8773]
const base = process.argv[2] || "ws://127.0.0.1:8773";
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

const aliasMap = async (uids) => (await (await fetch(`${http}/__test/aliases`, { method: "POST", body: JSON.stringify({ uids }) })).json()).map;

// 1) alias POST fails once after retire completes; the replayed retire_old retries it (idempotent)
{
  const old = await mk("ret"), nu = await mk("ret"), f = await mk("retF");
  await befriend(f, old);
  nu.send({ type: "retire_old", uid: old.uid, secret: old.secret });
  check(await nu.wait(() => nu.has("retired")), "retire completes even though the alias POST failed");
  check(!(await aliasMap([old.uid]))[old.uid], "alias missing after the injected failure");
  nu.events = [];
  nu.send({ type: "retire_old", uid: old.uid, secret: old.secret });
  check(await nu.wait(() => nu.has("retired")), "replayed retire acknowledged");
  check((await aliasMap([old.uid]))[old.uid] === nu.uid, "replay retried and stored the alias");
  nu.send({ type: "retire_old", uid: old.uid, secret: old.secret });
  await nu.wait(() => false, 300);
  check((await aliasMap([old.uid]))[old.uid] === nu.uid, "repeat is idempotent");
}
// 2) friend list full (cap 2): alias swap must keep the old row, not lose the friend
{
  const f = await mk("capF"), a = await mk("capA"), x = await mk("capX"), b = await mk("capA");
  await befriend(f, a); await befriend(f, x);
  check(await alias(a.uid, b.uid) === 200, "alias registered");
  const ids = (await f.reconnect()).friends.map((u) => u.uid);
  check(ids.includes(a.uid) && ids.includes(x.uid) && !ids.includes(b.uid), "cap full: old friend kept, none lost");
}
all.forEach((u) => u.close());
console.log(fails ? `${fails} FAILED` : "ALL PASSED");
process.exit(fails ? 1 : 0);
