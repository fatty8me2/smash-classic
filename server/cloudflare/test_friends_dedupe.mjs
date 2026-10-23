// Friends de-duplication tests (one entry per person). Usage:
//   npx wrangler dev --port 8771 --var ADMIN_UID:aaaaaaaaaaaaaaaaaaaaaaaaaa   (another shell)
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
const mk = async (name, uid) => { const u = new User(name, uid); all.push(u); await u.connect(); return u; };

// ---- admin auto-link is added once, even across many reconnects ----
const admin = await mk("admin", ADMIN);
const a1 = await mk("alice");
await sleep(300);
for (let i = 0; i < 3; i++) await a1.reconnect();
let w = a1.welcome;
check(uidsOf(w.friends).filter((u) => u === ADMIN).length === 1, "admin link: exactly one admin friend after 3 reconnects");
check(w.requests.incoming.length === 0 && w.requests.outgoing.length === 0, "admin link: no pending request left");
w = (await admin.reconnect());
check(uidsOf(w.friends).filter((u) => u === a1.uid).length === 1, "admin side: user listed once");

// ---- A and B add each other at the same moment ----
const A = await mk("Ann"), Bo = await mk("Bob");
A.send({ type: "add_friend", code: codeOf(Bo.uid) });
Bo.send({ type: "add_friend", code: codeOf(A.uid) });
await sleep(1200);
let wa = await fresh(A), wb = await fresh(Bo);
check(uidsOf(wa.friends).filter((u) => u === Bo.uid).length === 1 && uidsOf(wb.friends).filter((u) => u === A.uid).length === 1, "crossed add: each side lists the other once");
const crossedReq = wa.requests.incoming.length + wa.requests.outgoing.length + wb.requests.incoming.length + wb.requests.outgoing.length;
if (wa.friends.some((f) => f.uid === Bo.uid)) check(crossedReq === 0, "crossed add: friend AND request never both (requests empty)");
else check(wa.requests.incoming.every((r) => !wa.requests.outgoing.some((o) => o.uid === r.uid)), "crossed add: no person in both request lists");

// ---- remove then re-add ----
const C = await mk("Cat"), D = await mk("Dan");
await befriend(C, D);
C.send({ type: "remove_friend", uid: D.uid });
await D.wait(() => D.has("friend_removed"));
await befriend(D, C);
let wc = await fresh(C), wd = await fresh(D);
check(uidsOf(wc.friends).filter((u) => u === D.uid).length === 1 && uidsOf(wd.friends).filter((u) => u === C.uid).length === 1, "re-add after removal: one entry each side");
check(wc.requests.incoming.length + wc.requests.outgoing.length + wd.requests.incoming.length + wd.requests.outgoing.length === 0, "re-add after removal: no leftover requests");
C.send({ type: "add_friend", code: codeOf(D.uid) });
await C.wait(() => C.has("error"));
check(C.has("error", (e) => e.reason === "already-friends"), "adding an existing friend is refused");

// ---- accept after a request is also pending the other way never leaves both ----
const E = await mk("Eve"), F = await mk("Fay");
E.send({ type: "add_friend", code: codeOf(F.uid) });
await F.wait(() => F.has("request"));
F.send({ type: "add_friend", code: codeOf(E.uid) });   // adding the person who asked you = accept
await E.wait(() => E.has("friend_added"));
let we = await fresh(E), wf = await fresh(F);
check(uidsOf(we.friends).includes(F.uid) && we.requests.incoming.length + we.requests.outgoing.length === 0, "add-back of an incoming request: friends, request cleared (E)");
check(uidsOf(wf.friends).includes(E.uid) && wf.requests.incoming.length + wf.requests.outgoing.length === 0, "add-back of an incoming request: friends, request cleared (F)");

// ---- identity adoption: the replaced uid is retired and its friendships move ----
const X = await mk("Xavier"), Y = await mk("Yuki"), Z = await mk("Zed"), W = await mk("Wren"), V = await mk("Vic");
const oldPc = await mk("fatty");           // identity generated on the new PC (will be replaced)
const keep = await mk("fatty");            // the older identity being adopted (same display name)
await befriend(oldPc, X);
await befriend(oldPc, Y);
await befriend(keep, X);                   // X is friends with BOTH fattys
await befriend(keep, V);
Z.send({ type: "add_friend", code: codeOf(oldPc.uid) });   // Z asked the old uid
await oldPc.wait(() => oldPc.has("request", (e) => e.dir === "in" && e.req.uid === Z.uid));
oldPc.send({ type: "add_friend", code: codeOf(W.uid) });   // old uid asked W
await W.wait(() => W.has("request", (e) => e.req.uid === oldPc.uid));
let wx = await fresh(X);
check(wx.friends.filter((f) => f.name === "fatty").length === 2, "setup: X sees two 'fatty' friends (the bug)");

// wrong secret is refused
keep.events = [];
keep.send({ type: "retire_old", uid: oldPc.uid, secret: rnd(40) });
await keep.wait(() => keep.has("error"));
check(keep.has("error", (e) => e.detail === "bad-secret"), "retire with a wrong secret is refused");
check(uidsOf((await fresh(X)).friends).includes(oldPc.uid), "...and nothing moved");

keep.send({ type: "retire_old", uid: oldPc.uid, secret: oldPc.secret });
check(await keep.wait(() => keep.has("retired")), "retire_old acknowledged");
await sleep(300);
const wk = await fresh(keep);
check(unique(uidsOf(wk.friends)), "new identity: friend uids unique");
check([X, Y, V].every((u) => uidsOf(wk.friends).includes(u.uid)), "new identity: has X, Y (moved) and V (kept)");
check(!uidsOf(wk.friends).includes(oldPc.uid), "new identity: old uid is not a friend");
check(wk.friends.filter((f) => f.uid === X.uid).length === 1, "X listed once on the kept identity");
wx = await fresh(X);
check(wx.friends.filter((f) => f.name === "fatty").length === 1 && uidsOf(wx.friends).includes(keep.uid) && !uidsOf(wx.friends).includes(oldPc.uid), "X now sees exactly one 'fatty' (the kept uid)");
const wy = await fresh(Y);
check(wy.friends.filter((f) => f.name === "fatty").length === 1 && uidsOf(wy.friends).includes(keep.uid), "Y's single 'fatty' friend moved to the kept uid");
const wz = await fresh(Z);
check(wz.requests.outgoing.length === 1 && wz.requests.outgoing[0].uid === keep.uid, "Z's pending request to the old uid now points at the kept uid");
check(wk.requests.incoming.some((r) => r.uid === Z.uid), "kept uid shows Z's request once");
const ww = await fresh(W);
check(ww.requests.incoming.length === 1 && ww.requests.incoming[0].uid === keep.uid, "W's incoming request now comes from the kept uid");
check(wk.requests.outgoing.some((r) => r.uid === W.uid), "kept uid shows its request to W once");
await oldPc.connect();
check(oldPc.closeCode === 4005, "the retired uid can no longer connect (4005)");
keep.events = [];
keep.send({ type: "retire_old", uid: oldPc.uid, secret: oldPc.secret });
check(await keep.wait(() => keep.has("retired")), "retire_old is idempotent");
check(unique(uidsOf((await fresh(keep)).friends)), "after the repeat: still unique");

all.forEach((u) => u.close());
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
