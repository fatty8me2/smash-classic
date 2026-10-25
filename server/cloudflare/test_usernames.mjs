// Username registry tests. Pure normalization runs anywhere; the live part needs a LOCAL worker:
//   npx wrangler dev --ip 127.0.0.1 --port 10200 --persist-to C:\rhq\10200   (tracked .dev.vars: UNAME_HOLD_MS=4000, link TTL 3 s)
//   node test_usernames.mjs [http://127.0.0.1:10200]
import { normalizeUsername, lookupKey } from "./src/usernames.js";

const BASE = process.argv[2] || "http://127.0.0.1:10200";
if (!/^https?:\/\/(127\.0\.0\.1|localhost)/.test(BASE)) { console.error("local worker only"); process.exit(2); }
const WS = BASE.replace(/^http/, "ws");
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const rnd = (n, a = B32) => Array.from({ length: n }, () => a[Math.floor(Math.random() * a.length)]).join("");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? " " + extra : ""}`); if (!cond) failures++; };
// unique per run so a re-run against persisted state does not collide
const RUN = rnd(4, "abcdefghjkmnpqrtuvwxy");
const nm = (base) => `${base}${RUN}`.slice(0, 16);

// ---------------- pure ----------------
const key = (s, o) => normalizeUsername(s, o).key;
check("case-insensitive", key("Kai99") === key("kAI99"));
check("separators ignored", key("a_b.c-d1") === key("abcd1"));
check("digit look-alikes folded: 1->l, 5->s", key("B1ll") === key("Blll") && key("Ro5e") === key("Rose"));
check("i and l are NOT folded", key("Kai99") !== key("Kal99") && key("BIll") !== key("Bll1"));
check("O/0 folded", key("R0bot9") === key("Robot9"));
check("rn/m and vv/w are NOT folded", key("corner") !== key("comer") && key("vvolf") !== key("wolf"));
check("NFKC fullwidth folds to ascii", normalizeUsername("ｋａｉｘ９").display === "kaix9");
check("non-ascii homoglyph rejected", normalizeUsername("Kаi99").reason === "invalid-chars");   // Cyrillic a
check("length 3..16", normalizeUsername("ab").reason === "too-short" && normalizeUsername("a".repeat(17)).reason === "too-long" && normalizeUsername("abc").ok && normalizeUsername("a".repeat(16)).ok);
check("shape: no leading/trailing/double separators", ["_abc", "abc_", "a__b", "a..b"].every((n) => normalizeUsername(n).reason === "bad-shape"));
check("reserved words (incl. look-alikes)", ["admin", "Adm1n", "RetroHub", "m0derator", "SYSTEM", "r_e_t_r_o_h_u_b"].every((n) => normalizeUsername(n).reason === "reserved"));
check("profanity", normalizeUsername("xx_fuck_xx").reason === "profanity" && normalizeUsername("Sh1tlord").reason === "profanity");
check("friend-code lookalike", normalizeUsername("RH-7KQ2-M4XD").reason === "looks-like-code");
check("qa- reserved for test accounts", normalizeUsername("qa-bob").reason === "qa-only" && normalizeUsername("qa-bob", { test: true }).ok && normalizeUsername("bobby", { test: true }).reason === "test-only-qa");
check("lookupKey matches claim key", lookupKey("KAI99") === key("Kai99") && lookupKey("x") === null);

// ---------------- live helpers ----------------
class Client {
  constructor(acct) { this.acct = acct; this.msgs = []; this.waiters = []; this.closed = null; }
  open(helloExtra = {}) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${WS}/friends?uid=${this.acct.uid}`);
      this.ws = ws;
      ws.onopen = () => ws.send(JSON.stringify({ type: "hello", secret: this.acct.secret, name: this.acct.name, version: "t", ...helloExtra }));
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.type === "welcome") { this.welcome = m; resolve(m); }
        this.msgs.push(m);
        this.waiters = this.waiters.filter((w) => { if (w.pred(m)) { w.res(m); return false; } return true; });
      };
      ws.onclose = (ev) => { this.closed = ev.code; if (!this.welcome) resolve(null); this.waiters.forEach((w) => w.res(null)); };
      ws.onerror = () => reject(new Error("ws error"));
      setTimeout(() => reject(new Error("welcome timeout")), 10000);
    });
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  wait(pred, ms = 8000) {
    const hit = this.msgs.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((res) => { const w = { pred, res }; this.waiters.push(w); setTimeout(() => res(null), ms); });
  }
  async ask(o, type = "username_result") {   // send and wait for the next reply of `type` after now
    const n = this.msgs.length;
    this.send(o);
    for (let i = 0; i < 400; i++) {
      const m = this.msgs.slice(n).find((x) => x.type === type);
      if (m) return m;
      await sleep(25);
    }
    return null;
  }
  close() { try { this.ws.close(); } catch {} }
}
const acct = (name) => ({ uid: rnd(26), secret: rnd(52), name });
async function mk(name, extra = { no_auto_username: true }) { const c = new Client(acct(name)); await c.open(extra); return c; }
async function post(path, body) {
  const res = await fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": rnd(12, "0123456789abcdef") }, body: JSON.stringify(body) });
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
const all = [];
const keep = (c) => { all.push(c); return c; };

// ---------------- 1. concurrent claims ----------------
{
  const variants = [nm("RaceKing"), nm("raceKING"), nm("Race_King"), nm("Race.King"), nm("RaceK1ng").replace("K1", "KI"), nm("race-king"), nm("RACEKING"), nm("rAcEkInG")];
  const cs = [];
  for (let i = 0; i < variants.length; i++) cs.push(keep(await mk(`Raceplayer${i}`)));
  const results = await Promise.all(cs.map((c, i) => c.ask({ type: "set_username", name: variants[i] })));
  const oks = results.filter((r) => r && r.ok);
  const taken = results.filter((r) => r && !r.ok && r.reason === "username-taken");
  check("concurrent claims: exactly one winner", oks.length === 1, `ok=${oks.length}`);
  check("concurrent claims: all others get username-taken", taken.length === variants.length - 1, `taken=${taken.length}`);
  const winner = cs[results.findIndex((r) => r && r.ok)];
  const again = await winner.ask({ type: "username_check", name: variants[0] });
  check("winner sees its own name as yours", again.ok && again.yours === true);
}

// ---------------- 2. availability check + rate limit ----------------
{
  const a = keep(await mk("Checker"));
  const free = await a.ask({ type: "username_check", name: nm("FreeName") });
  check("check: fresh name available", free.ok === true && free.username === nm("FreeName"));
  const bad = await a.ask({ type: "username_check", name: "admin" });
  check("check: reserved", !bad.ok && bad.reason === "username-reserved");
  const inv = await a.ask({ type: "username_check", name: "no spaces!" });
  check("check: invalid chars", !inv.ok && inv.reason === "username-invalid");
  let limited = false;
  for (let i = 0; i < 45 && !limited; i++) { const r = await a.ask({ type: "username_check", name: nm("Probe") + i }); limited = !!r && r.reason === "rate-limited"; }
  check("check: rate limited", limited);
}

// ---------------- 3. rename + hold ----------------
{
  const A = keep(await mk("Holder")), B = keep(await mk("Sniper"));
  const n1 = nm("HoldOne"), n2 = nm("HoldTwo");
  check("claim first name", (await A.ask({ type: "set_username", name: n1 })).ok);
  check("rename ok", (await A.ask({ type: "set_username", name: n2 })).ok);
  const snipe = await B.ask({ type: "set_username", name: n1 });
  check("old name is held (cannot be sniped)", !snipe.ok && snipe.reason === "username-taken" && snipe.detail === "held", JSON.stringify(snipe));
  const chk = await B.ask({ type: "username_check", name: n1 });
  check("check shows held name unavailable", !chk.ok);
  const back = await A.ask({ type: "set_username", name: n1 });
  check("old owner can take it back during the hold", back.ok);
  check("the other name is now held for A", !(await B.ask({ type: "set_username", name: n2 })).ok);
  await A.ask({ type: "set_username", name: nm("HoldThree") });
  await sleep(4600);   // UNAME_HOLD_MS=4000
  const after = await B.ask({ type: "set_username", name: n1 });
  check("name is free after the hold expires", after.ok, JSON.stringify(after));
  const rn = await B.ask({ type: "rename", name: "Hax" }, "error");
  check("plain rename refused once a username is claimed", rn && rn.detail === "use-set-username");
}

// ---------------- 4. migration collisions ----------------
{
  const older = keep(await mk("OldPlayer")), newer = keep(await mk("NewPlayer"));   // registered in this order
  const shared = nm("Dupname");
  newer.close(); await sleep(150);
  const newer2 = keep(new Client(newer.acct)); const w2 = await newer2.open({ name: shared });   // legacy hello: newer claims first
  newer2.acct.name = shared; newer.acct.name = shared;
  check("legacy hello auto-claims the display name", w2.username === shared && w2.username_status === "ok");
  older.close(); await sleep(150);
  older.acct.name = shared.toLowerCase();
  const o2 = keep(new Client(older.acct)); const wo = await o2.open({});
  check("older account wins the collision", wo.username_status === "ok" && wo.username.toLowerCase() === shared.toLowerCase(), JSON.stringify([wo.username, wo.username_status]));
  const push = await newer2.wait((m) => m.type === "username" && m.status === "needs_new_name");
  check("displaced account is told live (needs_new_name)", !!push);
  newer2.close(); await sleep(150);
  const n3 = keep(new Client(newer.acct)); const wn = await n3.open({});
  check("displaced account gets needs_new_name on next hello", wn.username === null && wn.username_status === "needs_new_name");
  check("needs_new_name account can pick a new name", (await n3.ask({ type: "set_username", name: nm("Fresh") })).ok);

  // newer legacy loses to an older holder; explicit claims are never displaced
  const x = keep(await mk("OldX")), y = keep(await mk("NewY")), z = keep(await mk("OldZ"));
  const strong = nm("Strong");
  check("explicit claim", (await y.ask({ type: "set_username", name: strong })).ok);
  x.close(); await sleep(150);
  x.acct.name = strong;
  const x2 = keep(new Client(x.acct)); const wx = await x2.open({});
  check("older legacy cannot displace an explicit claim", wx.username === null && wx.username_status === "needs_new_name");
  z.close(); await sleep(150);
  z.acct.name = "ab";
  const z2 = keep(new Client(z.acct)); const wz = await z2.open({});
  check("invalid legacy name -> needs_new_name", wz.username_status === "needs_new_name");
  const nonLegacy = keep(await mk("PlainNew", { no_auto_username: true }));
  check("no_auto_username hello leaves the account unclaimed", nonLegacy.welcome.username === null && nonLegacy.welcome.username_status === "none");
}

// ---------------- 5. add friend by username ----------------
{
  const A = keep(await mk("AddTarget")), B = keep(await mk("Adder"));
  const nA = nm("Target"), nB = nm("Adding");
  await A.ask({ type: "set_username", name: nA }); await B.ask({ type: "set_username", name: nB });
  B.send({ type: "add_friend", username: nA.toUpperCase() });
  const req = await A.wait((m) => m.type === "request" && m.dir === "in");
  check("add by username (case-insensitive) reaches the target", !!req && req.req.name === nB, JSON.stringify(req && req.req));
  B.send({ type: "add_friend", code: "Nobody" + RUN });
  const e = await B.wait((m) => m.type === "error" && m.reason === "unknown-code" && m.detail === "unknown-username");
  check("unknown username -> unknown-code/unknown-username", !!e);
  A.send({ type: "accept", uid: B.acct.uid });
  const fa = await A.wait((m) => m.type === "friend_added");
  check("friend list shows the username", !!fa && fa.friend.name === nB);
  const C = keep(await mk("CodeAdder"));
  C.send({ type: "add_friend", code: nB });   // code field carrying a username
  check("code field with a non-code string is treated as a username", !!(await B.wait((m) => m.type === "request" && m.dir === "in")));
  const D = keep(await mk("CodeUser"));
  D.send({ type: "add_friend", code: A.welcome.code });
  check("friend code add still works", !!(await A.wait((m) => m.type === "request" && m.req.uid === D.acct.uid)));
}

// ---------------- 6. link-code flow, two devices ----------------
{
  const dev1 = keep(await mk("LinkOwner")); const un = nm("Linker");
  await dev1.ask({ type: "set_username", name: un });
  const bad = await post("/link/create", { uid: dev1.acct.uid, secret: rnd(52) });
  check("link/create needs the account secret", bad.status === 403);
  const c1 = await post("/link/create", { uid: dev1.acct.uid, secret: dev1.acct.secret });
  check("link/create returns code + username", c1.status === 200 && /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(c1.data.code) && c1.data.username === un, JSON.stringify(c1.data));
  const c2 = await post("/link/create", { uid: dev1.acct.uid, secret: dev1.acct.secret });
  const bundle = { salt: "c2FsdHNhbHRzYWx0c2FsdA==", iv: "aXZpdml2aXZpdml2", ct: "Y2lwaGVydGV4dGJsb2I=" };
  const p1 = await post("/link/put", { uid: dev1.acct.uid, secret: dev1.acct.secret, code: c1.data.code, ...bundle });
  check("a newer code revokes the previous open code", p1.status === 404, `status=${p1.status}`);
  const p2 = await post("/link/put", { uid: dev1.acct.uid, secret: dev1.acct.secret, code: c2.data.code, ...bundle });
  check("current code accepts the bundle", p2.status === 200);
  const r1 = await post("/link/redeem", { code: c2.data.code });
  check("redeem returns bundle and the username", r1.status === 200 && r1.data.ct === bundle.ct && r1.data.username === un);
  check("code is single use", (await post("/link/redeem", { code: c2.data.code })).status === 404);
  // device 2 now holds the same uid+secret and connects while device 1 stays online
  const dev2 = keep(new Client({ ...dev1.acct, name: "Whatever The PC Says" })); const w = await dev2.open({});
  check("device 2 sees the username", w.username === un && w.username_status === "ok");
  check("device 1 still connected (both online at once)", dev1.closed === null && dev2.closed === null);
  const n2 = nm("LinkerTwo");
  await dev2.ask({ type: "set_username", name: n2 });
  const pushed = await dev1.wait((m) => m.type === "username" && m.username === n2);
  check("rename on device 2 reaches device 1", !!pushed);
  const un3 = await dev1.ask({ type: "username_check", name: n2 });
  check("one account, one name on both devices", un3.ok && un3.yours);
}

// ---------------- 7. test-account restrictions ----------------
{
  const t = keep(await mk("tester-account", { test: true, no_auto_username: true }));
  const real = await t.ask({ type: "set_username", name: nm("RealLooking") });
  check("test account cannot claim a real name", !real.ok && real.reason === "username-test");
  const okq = await t.ask({ type: "set_username", name: `qa-${nm("t")}` });
  check("test account can claim qa- names", okq.ok);
  const r = keep(await mk("RealGuy"));
  const rq = await r.ask({ type: "set_username", name: `qa-${nm("x")}` });
  check("real account cannot claim qa- names", !rq.ok && rq.reason === "username-test");
  const t2 = keep(await mk(`qa-legacy-${RUN}`, { test: true }));
  check("test accounts skip legacy migration", t2.welcome.username === null && t2.welcome.username_status === "none");
}

// ---------------- 8. release / delete ----------------
{
  const A = keep(await mk("Leaver")), B = keep(await mk("Taker"));
  const n = nm("Leaving");
  await A.ask({ type: "set_username", name: n });
  A.send({ type: "release_username" });
  check("release pushes username=null", !!(await A.wait((m) => m.type === "username" && m.username === null)));
  check("released name is still held", !(await B.ask({ type: "set_username", name: n })).ok);
  const C = keep(await mk("Quitter")); const n2 = nm("Quitting");
  await C.ask({ type: "set_username", name: n2 });
  const err = await C.ask({ type: "delete_account" }, "error");
  check("delete_account needs confirm", err && err.detail === "confirm-required");
  C.send({ type: "delete_account", confirm: true });
  await sleep(500);
  check("delete_account closes the socket (4005)", C.closed === 4005, `closed=${C.closed}`);
  check("deleted account's name is free immediately (no hold)", (await B.ask({ type: "set_username", name: n2 })).ok);
  const again = keep(new Client(C.acct)); await again.open({}).catch(() => {});
  check("deleted uid cannot reconnect", again.closed === 4005);
}

// ---------------- 9. identity retire moves the username ----------------
{
  const oldA = keep(await mk("OldIdentity")); const n = nm("Moving");
  await oldA.ask({ type: "set_username", name: n });
  const newA = keep(await mk("NewIdentity"));
  newA.send({ type: "retire_old", uid: oldA.acct.uid, secret: oldA.acct.secret });
  const moved = await newA.wait((m) => m.type === "username" && m.username === n);
  check("retire_old moves the username to the new uid", !!moved);
  const chk = await newA.ask({ type: "username_check", name: n });
  check("new uid owns the name", chk.ok && chk.yours);
}

all.forEach((c) => c.close());
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
