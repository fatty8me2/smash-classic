// Per-PC credentials, lock-out, replace-keeps-other-PC, sign-out, release username, delete account. Usage:
//   npx wrangler dev --port 8784 --var ALLOW_TEST_FLAG:1 --var UNAME_HOLD_MS:600000 --var REG_APPROVAL_DEFAULT:0   (another shell)
//   node test_account_devices.mjs [ws://127.0.0.1:8784]
const base = process.argv[2] || "ws://127.0.0.1:8784";
const http = base.replace("ws", "http");
let fails = 0;
const check = (c, m) => { if (!c) { fails++; console.log("FAIL:", m); } else console.log("ok:  ", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const rnd = (n) => Array.from({ length: n }, () => B32[Math.floor(Math.random() * 32)]).join("");
const codeOf = (uid) => { const p = uid.slice(0, 8).toUpperCase(); return `RH-${p.slice(0, 4)}-${p.slice(4)}`; };

// One PC: its uid, the secret it currently holds, whether it speaks the new protocol (dev), and its pc id.
class Pc {
  constructor(uid, secret, { dev = true, pc = "pc-" + rnd(10), name = "n" + rnd(5) } = {}) { Object.assign(this, { uid, secret, dev, pc, name }); this.events = []; this.ws = null; this.closeCode = null; this.welcome = null; }
  connect(secret = this.secret) {
    return new Promise((resolve) => {
      this.events = []; this.closeCode = null; this.welcome = null;
      const ws = this.ws = new WebSocket(`${base}/friends?uid=${this.uid}`);
      ws.onopen = () => ws.send(JSON.stringify({ type: "hello", secret, name: this.name, ...(this.dev ? { dev: 1, pc: this.pc, pc_name: "PC " + this.pc.slice(3, 7) } : {}) }));
      ws.onmessage = (e) => { const m = JSON.parse(e.data); this.events.push(m); if (m.type === "welcome") { this.welcome = m; resolve(m); } };
      ws.onclose = (e) => { this.closeCode = e.code; resolve(null); };
    });
  }
  /* Like the real client: keep the device secret the server handed out. */
  async connectAdopt() { const w = await this.connect(); if (w && w.device) this.secret = w.device.secret; return w; }
  send(o) { this.ws.send(JSON.stringify(o)); }
  async reconnect() { try { this.ws.close(); } catch {} await sleep(150); return this.connect(); }
  async wait(pred, ms = 4000) { const t = Date.now(); while (Date.now() - t < ms) { if (pred()) return true; await sleep(30); } return false; }
  has(type, f = () => true) { return this.events.some((e) => e.type === type && f(e)); }
  get(type) { return this.events.find((e) => e.type === type); }
  close() { try { this.ws.close(); } catch {} }
}
const all = [];
async function newAccount(opts) { const u = new Pc(rnd(26), rnd(52), opts); all.push(u); await u.connectAdopt(); return u; }
const sibling = (u, opts) => { const p = new Pc(u.uid, u.secret, opts); all.push(p); return p; };
async function devicesOf(u) { u.events = []; u.send({ type: "devices" }); await u.wait(() => u.has("devices")); return u.get("devices"); }
async function befriend(a, b) {
  a.send({ type: "add_friend", code: codeOf(b.uid) });
  await b.wait(() => b.has("request", (e) => e.dir === "in" && e.req.uid === a.uid));
  b.send({ type: "accept", uid: a.uid });
  await a.wait(() => a.has("friend_added", (e) => e.friend.uid === b.uid));
}
const link = (path, body) => fetch(http + path, { method: "POST", body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, j: await r.json().catch(() => ({})) }));

// ---- 1. an old client (no dev) works exactly as before; nothing is issued -----------------------------------------
const old = await newAccount({ dev: false });
check(old.welcome && !old.welcome.device, "old client: welcome carries no device credential");
check(old.welcome.devcap === 1, "welcome says the server offers per-PC sign-ins (devcap)");
check((await old.reconnect()) !== null, "old client reconnects with the shared secret");

// ---- 2. first connect after the update: a device credential is issued, the old secret keeps working ---------------
const rootSecret = rnd(52), uidA = rnd(26);
const pre = new Pc(uidA, rootSecret, { dev: false }); all.push(pre);
await pre.connect();                                           // v1.39.0 registers the account
const pc1 = new Pc(uidA, rootSecret, { pc: "pc-one-0001" }); all.push(pc1);
const w1 = await pc1.connect();
check(w1 && w1.device && /^[a-z2-7]{52}$/.test(w1.device.secret), "updated client: first connect after the update gets a device secret");
const d1 = w1.device.secret; pc1.secret = d1;
const w1b = await pc1.reconnect();
check(w1b && !w1b.device, "reconnect with the device secret: welcome, no second credential");
check((await pre.connect()) !== null, "v1.39.0 client (shared secret) is still accepted after the update");
check((await sibling(pre, { dev: false }).connect()) !== null, "a second legacy connection with the shared secret works");

// ---- 3. two PCs on one account -------------------------------------------------------------------------------------
const pc2 = sibling(pc1, { pc: "pc-two-0002" }); pc2.secret = rootSecret;          // PC2 updates later, still holding the shared secret
const w2 = await pc2.connectAdopt();
check(w2 && w2.device && w2.device.secret !== d1, "second PC gets its own, different credential");
let dl = await devicesOf(pc1);
check(dl.devices.length === 2 && dl.current === dl.devices.find((d) => d.pc === "pc-one-0001").id, "device list shows both PCs and marks this one");
// the same PC re-enrolling (lost reply) does not add a row
const pc2again = sibling(pc1, { pc: "pc-two-0002" }); pc2again.secret = rootSecret; await pc2again.connectAdopt();
dl = await devicesOf(pc1);
check(dl.devices.length === 2, "re-enrolling the same PC replaces its row (still 2)");
pc2.secret = pc2again.secret; pc2again.close();
// a copied device secret on another PC (shared vault) gets that PC its own credential
const pc3 = sibling(pc1, { pc: "pc-three-003" }); pc3.secret = pc1.secret;
const w3 = await pc3.connectAdopt();
check(w3 && w3.device && w3.device.secret !== pc1.secret, "a PC that starts from another PC's device secret gets its own");
pc3.close();
// ---- 4. lock one PC out (revocation cannot be undone by a PC that still holds the old shared secret) ---------------
await pc2.reconnect();
const pc2id = (await devicesOf(pc1)).devices.find((d) => d.pc === "pc-two-0002").id;
const pc2dev = pc2.secret;
pc1.events = []; pc1.send({ type: "revoke_device", id: dl.current }); await pc1.wait(() => pc1.has("device_revoked"));
check(pc1.get("device_revoked").reason === "self", "a PC cannot revoke itself with revoke_device");
pc1.events = []; pc1.send({ type: "revoke_device", id: pc2id });
check(await pc1.wait(() => pc1.has("device_revoked", (e) => e.ok)), "revoke_device answers ok");
check(await pc2.wait(() => pc2.closeCode === 4003), "the locked-out PC's open socket is closed (4003)");
const back = await pc2.connect(); await sleep(150);
check(back === null && pc2.closeCode === 4003, "a revoked PC using its device secret is refused (4003)");
const oldRootPc = new Pc(uidA, rootSecret, { pc: "pc-two-0002" }); all.push(oldRootPc);       // same PC label, still holding the OLD shared secret
check((await oldRootPc.connect()) === null && oldRootPc.closeCode === 4003, "a revoked PC using the OLD shared secret is refused: it cannot enrol itself again");
const faked = new Pc(uidA, rootSecret, { pc: "pc-faked-9999" }); all.push(faked);
check((await faked.connect()) === null && faked.closeCode === 4003, "...even with a different, made-up PC label");
check((await pc1.reconnect()) !== null, "the other enrolled PC is unaffected");
const legacyAfter = new Pc(uidA, rootSecret, { dev: false }); all.push(legacyAfter);
check((await legacyAfter.connect()) === null && legacyAfter.closeCode === 4003, "a PC that never updated is refused with 4003 (the client shows 'enter your account code')");
check((await pre.connect()) === null, "the legacy PC from step 2 is refused too (it needs the new account code)");
pc1.events = []; pc1.send({ type: "revoke_device", cdev: "cloud-xyz-9" }); await pc1.wait(() => pc1.has("device_revoked"));
check(pc1.get("device_revoked").reason === "not-found", "revoke of an unknown PC says not-found and changes nothing");
check((await pc1.reconnect()) !== null, "...and nothing was locked by that");
// the new account code works on a fresh PC
const mA = await link("/link/recovery", { uid: uidA, secret: pc1.secret });
const fresh = new Pc(uidA, mA.j.secret, { pc: "pc-fresh-0003" }); all.push(fresh);
const wf = await fresh.connectAdopt();
check(wf && wf.device && wf.device.secret !== mA.j.secret, "the NEW account code works on a fresh PC, which enrols its own credential");
check((await new Pc(uidA, pc2dev, { pc: "pc-two-0002" }).connect()) === null, "...and the revoked PC's old device secret still does not");

// ---- 5. replace on PC1 keeps PC2 working (F5): when unsure, nothing is retired ---------------------------------------
const bPc1 = await newAccount({ pc: "pc-b-one-001" });
const bPc2 = sibling(bPc1, { pc: "pc-b-two-002" }); bPc2.secret = bPc1.secret; await bPc2.connectAdopt();
const bPc3 = sibling(bPc1, { pc: "pc-b-thr-003" }); bPc3.secret = bPc1.secret; await bPc3.connectAdopt();
const friendB = await newAccount();
await befriend(bPc1, friendB);
const a2 = await newAccount({ dev: false });
a2.send({ type: "retire_old", uid: bPc1.uid, secret: bPc1.secret });
check(await a2.wait(() => a2.has("error", (e) => e.detail === "retired-elsewhere")), "a v1.39.0 client gets the terminal retired-elsewhere answer");
const a1 = await newAccount();                    // the account PC3 moves to (updated client)
a1.send({ type: "retire_old", uid: bPc1.uid, secret: bPc3.secret });
check(await a1.wait(() => a1.has("retire_skipped", (e) => e.uid === bPc1.uid)), "updated client: replacing while another PC is on the account answers retire_skipped");
check(!a1.has("retired"), "no retirement was recorded");
const bw = await bPc2.reconnect();
check(bw !== null && bw.friends.some((f) => f.uid === friendB.uid), "the other PC keeps its account and its friends");
check(bPc2.closeCode !== 4005, "the other PC is not told its account was replaced (no 4005)");
check((await bPc3.connect()) === null && bPc3.closeCode === 4003, "the PC that left no longer holds a working credential");
// a PC that last used the shared secret BEFORE this PC enrolled still counts (legacy-born account)
const cRoot = rnd(52), cUid = rnd(26);
const cLegacy = new Pc(cUid, cRoot, { dev: false }); all.push(cLegacy); await cLegacy.connect();
const cNew = new Pc(cUid, cRoot, { pc: "pc-c-new-001" }); all.push(cNew); await cNew.connectAdopt();
const a3 = await newAccount();
a3.send({ type: "retire_old", uid: cUid, secret: cNew.secret });
check(await a3.wait(() => a3.has("retire_skipped")), "a PC that has not updated yet counts, even if it last connected before this PC enrolled");
check((await cLegacy.connect()) !== null, "...and that PC keeps working");
// a PC on the shared secret that replaces: shared while the shared secret is alive, even with no device rows
const a3b = await newAccount({ dev: false });
a3b.send({ type: "retire_old", uid: cUid, secret: cRoot });
check(await a3b.wait(() => a3b.has("error", (e) => e.detail === "retired-elsewhere")), "a caller on the shared secret does not retire an account whose shared secret is alive");
const lUid = rnd(26), lRoot = rnd(52);
const lonely = new Pc(lUid, lRoot, { dev: false }); all.push(lonely); await lonely.connect();
const a3c = await newAccount({ dev: false });
a3c.send({ type: "retire_old", uid: lUid, secret: lRoot });
check(await a3c.wait(() => a3c.has("error", (e) => e.detail === "retired-elsewhere")), "...also for an account with no device rows at all");
check((await lonely.connect()) !== null, "...so that PC keeps working");
// an account born with an up-to-date client, only PC: a replace still retires it and moves the friends
const dPc = await newAccount({ pc: "pc-d-only-001" });
const dFriend = await newAccount(); await befriend(dPc, dFriend);
const a4 = await newAccount();
a4.send({ type: "retire_old", uid: dPc.uid, secret: dPc.secret });
check(await a4.wait(() => a4.has("retired", (e) => e.uid === dPc.uid)), "an up-to-date single-PC account is still retired by a replace");
check((await a4.reconnect()).friends.some((f) => f.uid === dFriend.uid), "...and its friends moved");
// ...but once a PC on the shared secret shows up, it is shared
const mRoot = rnd(52), mUid = rnd(26);
const mNew = new Pc(mUid, mRoot, { pc: "pc-m-new-001" }); all.push(mNew); await mNew.connectAdopt();
const mLegacy = new Pc(mUid, mRoot, { dev: false }); all.push(mLegacy); await mLegacy.connect();
const a5 = await newAccount();
a5.send({ type: "retire_old", uid: mUid, secret: mNew.secret });
check(await a5.wait(() => a5.has("retire_skipped")), "an up-to-date account is shared as soon as a PC on the shared secret connects");

// ---- 6. account codes seal a recovery secret ------------------------------------------------------------------------
const eRoot = rnd(52), eUid = rnd(26);
const e0 = new Pc(eUid, eRoot, { dev: false }); all.push(e0); await e0.connect();
const e1 = new Pc(eUid, eRoot, { pc: "pc-e-one-001" }); all.push(e1); await e1.connectAdopt();
const e2 = new Pc(eUid, eRoot, { pc: "pc-e-two-002" }); all.push(e2); await e2.connectAdopt();
let m1 = await link("/link/recovery", { uid: eUid, secret: e1.secret });
check(m1.status === 200 && /^[a-z2-7]{52}$/.test(m1.j.secret), "/link/recovery mints a secret for a device");
check((await link("/link/recovery", { uid: eUid, secret: rnd(52) })).status === 403, "/link/recovery refuses a wrong secret");
const newPc = new Pc(eUid, m1.j.secret, { pc: "pc-e-new-003" }); all.push(newPc);
const wn = await newPc.connectAdopt();
check(wn && wn.device, "a new PC that redeemed the code enrols its own credential");
const m2 = await link("/link/recovery", { uid: eUid, secret: e1.secret });
const m3 = await link("/link/recovery", { uid: eUid, secret: e1.secret });
const probe = (s) => { const p = new Pc(eUid, s, { dev: false }); all.push(p); return p.connect(); };
check((await probe(m3.j.secret)) !== null && (await probe(m2.j.secret)) !== null, "the two newest account-code secrets work");
check((await probe(m1.j.secret)) === null, "the third newest replaced the oldest");
// an enrolment without a valid PC label adds no row
const before = (await devicesOf(e1)).devices.length;
for (const bad of ["", "x", "has space!", "a".repeat(80)]) { const nb = new Pc(eUid, m3.j.secret, { pc: bad }); all.push(nb); const w = await nb.connect(); check(w && !w.device, `no PC label "${bad.slice(0, 6)}": no credential issued`); nb.close(); }
check((await devicesOf(e1)).devices.length === before, "...and no row was added");
// signing a PC out kills the shared secret and every old code (so it cannot come back with them)
e1.send({ type: "devices" });
const e2id = (await devicesOf(e1)).devices.find((d) => d.pc === "pc-e-two-002").id;
e1.events = []; e1.send({ type: "revoke_device", id: e2id }); await e1.wait(() => e1.has("device_revoked", (e) => e.ok));
check((await probe(m3.j.secret)) === null && (await probe(eRoot)) === null, "after a lock-out the old account codes and the shared secret are dead");
check((await newPc.connect()) !== null, "an enrolled PC keeps working after another PC's lock-out");
check(!e1.has("account_code"), "no new account code was made without a click");
const m4 = await link("/link/recovery", { uid: eUid, secret: e1.secret });
const e3 = new Pc(eUid, m4.j.secret, { pc: "pc-e-fresh-04" }); all.push(e3);
check(m4.status === 200 && (await e3.connectAdopt()) !== null && e3.secret !== m4.j.secret, "a new account code made afterwards works on a fresh PC");
// lock out every other PC
await e1.reconnect();
e1.events = []; e1.send({ type: "revoke_others" });
check(await e1.wait(() => e1.has("others_revoked", (e) => e.ok)), "revoke_others answers ok");
check((await probe(m4.j.secret)) === null, "old account codes are dead after revoke_others");
check((await newPc.connect()) === null && (await e3.connect()) === null, "other PCs are locked out");
check((await e1.reconnect()) !== null, "the PC that asked keeps working");
const m5 = await link("/link/recovery", { uid: eUid, secret: e1.secret });
check(m5.status === 200 && (await probe(m5.j.secret)) !== null, "a new account code can be made afterwards");
const e0w = await e0.connect(); check(e0w === null && e0.closeCode === 4003, "a PC that never updated is refused with 4003 (shows 'sign in again')");
// a PC without its own credential cannot lock others out
const fRoot = rnd(52), fUid = rnd(26);
const f0 = new Pc(fUid, fRoot, { dev: false }); all.push(f0); await f0.connect();
f0.events = []; f0.send({ type: "revoke_others" }); await f0.wait(() => f0.has("others_revoked"));
check(f0.get("others_revoked").ok === false, "a PC on the shared secret cannot use revoke_others");
check((await f0.reconnect()) !== null, "...and nothing was locked");

// ---- 7. sign out ------------------------------------------------------------------------------------------------------
const g1 = await newAccount({ pc: "pc-g-one-001" });
const gOld = g1.secret;
g1.events = []; g1.send({ type: "sign_out_device" });
check(await g1.wait(() => g1.has("signed_out")), "sign_out_device answers");
await sleep(200);
const gp = new Pc(g1.uid, gOld, { dev: false }); all.push(gp);
check((await gp.connect()) === null && gp.closeCode === 4003, "a leftover copy of the signed-out PC's identity.json is dead");

// ---- 8. release username -----------------------------------------------------------------------------------------------
const h = await newAccount({ pc: "pc-h-one-001" });
const uname = "Zed" + rnd(6);
h.events = []; h.send({ type: "set_username", name: uname });
check(await h.wait(() => h.has("username_result", (e) => e.ok)), "claim a username");
h.events = []; h.send({ type: "release_username" });
check(await h.wait(() => h.has("username", (e) => e.username === null)) && await h.wait(() => h.has("username_released", (e) => e.ok)), "release_username frees the name and answers ok");
const other = await newAccount(); other.events = []; other.send({ type: "set_username", name: uname });
await other.wait(() => other.has("username_result"));
check(other.get("username_result").ok === false, "a released name is held (7-day rule), so a stranger cannot take it at once");
h.send({ type: "set_username", name: uname }); await h.wait(() => h.has("username_result", (e) => e.ok), 3000);
check(h.has("username_result", (e) => e.ok), "the person who released it can take it back inside the hold");

// ---- 9. delete account -------------------------------------------------------------------------------------------------
const k = await newAccount({ pc: "pc-k-one-001" });
const kf = await newAccount(); await befriend(k, kf);
k.send({ type: "set_username", name: "Del" + rnd(6) }); await k.wait(() => k.has("username_result", (e) => e.ok));
k.events = []; k.send({ type: "delete_account" });
check(await k.wait(() => k.has("error", (e) => e.detail === "confirm-required")), "delete needs confirm:true");
k.events = []; k.send({ type: "delete_account", confirm: true, typed: "nope" });
check(await k.wait(() => k.has("error", (e) => e.detail === "confirm-mismatch")), "delete needs the typed username or friend code");
k.events = []; k.send({ type: "delete_account", confirm: true, typed: codeOf(k.uid).toLowerCase() });
check(await k.wait(() => k.has("account_deleted")), "delete with the typed friend code is accepted");
check(await k.wait(() => k.closeCode === 4005), "the deleted account's sockets are closed (4005)");
await sleep(2500);
const kw = await kf.reconnect();
check(kw && !kw.friends.some((f) => f.uid === k.uid), "the friend's list no longer contains the deleted account");
const k2 = new Pc(k.uid, k.secret); all.push(k2);
check((await k2.connect()) === null && k2.closeCode === 4005, "the deleted account can never connect again");

for (const u of all) u.close();
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
