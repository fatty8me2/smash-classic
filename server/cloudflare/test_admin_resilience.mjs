// Resilience of the account gate: no EXISTING account is ever locked out by a registry outage, a failed push, seeding or a rollback.
// LOCAL wrangler only. Usage (fresh --persist-to dir):
//   npx wrangler dev --ip 127.0.0.1 --port 8793 --var ADMIN_UID:aaaaaaaaaaaaaaaaaaaaaaaaaa --var TEST_REG:1 --var ALLOW_TEST_FLAG:1 \
//     --var REG_NEW_MS:1500 --var REG_TOUCH_MS:0 --var REG_RETRY_MS:600 --var REG_BAN_RECHECK_MS:500 --var REG_PENDING_RECHECK_MS:300 --var REG_PUSH_TRIES:2
//   node test_admin_resilience.mjs [ws://127.0.0.1:8793]
import { ADMIN, ADMIN_SECRET, rnd, sleep, checker, connect, mk, again, ask, friendsOf, untilTrue } from "./admin_test_lib.mjs";

const base = process.argv[2] || "ws://127.0.0.1:8793";
const http = base.replace("ws", "http");
const { st, check } = checker();
const nm = (p) => p + rnd(5);
const reg = async (op, body = {}) => (await fetch(`${http}/__test/reg?op=${op}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
const down = (on) => reg("t_down", { on });

const adm = await connect(base, ADMIN, ADMIN_SECRET, "Owner");
const settings = async (set) => (await ask(adm, { type: "admin_settings", ...(set ? { set } : {}) }, "admin_settings")).settings;
const list = (o = {}) => ask(adm, { type: "admin_list", limit: 50, ...o }, "admin_list");

// ================= registry down, approval OFF
const E = await mk(base, nm("Existing"));                 // has an "ok" verdict
check(E.outcome === "welcome", "setup: an account with a verdict");
await down(true);
const E2 = await again(E);
check(E2.outcome === "welcome", "registry DOWN, approval off: an account with an ok verdict is welcomed");
const N = await mk(base, nm("Newcomer"));
check(N.outcome === "welcome", "registry DOWN, approval off: a brand-new account is NEVER held on an error");
check(!N.welcome.friends.some((f) => f.uid === ADMIN), "…and is not auto-linked while the registry cannot be asked");
const O = await mk(base, nm("Oldie"));
check(O.outcome === "welcome", "setup: a second account created during the outage");
await sleep(2000);                                         // older than REG_NEW_MS: "existing" now
const O2 = await again(O);
check(O2.outcome === "welcome", "registry DOWN: an account with no verdict but older than the new-account window is welcomed");
await down(false);
const N2 = await again(N);
check(N2.outcome === "welcome" && N2.welcome.friends.some((f) => f.uid === ADMIN), "registry back: the account is registered and the admin auto-link is NOT lost (retried, never marked done)");
const l0 = await list({ q: N.name.slice(0, 8) });
check(l0.rows.some((r) => r.uid === N.uid && r.status === "ok"), "…and it shows up in the list as ok");

// ================= registry down, approval ON
await again(O);                                            // registers O while up
const O3 = await mk(base, nm("Quiet"));                    // created now, verdict cached ok
await sleep(2000);
await settings({ approval: true });
await down(true);
const E3 = await again(E);
check(E3.outcome === "welcome", "registry DOWN, approval ON: an account with an ok verdict is welcomed");
const O4 = await again(O3);
check(O4.outcome === "welcome", "registry DOWN, approval ON: an old account is welcomed");
const B = await mk(base, nm("Stranger"));
check(B.outcome === "error" && B.error.reason === "server-busy", "registry DOWN, approval ON: only a genuinely NEW account is held");
await down(false);
const B2 = await again(B);
check(B2.outcome === "error" && B2.error.reason === "pending-approval", "registry back: that new account is properly pending");
await settings({ approval: false });

// ================= an explicit ban stays a ban while the registry is down
const X = await mk(base, nm("Troll"));
const bx = await ask(adm, { type: "admin_ban", uid: X.uid }, "admin_result");
check(bx.ok && bx.applied === true, "setup: X banned");
await down(true);
const X2 = await again(X);
check(X2.outcome === "error" && X2.error.reason === "account-unavailable", "registry DOWN: an explicitly banned account stays refused (fail closed only for a ban)");
await down(false);

// ================= a failed ban push is retried (alarm) and shown as not applied
const P = await mk(base, nm("Pushy"));
await reg("t_failpush", { n: 2 });
const bp = await ask(adm, { type: "admin_ban", uid: P.uid }, "admin_result");
check(bp && bp.ok && bp.applied === false, "failed push: the result says applied:false");
const lp = await list({ q: P.name });
check(lp.rows.find((r) => r.uid === P.uid).unapplied === true, "failed push: the list marks the row unapplied (dashboard: Not applied yet - retrying)");
check(await untilTrue(() => P.closed === 4010, 8000), "failed push: the registry retries and the already-authenticated socket is closed (4010)");
check((await again(P)).outcome === "error", "failed push: after the retry the account is refused");
check((await list({ q: P.name })).rows.find((r) => r.uid === P.uid).unapplied === false, "failed push: the row is applied after the retry");

// ban lands through the hello check even if every push fails
const Q = await mk(base, nm("Sneaky"));
const Q2 = await again(Q);                                 // a second authenticated socket
await reg("t_failpush", { n: 1000 });
const bq = await ask(adm, { type: "admin_ban", uid: Q.uid }, "admin_result");
check(bq.ok && bq.applied === false, "push permanently failing: ban recorded, not applied");
const Q3 = await again(Q);
check(Q3.outcome === "error" && Q3.error.reason === "account-unavailable", "…the account's next hello asks the registry and is refused");
check(await untilTrue(() => Q.closed === 4010 && Q2.closed === 4010, 3000), "…and its other authenticated sockets are closed too");
const qrow = (await reg("t_row", { uid: Q.uid })).row;
check(qrow.pushed === 1 && qrow.unreach === 0, "a touch that delivers the verdict marks it pushed (no pointless retries)");
await reg("t_failpush", { n: 0 });

// a retired / deleted account has no hub to push to: its "none" answer counts as done (no endless retry loop)
const D = await mk(base, nm("Deleted"));
D.send({ type: "delete_account", confirm: true, typed: "RH-" + D.uid.slice(0, 4).toUpperCase() + "-" + D.uid.slice(4, 8).toUpperCase() });
await untilTrue(() => D.closed === 4005, 4000);
const bd = await ask(adm, { type: "admin_ban", uid: D.uid }, "admin_result");
check(bd && bd.ok && bd.applied === true, "banning a deleted account: its 'none' reply counts as done (applied)");
check((await reg("t_row", { uid: D.uid })).row.pushed === 1, "…and nothing is left to retry");

// an unreachable hub is given up on (REG_PUSH_TRIES=2 here; 10 tries or 24 h in production), shown, and the ban still lands at its next hello
const Z = await mk(base, nm("Unreach"));
await reg("t_failpush", { n: 100000 });
const bz = await ask(adm, { type: "admin_ban", uid: Z.uid }, "admin_result");
check(bz && bz.ok && bz.applied === false, "unreachable hub: ban recorded, push failed");
check(await untilTrue(async () => (await list({ q: Z.name })).rows.find((r) => r.uid === Z.uid)?.unreachable === true, 9000), "the retry alarm gives up and the row is marked unreachable (shown in the dashboard)");
const zr = (await reg("t_row", { uid: Z.uid })).row;
check(zr.tries === 2 && zr.unreach === 1 && zr.pushed === 0, "it stopped after the configured number of tries (" + zr.tries + ")");
await sleep(4500);                                          // longer than the 5x re-arm: a loop would have tried again
check((await reg("t_row", { uid: Z.uid })).row.tries === 2, "no further retries after giving up (no endless alarm loop)");
const zl = (await list({ q: Z.name })).rows.find((r) => r.uid === Z.uid);
check(zl.unapplied === false && zl.unreachable === true, "the list shows unreachable, not 'retrying'");
const Z2 = await again(Z);
check(Z2.outcome === "error" && Z2.error.reason === "account-unavailable", "the ban is still enforced at the account's next hello through the registry");
const zr2 = (await reg("t_row", { uid: Z.uid })).row;
check(zr2.pushed === 1 && zr2.unreach === 0, "…and that hello clears the unreachable mark");
await reg("t_failpush", { n: 0 });

// a failed UNBAN push never leaves the account banned forever
const U = await mk(base, nm("Unlucky"));
await ask(adm, { type: "admin_ban", uid: U.uid }, "admin_result");
await reg("t_failpush", { n: 1000 });
const un = await ask(adm, { type: "admin_unban", uid: U.uid }, "admin_result");
check(un.ok && un.applied === false, "setup: unban recorded, push failed");
await sleep(700);                                          // past REG_BAN_RECHECK_MS
const U2 = await again(U);
check(U2.outcome === "welcome", "failed unban push: the hub re-checks the registry and lets the account in again");
await reg("t_failpush", { n: 0 });

// ================= seeding never makes an old account pending
// a real account whose row vanished is seeded again from the owner's friend list (seeding resumes when the friend list grew)
const R = await mk(base, nm("Reseed"));
const R1 = await again(R);
await reg("t_delete", { uid: R.uid });
await settings({ approval: true });
const S = { uid: rnd(26) };
await reg("t_seed", { admin: ADMIN, rows: [{ uid: S.uid, name: "SeedOld", since: Date.now() + 60000 }] });   // a friend row "newer" than the cutoff
const sr = (await reg("t_row", { uid: S.uid })).row;
check(sr && sr.status === "ok" && sr.by === "seed" && sr.created === 0, "seeded account: ok, grandfathered, creation time unknown (never pending from the friend-row time)");
const l2 = await list({ q: R.name });
check(l2.rows.some((r) => r.uid === R.uid && r.status === "ok"), "an account the registry lost is re-seeded from the owner's friends as ok (seed_pos resumes)");
check(!(await list({ status: "pending" })).rows.some((r) => r.uid === S.uid || r.uid === R.uid), "seeded accounts are not in the Pending queue");
check((await again(R)).outcome === "welcome", "…and the re-seeded account keeps working under approval mode");
await settings({ approval: false });

for (const u of [adm, E, N, O, O3, B, P, Q, U, R1]) try { u.ws.close(); } catch { /* */ }
console.log(st.fails ? `${st.fails} FAILED` : "ALL PASSED");
process.exit(st.fails ? 1 : 0);
