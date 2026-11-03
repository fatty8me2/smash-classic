// "A ban blocks RetroHub entirely": approval mode ON by default with grandfathering, the reason codes every refusal carries, and the
// strict-rooms switch. LOCAL wrangler only. Needs the server started with REG_APPROVAL_DEFAULT unset/1 (approval default ON), e.g.
//   ADMIN_UID=aaaa... REG_APPROVAL_DEFAULT:1 REG_TOUCH_MS:0 REG_PENDING_RECHECK_MS:300 STRICT_CACHE_MS:0 STRICT_IDENT_MS:1500 TEST_REG:1 ALLOW_TEST_FLAG:1
//   node test_admin_lockout.mjs [ws://127.0.0.1:PORT]       (run_all_tests.mjs does all of this)
import { ADMIN, ADMIN_SECRET, rnd, sleep, checker, connect, mk, again, ask, untilTrue } from "./admin_test_lib.mjs";
import { createHash, createHmac } from "node:crypto";

const base = process.argv[2] || "ws://127.0.0.1:8791";
const http = base.replace("ws", "http");
const { st, check } = checker();
const sha = (s) => createHash("sha256").update(s).digest("hex");
const nm = (p) => p + rnd(5);
const reg = async (op, body) => (await fetch(`${http}/__test/reg?op=${op}`, { method: "POST", body: JSON.stringify(body) })).json();
const rowOf = async (u) => (await reg("t_row", { uid: u.uid })).row;

