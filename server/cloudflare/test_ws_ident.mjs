// Smash Classic lobby (/ws) account gate: {type:"ident",uid,secret} like /hub. LOCAL wrangler only. Same server vars as test_admin_lockout.mjs.
//   node test_ws_ident.mjs [ws://127.0.0.1:PORT]       (run_all_tests.mjs does all of this)
import { ADMIN, ADMIN_SECRET, rnd, sleep, checker, connect, mk, ask } from "./admin_test_lib.mjs";

const base = process.argv[2] || "ws://127.0.0.1:8791";
const http = base.replace("ws", "http");
const { st, check } = checker();
const nm = (p) => p + rnd(5);
const reg = async (op, body) => (await fetch(`${http}/__test/reg?op=${op}`, { method: "POST", body: JSON.stringify(body) })).json();
const rcode = () => Array.from({ length: 6 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join("");
const settings = async (adm, set) => (await ask(adm, { type: "admin_settings", ...(set ? { set } : {}) }, "admin_settings")).settings;

/* One /ws seat. who = account to ident as (null = none). Resolves after ms with what happened (codes arrive late on local workerd: trust the frames). */
function seat(room, { who = null, secret = null, role = "join", ms = 2600, nopair = true } = {}) {
  return new Promise((resolve) => {
    const out = { code: 0, msgs: [], welcome: false, open: true };
    const ws = new WebSocket(`${base}/ws?room=${room}&role=${role}&v=2&hm=1`);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data); out.msgs.push(m);
      if (m.type === "welcome") { out.welcome = true; if (who) ws.send(JSON.stringify({ type: "ident", uid: who.uid, secret: secret ?? who.secret, ...(nopair ? { nopair: true } : {}) })); }
    };
    ws.onclose = (e) => { out.code = e.code; out.open = false; };
    out.close = () => { try { ws.close(); } catch { /* closed */ } };
    setTimeout(() => resolve(out), ms);
  });
}
const told = (r, reason) => r.msgs.some((m) => m.type === "error" && (!reason || m.reason === reason));
const errs = (r) => r.msgs.filter((m) => m.type === "error");

const adm = await connect(base, ADMIN, ADMIN_SECRET, "Owner");
check(adm.outcome === "welcome", "admin connects");
// accounts created before the cutoff are ok; after t_cutoff a new one is pending
const good = await mk(base, nm("Ok"));
const banned = await mk(base, nm("Ban"));
await sleep(60);
await reg("t_cutoff", { at: Date.now() });
await sleep(30);
const pend = await mk(base, nm("Pend"));
check(good.outcome === "welcome" && pend.outcome === "error" && pend.error.reason === "pending-approval", "setup: one approved, one pending account");
const bn = await ask(adm, { type: "admin_ban", uid: banned.uid }, "admin_result");
check(bn && bn.ok !== false, "setup: one banned account");
await sleep(100);

// ---- strict OFF: nothing changes for old clients ----
let s = await settings(adm);
check(s.strict_rooms === false, "strict rooms default OFF");
const r0 = rcode();
const h0 = await seat(r0, { role: "host", ms: 300 });
const j0 = await seat(r0, { ms: 3500 });
check(h0.welcome && j0.welcome && h0.open && j0.open && !told(j0), "strict OFF: seats without ident work exactly as before (no close after the deadline)");
h0.close(); j0.close();
const r1 = rcode();
const h1 = await seat(r1, { who: good, role: "host", ms: 300 });
const j1 = await seat(r1, { who: good, secret: "wrong-secret-wrong-secret-wrong", ms: 2500 });
check(j1.open && !told(j1), "strict OFF: a wrong secret is ignored (no reason revealed, seat keeps working)");
h1.close(); j1.close();
const r2 = rcode();
const hb = await seat(r2, { who: banned, role: "host", ms: 2000 });
check(told(hb, "account-unavailable") && hb.msgs.length && errs(hb).every((m) => m.reason === "account-unavailable"), "strict OFF: a banned account that identifies is told account-unavailable");
const r3 = rcode();
const hp = await seat(r3, { who: pend, role: "host", ms: 2000 });
check(told(hp, "pending-approval"), "strict OFF: a pending account that identifies is told pending-approval");
hb.close(); hp.close();

// ---- strict ON ----
s = await settings(adm, { strict_rooms: true });
check(s.strict_rooms === true, "owner switches strict rooms on");
const room = rcode();
const res = await Promise.all([
  seat(room, { who: good, role: "host", ms: 4000 }),
  (async () => { await sleep(250); return seat(room, { who: good, ms: 3800 }); })(),                           // approved joiner
  (async () => { await sleep(250); return seat(room, { ms: 3800 }); })(),                                      // no ident
  (async () => { await sleep(250); return seat(room, { who: good, secret: "wrong-secret-wrong-secret-wrong", ms: 3800 }); })(),   // wrong secret
]);
const [host, okJ, anon, wrong] = res;
check(host.welcome && host.open && !told(host), "strict ON: an approved host keeps its seat");
check(okJ.welcome && okJ.open && !told(okJ), "strict ON: an approved joiner keeps its seat past the deadline");
check(told(anon, "ident-required"), "strict ON: no ident -> error ident-required, closed");
check(told(wrong, "ident-required") && errs(wrong).every((m) => m.reason === "ident-required"), "strict ON: wrong secret is refused with the generic ident-required only");
res.forEach((r) => r.close());
const rb = rcode();
const sb = await seat(rb, { who: banned, role: "host", ms: 2000 });
check(told(sb, "account-unavailable") && !sb.open, "strict ON: banned -> account-unavailable, closed");
const rp = rcode();
const sp = await seat(rp, { who: pend, role: "host", ms: 2000 });
check(told(sp, "pending-approval") && !sp.open, "strict ON: pending -> pending-approval, closed");
// strict ON, a host that never identified: its room still dies cleanly, the next host can use the code
const rh = rcode();
const an = await seat(rh, { role: "host", ms: 3500 });
check(told(an, "ident-required"), "strict ON: an anonymous host is closed ident-required");
const again = await seat(rh, { who: good, role: "host", ms: 600 });
check(again.welcome && !told(again), "...and the room code is free for an approved host afterwards");
sb.close(); sp.close(); an.close(); again.close();
// racing joiners never share a slot with strict on (flag read before the slot is chosen)
const rr = rcode();
const rhs = await seat(rr, { who: good, role: "host", ms: 400 });
const racers = await Promise.all([1, 2, 3].map(() => seat(rr, { who: good, ms: 1200 })));
const slots = racers.map((r) => (r.msgs.find((m) => m.type === "welcome") || {}).slot).filter((x) => x !== undefined);
check(slots.length === 3 && new Set(slots).size === 3, "strict ON: three simultaneous joiners get three different slots (" + slots.join(",") + ")");
rhs.close(); racers.forEach((r) => r.close());

s = await settings(adm, { strict_rooms: false });
const rz = rcode();
const z = await seat(rz, { role: "host", ms: 3000 });
check(z.open && !told(z), "strict switched OFF again: anonymous seats stay");
z.close();

console.log(st.fails ? `\n${st.fails} FAILED` : "\nALL PASSED");
process.exit(st.fails ? 1 : 0);
