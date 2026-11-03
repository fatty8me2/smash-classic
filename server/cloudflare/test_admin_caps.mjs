// Registry caps, grandfathering of untracked accounts, vouch limit, test accounts excluded. LOCAL wrangler only. Usage:
//   npx wrangler dev --ip 127.0.0.1 --port 8792 --var ADMIN_UID:aaaaaaaaaaaaaaaaaaaaaaaaaa --var REG_ACCT_CAP:3 --var REG_PENDING_CAP:2 \
//     --var REG_BAN_CAP:2 --var REG_VOUCH_CAP:1 --var REG_TOUCH_MS:0      (fresh --persist-to dir)
//   node test_admin_caps.mjs [ws://127.0.0.1:8792]
import { ADMIN, ADMIN_SECRET, rnd, sleep, checker, connect, mk, again, code, ask, untilTrue } from "./admin_test_lib.mjs";

const base = process.argv[2] || "ws://127.0.0.1:8792";
const { st, check } = checker();
const nm = (p) => p + rnd(5);
const adm = await connect(base, ADMIN, ADMIN_SECRET, "Owner");
const settings = async (set) => (await ask(adm, { type: "admin_settings", ...(set ? { set } : {}) }, "admin_settings")).settings;
const list = (o = {}) => ask(adm, { type: "admin_list", limit: 50, ...o }, "admin_list");
const ban = (uid) => ask(adm, { type: "admin_ban", uid }, "admin_result");

// accounts cap: 3 tracked (test accounts count too), the rest connect fine but are not tracked
const T1 = await mk(base, "qa-" + rnd(5)), T2 = await mk(base, "qa-" + rnd(5));
const A = [];
for (let i = 0; i < 5; i++) A.push(await mk(base, nm("Acct" + i)));
check([T1, T2, ...A].every((u) => u.outcome === "welcome"), "over the registry cap new accounts are NEVER refused (approval off)");
let l = await list();
check(l.tracked === 3 && l.rows.length === 1 && l.rows[0].uid === A[0].uid, "the registry holds at most the cap (3): two test accounts + one real one (visible rows " + l.rows.length + ")");
const lt = await ask(adm, { type: "admin_list", limit: 50, tests: true }, "admin_list");
check(lt.rows.length === 3 && lt.rows.some((r) => r.uid === T1.uid && r.test === true), "test accounts are stored and flagged, hidden by default, shown with the test filter");
check(l.counts.all === 1, "the counts exclude test accounts");

// grandfathering of an untracked old account: approval on, then it connects with a fresh touch
await settings({ approval: true });
const old4 = await again(A[4]);
check(old4.outcome === "welcome", "an UNTRACKED account created before the switch-on is grandfathered (no row needed)");

// pending queue cap: 2 queued, the third is refused but not queued
const N = [];
for (let i = 0; i < 3; i++) N.push(await mk(base, nm("New" + i)));
check(N.every((u) => u.outcome === "error" && u.error.reason === "pending-approval"), "new accounts are refused while approval is on");
l = await list({ status: "pending" });
check(l.counts.pending === 2 && l.rows.length === 2, "pending queue is capped at 2 (got " + l.counts.pending + ")");
check(!l.rows.some((r) => r.uid === N[2].uid), "the third waiting account is not queued…");
const stillRefused = await again(N[2]);
check(stillRefused.outcome === "error" && stillRefused.error.reason === "pending-approval", "…but is still refused");
// room frees up when one is approved
const ap = await ask(adm, { type: "admin_approve", uid: N[0].uid }, "admin_result");
check(ap && ap.ok, "approve frees a queue slot");
await sleep(2500);   // pending accounts re-check with the registry every 2 min; force by a new hub-less attempt below
check((await again(N[0])).outcome === "welcome", "the approved account connects");

// vouch limit (REG_VOUCH_CAP=1): one approved account can vouch for one new account
await settings({ vouch: true });
const W1 = await mk(base, nm("Wait")), W2 = await mk(base, nm("Wait"));
const voucher = N[0];
const v1 = await again(voucher);
v1.send({ type: "add_friend", code: code(W1.uid) });
check(await untilTrue(() => W1.closed === 4011), "vouch #1 approves");
const w1c = await again(W1);
w1c.send({ type: "add_friend", code: code(W2.uid) }); await sleep(800);
check(W2.closed !== 4011, "a vouched account cannot vouch for anyone else (no chains)");
v1.send({ type: "add_friend", code: code(W2.uid) }); await sleep(800);
check(W2.closed !== 4011, "vouch #2 from the same account is refused (limit)");

// ban cap (2): two bans accepted, the third refused
const b1 = await ban(rnd(26)), b2 = await ban(rnd(26)), b3 = await ban(rnd(26));
check(b1.ok && b2.ok && b3 && b3.ok === false && b3.reason === "ban-cap", "ban list is capped (third refused: " + (b3 && b3.reason) + ")");
check((await list({ status: "banned" })).counts.banned === 2, "banned count stays at the cap");
// unban frees a slot
await ask(adm, { type: "admin_unban", uid: b1.uid }, "admin_result");
check((await ban(rnd(26))).ok === true, "after an unban another ban fits");

// page size is clamped
check((await ask(adm, { type: "admin_list", limit: 5000 }, "admin_list")).rows.length <= 50, "list page size is clamped to 50");

console.log(st.fails ? `${st.fails} FAILED` : "ALL PASSED");
process.exit(st.fails ? 1 : 0);