// ---- wire helpers -------------------------------------------------------------------------------------------------------------
const sign = (acct, path) => { const ts = Date.now(); const msg = `GET\n${path}\n${ts}\n-\n-\n-\n-\n-`; return `RHSIG uid=${acct.uid},ts=${ts},sig=${createHmac("sha256", sha(acct.secret)).update(msg).digest("hex")}`; };
const saves = async (u) => { const r = await fetch(http + "/saves/v2/status", { headers: { Authorization: sign(u, "/saves/v2/status") } }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const savesBadSig = async (u) => { const r = await fetch(http + "/saves/v2/status", { headers: { Authorization: sign({ uid: u.uid, secret: "wrong-secret-wrong-secret-xx" }, "/saves/v2/status") } }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const linkCall = async (path, u, extra = {}) => { const r = await fetch(http + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ uid: u.uid, secret: u.secret, ...extra }) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const rcode = () => Array.from({ length: 6 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join("");

/* One /hub seat. who: account to ident as (null = anonymous), nopair, role. Resolves after `ms` with what happened. */
function seat(room, { who = null, nopair = false, role = "join", ms = 2600, name = "x" } = {}) {
  return new Promise((resolve) => {
    const out = { code: 0, msgs: [], welcome: false, open: true };
    const ws = new WebSocket(`${base}/hub?room=${room}&role=${role}&name=${name}&caps=hostmig,reasons`);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data); out.msgs.push(m);
      if (m.type === "welcome") { out.welcome = true; if (who) ws.send(JSON.stringify({ type: "ident", uid: who.uid, secret: who.secret, ...(nopair ? { nopair: true } : {}) })); }
    };
    ws.onclose = (e) => { out.code = e.code; out.open = false; };
    out.close = () => { try { ws.close(); } catch { /* closed */ } };
    setTimeout(() => resolve(out), ms);
  });
}
/* The seat was refused/closed: the error frame (reason) arrived. A close issued from the room alarm completes its handshake late on the
 * local workerd, so the frame is the reliable signal; the close code is only asserted where it is sent from a message handler. */
const told = (r, reason) => r.msgs.some((m) => m.type === "error" && (!reason || m.reason === reason));
const settings = async (adm, set) => (await ask(adm, { type: "admin_settings", ...(set ? { set } : {}) }, "admin_settings")).settings;

// ================= 1. defaults: approval ON, grandfathering from the registry's first run ====================================
const E = await mk(base, nm("Old"));
check(E.outcome === "welcome", "an account that existed at the cutoff connects");
const adm = await connect(base, ADMIN, ADMIN_SECRET, "Owner");
check(adm.outcome === "welcome" && adm.welcome.admin === true, "the admin account connects (never gated, even with approval ON)");
let s = await settings(adm);
check(s.approval === true && s.cutoff > 0, "approval defaults to ON with a default cutoff (the registry's first run)");
check(s.strict_rooms === false, "strict rooms default to OFF");
await sleep(60);

// an account that is not new: its registry row is forgotten (as if the registry had never seen it) -> still ok when seen first
await reg("t_cutoff", { at: Date.now() });   // "the deploy moment": E.created is before it
await sleep(30);
await reg("t_delete", { uid: E.uid });
check((await rowOf(E)) === null, "setup: the registry has no row for the old account");
const E2 = await again(E);
check(E2.outcome === "welcome", "existing account first seen by the registry AFTER the deploy stays ok (grandfathered)");
const er = await rowOf(E);
check(er && er.status === "ok" && er.by === "grandfathered", "...recorded as grandfathered");

// an old account whose hub reports no creation time at all is grandfathered too
const noTime = rnd(26);
const nt = await reg("t_touch", { uid: noTime, name: "NoTime", created: 0 });
check(nt.status === "ok", "no creation time (0) is treated as an old account: ok");
const stale = rnd(26);
check((await reg("t_touch", { uid: stale, name: "Stale", created: Date.now() - 86400000 })).status === "ok", "created a day before the cutoff: ok");
check((await reg("t_touch", { uid: rnd(26), name: "Fresh", created: Date.now() + 5000 })).status === "pending", "created after the cutoff: pending");

// a brand-new account is held, with a prompt readable reason and no welcome
const t0 = Date.now();
const N = await mk(base, nm("Newbie"));
check(N.outcome === "error" && N.error.reason === "pending-approval" && !N.welcome, "brand-new account: error {reason:'pending-approval'}, no welcome");
check(Date.now() - t0 < 3000, "...answered promptly (the client can lock its UI at once)");
check((await rowOf(N)).status === "pending", "...and queued as pending");

// ================= 2. every route refuses a pending account, with the reason ================================================
const sp = await saves(N);
check(sp.status === 403 && sp.body.reason === "pending-approval" && sp.body.error === "pending-approval", "saves: pending -> 403 reason pending-approval");
check((await savesBadSig(N)).status === 401 && (await savesBadSig(N)).body.reason === undefined, "saves: a wrong signature learns nothing about the account (401, no reason)");
for (const path of ["/link/create", "/link/keep"]) {
  const r = await linkCall(path, N, path === "/link/keep" ? { box: "a".repeat(64), salt: "c2FsdHNhbHRzYWx0", iv: "aXZpdml2aXZp", ct: "Y2lwaGVydGV4dA==" } : {});
  check(r.status === 403 && r.body.reason === "pending-approval", `${path}: pending -> 403 reason pending-approval`);
}
const lput = await linkCall("/link/put", N, { code: "ABCD-EFGH", salt: "c2FsdHNhbHRzYWx0", iv: "aXZpdml2aXZp", ct: "Y2lwaGVydGV4dA==" });
check(lput.status === 403 && lput.body.reason === "pending-approval", "/link/put: pending -> 403 reason pending-approval");
const lbad = await fetch(http + "/link/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ uid: N.uid, secret: "wrong-secret-wrong-secret-xx" }) });
check(lbad.status === 403 && (await lbad.json()).reason === undefined, "link: a wrong secret learns nothing about the account");
const R = rcode();
const hostAcct = await mk(base, nm("Host"));   // pending too: cannot host as a proven account
const sPend = await seat(R, { who: N, role: "host", ms: 1200 });
check(sPend.code === 4012 && sPend.msgs.some((m) => m.type === "error" && m.reason === "pending-approval"), "room: pending account's seat gets error pending-approval, then close 4012");
await ask(adm, { type: "admin_approve", uid: hostAcct.uid }, "admin_result");
await sleep(300);

// ================= 3. owner toggles approval off / on =======================================================================
s = await settings(adm, { approval: false });
check(s.approval === false, "the owner can switch approval off");
const open1 = await mk(base, nm("Open"));
check(open1.outcome === "welcome", "approval off: a new account connects");
check((await again(N)).outcome === "welcome", "approval off: the waiting account is let in");
s = await settings(adm, { approval: true });
check(s.approval === true && s.cutoff >= Date.now() - 5000, "approval back on: the cutoff moves to now");
check((await again(open1)).outcome === "welcome", "...accounts created while it was off keep working");
const N2 = await mk(base, nm("Late"));
check(N2.outcome === "error" && N2.error.reason === "pending-approval", "...and a newer account is held again");

// ================= 4. a banned account is refused on every route, with account-unavailable ==================================
const B = await mk(base, nm("Banned")); // pending now; the owner bans it outright (a ban always wins over pending)
await settings(adm, { approval: false });
const BB = await mk(base, nm("Troll"));
await settings(adm, { approval: true });
check(BB.outcome === "welcome", "setup: the account to ban is online");
const bn = await ask(adm, { type: "admin_ban", uid: BB.uid }, "admin_result");
check(bn && bn.ok && bn.status === "banned", "setup: banned");
await untilTrue(() => BB.closed === 4010);
const b1 = await again(BB);
check(b1.outcome === "error" && b1.error.reason === "account-unavailable" && !b1.welcome, "friends hello: error {reason:'account-unavailable'}, no welcome");
const sb = await saves(BB);
check(sb.status === 403 && sb.body.reason === "account-unavailable", "saves: banned -> 403 reason account-unavailable");
const lb = await linkCall("/link/create", BB);
check(lb.status === 403 && lb.body.reason === "account-unavailable", "link: banned -> 403 reason account-unavailable");
const sBan = await seat(rcode(), { who: BB, role: "host", ms: 1200 });
check(sBan.code === 4010 && sBan.msgs.some((m) => m.type === "error" && m.reason === "account-unavailable"), "room (host): banned ident -> error account-unavailable, close 4010");
const sBanSpec = await (async () => {
  const room = rcode();
  const h = await seat(room, { who: hostAcct, role: "host", ms: 600 });
  const w = await seat(room, { who: BB, role: "watch", ms: 1200 });
  h.close();
  return w;
})();
check(sBanSpec.code === 4010, "room (watcher): a banned spectator is closed 4010 at ident too (got " + sBanSpec.code + ")");
// re-registering is covered by approval mode: a brand-new uid for the same person is pending
const again2 = await mk(base, nm("Troll"));
check(again2.outcome === "error" && again2.error.reason === "pending-approval", "the same person on a brand-new account is held by approval mode");

// ================= 5. strict rooms ===========================================================================================
const roomOff = rcode();
const hOff = await seat(roomOff, { role: "host", ms: 300 });
const jOff = await seat(roomOff, { ms: 4200 });
check(jOff.open && hOff.open, "strict OFF (default): anonymous seats are never closed");
hOff.close(); jOff.close();

s = await settings(adm, { strict_rooms: true });
check(s.strict_rooms === true, "the owner can switch strict rooms on");
const room = rcode();
const okAcct = await mk(base, nm("Ok")).catch(() => null);   // pending (approval is on): must not count as a proven account
const good = open1;   // an ok account
const results = await Promise.all([
  seat(room, { who: good, role: "host", ms: 4400 }),
  (async () => { await sleep(250); return seat(room, { ms: 4200 }); })(),                          // anonymous joiner
  (async () => { await sleep(250); return seat(room, { who: hostAcct, ms: 4200 }); })(),            // proven joiner
  (async () => { await sleep(250); return seat(room, { who: E, nopair: true, ms: 4200 }); })(),     // proven, no pairing
  (async () => { await sleep(250); return seat(room, { role: "watch", ms: 4200 }); })(),            // anonymous spectator
  (async () => { await sleep(250); return seat(room, { who: E, role: "watch", ms: 4200 }); })(),    // proven spectator
  (async () => { await sleep(250); return seat(room, { who: N2, ms: 4200 }); })(),                  // pending account
]);
const [rHost, rAnon, rProven, rNoPair, rAnonW, rProvenW, rPend] = results;
check(rHost.open && rHost.welcome, "strict: a proven host keeps its seat");
check(told(rAnon, "ident-required"), "strict: an anonymous joiner is told ident-required and closed 4013");
check(!told(rProven) && !told(rNoPair) && rProven.open && rNoPair.open, "strict: proven joiners (also {nopair:true}) keep their seats");
check(told(rAnonW, "ident-required"), "strict: an anonymous spectator is closed 4013");
check(!told(rProvenW) && rProvenW.open, "strict: a spectator that proves its account keeps its seat");
check(told(rPend, "pending-approval"), "strict: a pending account is closed 4012 pending-approval");
results.forEach((r) => r.close());
// "-N" game rooms are not enforced (their members came through a lobby)
const gRoom = rcode() + "-1";
const gHost = await seat(gRoom, { role: "host", ms: 2400 });
check(gHost.open && gHost.welcome, "strict: game rooms (-N) are not enforced");
gHost.close();
s = await settings(adm, { strict_rooms: false });
const room2 = rcode();
const off1 = await seat(room2, { role: "host", ms: 2400 });
check(off1.open, "strict switched back off: anonymous seats stay");
off1.close();

console.log(st.fails ? `\n${st.fails} FAILED` : "\nALL PASSED");
process.exit(st.fails ? 1 : 0);
