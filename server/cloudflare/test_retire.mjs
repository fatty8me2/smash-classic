// Retire crash-safety/replay/force-accept tests. Usage:
//   npx wrangler dev --port 8771 --var TEST_RETIRE_FAIL_AFTER:1 --var ADMIN_UID:aaaaaaaaaaaaaaaaaaaaaaaaaa   (another shell)
//   node test_friends_dedupe.mjs [ws://127.0.0.1:8771]
// Needs the ADMIN_UID var above (the all-"a" account is created by this test as the auto-link admin).
const base = process.argv[2] || "ws://127.0.0.1:8771";
const ADMIN = "a".repeat(26);
let fails = 0;
const check = (c, m) => { if (!c) { fails++; console.log("FAIL:", m); } else console.log("ok:  ", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const rnd = (n) => Array.from({ length: n }, () => B32[Math.floor(Math.random() * 32)]).join("");
const codeOf = (uid) => { const p = uid.slice(0, 8).toUpperCase(); return `RH-${p.slice(0, 4)}-${p.slice(4)}`; };

class User {
  constructor(name, uid = rnd(26)) { this.name = name; this.uid = uid; this.secret = uid === "a".repeat(26) ? "admin-fixed-secret-for-local-tests" : rnd(40); this.events = []; this.ws = null; this.closeCode = null; }
  connect() {
    return new Promise((resolve) => {
      this.events = []; this.closeCode = null; this.welcome = null;
      const ws = this.ws = new WebSocket(`${base}/friends?uid=${this.uid}`);
      ws.onopen = () => ws.send(JSON.stringify({ type: "hello", secret: this.secret, name: this.name }));
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.type === "welcome") { this.welcome = m; resolve(m); }
        this.events.push(m);
      };
      ws.onclose = (e) => { this.closeCode = e.code; resolve(null); };
    });
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  async reconnect() { try { this.ws.close(); } catch {} await sleep(150); return this.connect(); }
  async wait(pred, ms = 4000) { const t = Date.now(); while (Date.now() - t < ms) { if (pred()) return true; await sleep(30); } return false; }
  has(type, f = () => true) { return this.events.some((e) => e.type === type && f(e)); }
  close() { try { this.ws.close(); } catch {} }
}

const uidsOf = (a) => a.map((x) => x.uid);
const unique = (a) => new Set(a).size === a.length;
async function fresh(u) { const w = await u.reconnect(); return w; }   // welcome = server truth
async function befriend(a, b) {
  a.send({ type: "add_friend", code: codeOf(b.uid) });
  await b.wait(() => b.has("request", (e) => e.dir === "in" && e.req.uid === a.uid));
  b.send({ type: "accept", uid: a.uid });
  await a.wait(() => a.has("friend_added", (e) => e.friend.uid === b.uid));
}
const all = [];
const mk = async (name) => { const u = new User(name); all.push(u); await u.connect(); return u; };
const fl = async (u) => (await u.reconnect()).friends.map((x) => x.uid);

const old = await mk("old"), nu = await mk("new");
const f = [await mk("f1"), await mk("f2"), await mk("f3")], bad = await mk("blocked");
for (const x of f) await befriend(old, x);
old.send({ type: "block", uid: bad.uid }); await sleep(200);

// crash mid fan-out (test hook fails once after 1 friend)
nu.send({ type: "retire_old", uid: old.uid, secret: old.secret });
check(await nu.wait(() => nu.has("error", (e) => e.detail === "retire-failed")), "mid-fan-out failure reported, not 'retired'");
check(!nu.has("retired"), "no retired ack after failure");
nu.events = [];
nu.send({ type: "retire_old", uid: old.uid, secret: old.secret });
check(await nu.wait(() => nu.has("retired")), "retry resumes and completes");
const nf = await fl(nu);
check(f.every((x) => nf.includes(x.uid)) && !nf.includes(old.uid), "all 3 friends moved to successor");
for (const x of f) { const l = await fl(x); check(l.includes(nu.uid) && !l.includes(old.uid) && unique(l), "friend has successor only: " + x.name); }
let w = await nu.reconnect();
check(w.blocked.includes(bad.uid), "blocked carried over");

// replay must not re-block after the user unblocked
nu.send({ type: "unblock", uid: bad.uid }); await sleep(200);
nu.events = [];
nu.send({ type: "retire_old", uid: old.uid, secret: old.secret });
check(await nu.wait(() => nu.has("retired")), "replayed retire_old acknowledged");
w = await nu.reconnect();
check(!w.blocked.includes(bad.uid), "replay does not re-block an unblocked user");
check(unique(w.friends.map((x) => x.uid)), "no duplicate friends after replay");

// force-accept: a stranger cannot accept a request that they did not receive
const x1 = await mk("x1"), y1 = await mk("y1");
x1.send({ type: "add_friend", code: codeOf(y1.uid) });
await y1.wait(() => y1.has("request", (e) => e.dir === "in"));
x1.send({ type: "accept", uid: y1.uid }); await sleep(300);
check(!(await fl(x1)).includes(y1.uid) && !(await fl(y1)).includes(x1.uid), "requester cannot force-accept own request");

all.forEach((u) => u.close());
console.log(fails ? `${fails} FAILED` : "ALL OK");
process.exit(fails ? 1 : 0);
