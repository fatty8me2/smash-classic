// The client's test flag (test:true, "qa-" names) is ignored unless the deployment sets ALLOW_TEST_FLAG (local only). LOCAL wrangler only. Usage:
//   npx wrangler dev --ip 127.0.0.1 --port 8794 --var ADMIN_UID:aaaaaaaaaaaaaaaaaaaaaaaaaa --var ALLOW_TEST_FLAG:0      (fresh --persist-to dir)
//   node test_admin_testflag.mjs [ws://127.0.0.1:8794]
import { ADMIN, ADMIN_SECRET, rnd, checker, connect, mk, ask, friendsOf } from "./admin_test_lib.mjs";

const base = process.argv[2] || "ws://127.0.0.1:8794";
const { st, check } = checker();
const adm = await connect(base, ADMIN, ADMIN_SECRET, "Owner");
const list = (o = {}) => ask(adm, { type: "admin_list", limit: 50, ...o }, "admin_list");

const a = await mk(base, "qa-" + rnd(5));
const b = await mk(base, "Spoofer" + rnd(3), { test: true });
check(a.outcome === "welcome" && b.outcome === "welcome", "production-like server: the accounts connect");
check(a.welcome.friends.some((f) => f.uid === ADMIN), "a qa- name does NOT skip the admin auto-link");
check(b.welcome.friends.some((f) => f.uid === ADMIN), "test:true does NOT skip the admin auto-link");
const l = await list();
check(l.rows.some((r) => r.uid === a.uid && r.test === false) && l.rows.some((r) => r.uid === b.uid && r.test === false), "both are listed as ordinary accounts (not hidden as test accounts)");
check((await friendsOf(adm)).friends.includes(a.uid), "the owner's friend list holds them");
// approval mode: they are NOT a way around the gate, and they are visible in the Pending queue
await ask(adm, { type: "admin_settings", set: { approval: true } }, "admin_settings");
const c = await mk(base, "qa-" + rnd(5), { test: true });
check(c.outcome === "error" && c.error.reason === "pending-approval", "approval ON: a spoofed test account waits like anyone else");
check((await list({ status: "pending" })).rows.some((r) => r.uid === c.uid && r.test === false), "…and the owner sees it in the Pending queue");
await ask(adm, { type: "admin_settings", set: { approval: false } }, "admin_settings");
for (const u of [adm, a, b]) try { u.ws.close(); } catch { /* */ }
console.log(st.fails ? `${st.fails} FAILED` : "ALL PASSED");
process.exit(st.fails ? 1 : 0);
