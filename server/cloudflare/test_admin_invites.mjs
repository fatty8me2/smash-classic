// Owner invite codes + easier approvals (adminreg.js header: "Invite codes"). LOCAL wrangler only. Needs the server started with
//   ADMIN_UID=aaaa... REG_APPROVAL_DEFAULT:1 REG_DEFAULT_CUTOFF:4102444800000 REG_TOUCH_MS:0 REG_PENDING_RECHECK_MS:300 TEST_REG:1 ALLOW_TEST_FLAG:1
//   REG_INVITE_HOUR_MS:1000 (an invite "hour" lasts a second) REG_INVITE_ACTIVE_CAP:6 REG_INVITE_GLOBAL_CAP:30
//   node test_admin_invites.mjs [ws://127.0.0.1:PORT]       (run_all_tests.mjs does all of this)
import { ADMIN, ADMIN_SECRET, rnd, sleep, checker, connect, mk, again, ask, waitMsg, untilTrue, code } from "./admin_test_lib.mjs";

const base = process.argv[2] || "ws://127.0.0.1:8791";
const http = base.replace("ws", "http");
const { st, check } = checker();
const nm = (p) => p + rnd(5);
const reg = async (op, body) => (await fetch(`${http}/__test/reg?op=${op}`, { method: "POST", body: JSON.stringify(body) })).json();
const rowOf = async (u) => (await reg("t_row", { uid: u.uid })).row;
const CODE_RE = /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/;
const HOUR = 1000;

// A waiting account (fresh socket, hello answered "pending-approval") sends redeem_invite; returns {res, conn}.
async function redeem(u, c) {
  const conn = await again(u);
  if (conn.outcome !== "error" || conn.error.reason !== "pending-approval") return { res: { type: "setup-failed", outcome: conn.outcome }, conn };
  const res = await ask(conn, { type: "redeem_invite", code: c }, "invite_result");
  return { res, conn };
}
const mkInv = async (adm, extra = {}) => ask(adm, { type: "admin_invite_create", ...extra }, "admin_invites");
const list = async (adm) => (await ask(adm, { type: "admin_invite_list" }, "admin_invites")).invites;
const find = (invs, c) => invs.find((i) => i.code === c);

// ============ setup: one old (ok) account, then the cutoff moves to now so every later account is new ============
const E = await mk(base, nm("Old"));
check(E.outcome === "welcome", "setup: an existing account connects");
const adm = await connect(base, ADMIN, ADMIN_SECRET, "Owner");
check(adm.outcome === "welcome" && adm.welcome.admin === true, "setup: the owner connects");
await reg("t_cutoff", { at: Date.now() });
await sleep(40);

// ============ 1. owner only ============
const probes = [
  [{ type: "admin_invite_create" }, "admin_invites"], [{ type: "admin_invite_list" }, "admin_invites"],
  [{ type: "admin_invite_revoke", code: "AAAA-BBBB" }, "admin_invites"], [{ type: "admin_approve_code", code: "RH-AAAA-AAAA" }, "admin_result"],
];
for (const [m, t] of probes) check((await ask(E, m, t, 700)) === null, `non-owner ${m.type}: refused silently`);
check((await list(adm)).length === 0, "no invites yet (and the non-owner create made none)");

// ============ 2. create / list / revoke ============
const c1 = await mkInv(adm);
check(c1.ok === true && c1.created && CODE_RE.test(c1.created.code), "create: code XXXX-XXXX from the unambiguous alphabet");
check(c1.created.uses === 1 && c1.created.used === 0 && c1.created.exp - c1.created.created === 168 * HOUR, "create defaults: 1 use, 168 hours");
check(Array.isArray(c1.created.by_names) && c1.created.by_names.length === 0 && c1.created.note === "", "create: empty by_names and note");
check(find(c1.invites, c1.created.code), "create: the reply lists it");
const c2 = await mkInv(adm, { uses: 99, hours: 9999, note: "x".repeat(60) });
check(c2.created.uses === 20 && c2.created.exp - c2.created.created === 720 * HOUR && c2.created.note === "x".repeat(40), "create clamps uses<=20, hours<=720, note<=40");
const c3 = await mkInv(adm, { uses: 0, hours: -3, note: "Joe's cousin" });
check(c3.created.uses === 1 && c3.created.exp - c3.created.created === 168 * HOUR && c3.created.note === "Joe's cousin", "create: nonsense numbers fall back to the defaults; note kept");
let L = await list(adm);
check(L.length === 3 && L[0].code === c3.created.code && L[2].code === c1.created.code, "list: newest first");
check(new Set([c1, c2, c3].map((c) => c.created.code)).size === 3, "codes are distinct");
const rv = await ask(adm, { type: "admin_invite_revoke", code: c3.created.code.toLowerCase().replace("-", "") }, "admin_invites");
check(rv.invites.length === 2 && !find(rv.invites, c3.created.code), "revoke (any case, dash optional): gone from the list");
const rv2 = await ask(adm, { type: "admin_invite_revoke", code: "ZZZZ-ZZZZ" }, "admin_invites");
check(rv2.ok === false && rv2.reason === "not-found" && rv2.invites.length === 2, "revoke of an unknown code: ok:false not-found, list unchanged");

// ============ 3. cap on active invites (6 here, 50 in production) ============
let made = 0, refused = null;
for (let i = 0; i < 9 && !refused; i++) { const r = await mkInv(adm, { note: "cap" }); if (r.ok) made++; else refused = r; }
check(made === 4 && refused && refused.ok === false && refused.reason === "invite-cap" && refused.invites.length === 6, "cap: the 7th active invite is refused with reason invite-cap (list still returned)");
for (const i of await list(adm)) await ask(adm, { type: "admin_invite_revoke", code: i.code }, "admin_invites");
check((await list(adm)).length === 0, "revoking frees the cap: list empty");

// ============ 4. redeem: success unlocks, uses are counted ============
const inv = (await mkInv(adm, { uses: 2, note: "two uses" })).created;
const N = await mk(base, nm("Newbie"));
check(N.outcome === "error" && N.error.reason === "pending-approval", "setup: a new account is held as pending");
const np = await waitMsg(adm, (m) => m.type === "admin_pending" && m.latest && m.latest.uid === N.uid, 3000);
check(np && np.pending >= 1 && np.latest.name === N.name && np.latest.code === code(N.uid) && typeof np.latest.created === "number", "admin_pending push carries pending + latest {uid,name,code,created}");
const N2 = await mk(base, nm("Second"));
const np2 = await waitMsg(adm, (m) => m.type === "admin_pending" && m.latest && m.latest.uid === N2.uid, 3000);
check(np2 && np2.latest.uid === N2.uid && np2.pending >= 2, "latest is the NEWEST waiting account");

const bad = await redeem(N, "ZZZZ-ZZZZ");
check(bad.res && bad.res.ok === false && bad.res.reason === "invalid", "wrong code: ok:false reason invalid");
check(bad.conn.ws.readyState === 1, "...the socket stays open for another try");
const fromAdm = adm.msgs.length;
const good = await redeem(N, inv.code.toLowerCase());
check(good.res && good.res.ok === true, "valid code (lower case ok): invite_result ok:true");
check(await untilTrue(() => good.conn.closed === 4011, 3000), "...then the socket is closed 4011 like an approval");
const back = await again(N);
check(back.outcome === "welcome", "a following hello gets the welcome (pending -> ok)");
const nr = await rowOf(N);
check(nr && nr.status === "ok" && nr.by === "invite:" + inv.code, "registry: status ok, by invite:<code>");
const used = await waitMsg(adm, (m) => m.type === "admin_invite_used" && m.uid === N.uid, 3000, fromAdm);
check(used && used.code === inv.code && used.name === N.name, "owner gets admin_invite_used {code,name,uid}");
const afterPend = await waitMsg(adm, (m) => m.type === "admin_pending" && m.pending >= 0 && m.latest && m.latest.uid === N2.uid, 3000, fromAdm);
check(afterPend, "...and an updated admin_pending (the used account is no longer the one waiting)");
L = await list(adm);
check(find(L, inv.code).used === 1 && find(L, inv.code).by_names.join() === N.name, "list: used=1, by_names has the name");

const good2 = await redeem(N2, inv.code);
check(good2.res && good2.res.ok === true, "second use of a 2-use invite works");
const N3 = await mk(base, nm("Third"));
const over = await redeem(N3, inv.code);
check(over.res && over.res.ok === false && over.res.reason === "used-up", "third use: used-up");
check((await rowOf(N3)).status === "pending", "...and the account stays pending");
L = await list(adm);
check(find(L, inv.code).used === 2 && find(L, inv.code).by_names.length === 2, "list: used=2 (the failed try consumed nothing), two names");

// ============ 5. revoked, expired ============
const rev = (await mkInv(adm, { note: "to revoke" })).created;
await ask(adm, { type: "admin_invite_revoke", code: rev.code }, "admin_invites");
const r1 = await redeem(N3, rev.code);
check(r1.res && r1.res.ok === false && r1.res.reason === "invalid", "revoked code: invalid (same as unknown)");
const exp = (await mkInv(adm, { hours: 1, note: "short" })).created;
await sleep(HOUR + 400);
L = await list(adm);
check(find(L, exp.code) && find(L, exp.code).exp < Date.now(), "list: an expired invite is still shown (7 days)");
const r2 = await redeem(N3, exp.code);
check(r2.res && r2.res.ok === false && r2.res.reason === "expired", "expired code: expired");
check((await rowOf(N3)).status === "pending", "...account still pending");
// the per-account limiter has now seen 3 failures from N3 (used-up, invalid, expired); two more are allowed, the sixth try is refused
const live = (await mkInv(adm, { uses: 20, note: "live" })).created;

// ============ 6. banned / denied cannot redeem ============
const X = await mk(base, nm("Banned"));
const Y = await mk(base, nm("Denied"));
const xr = await ask(adm, { type: "admin_ban", uid: X.uid }, "admin_result");
const yr = await ask(adm, { type: "admin_deny", uid: Y.uid }, "admin_result");
check(xr.ok && yr.ok, "setup: one banned, one denied");
await sleep(300);
let xTry = await again(X);
check(xTry.outcome === "error" && xTry.error.reason === "account-unavailable", "banned hello: account-unavailable");
const xres = await ask(xTry, { type: "redeem_invite", code: live.code }, "invite_result", 1200);
check(xres === null, "banned account: no invite_result at all");
check(await untilTrue(() => xTry.closed === 4002, 2500), "banned account: the redeem frame closes the socket (4002)");
const yTry = await again(Y);
check((await ask(yTry, { type: "redeem_invite", code: live.code }, "invite_result", 1200)) === null, "denied account: no invite_result");
check((await rowOf(X)).status === "banned" && (await rowOf(Y)).status === "denied", "...both stay banned/denied in the registry");
// the registry itself refuses too (a socket that was open when the ban landed)
const tr = await reg("t_redeem", { uid: X.uid, code: live.code, name: "x" });
check(tr.ok === false && tr.reason === "invalid", "registry: redeem for a banned uid -> invalid");
check(find(await list(adm), live.code).used === 0, "...and no use was consumed");
// no hello at all
const raw = new WebSocket(`${base}/friends?uid=${rnd(26)}`);
let rawGot = null, rawClosed = null;
raw.onmessage = (e) => { rawGot = JSON.parse(e.data); };
raw.onclose = (e) => { rawClosed = e.code; };
await new Promise((r) => { raw.onopen = r; });
raw.send(JSON.stringify({ type: "redeem_invite", code: live.code }));
check(await untilTrue(() => rawClosed === 4002, 2500) && !rawGot, "redeem before any hello: socket dropped (4002), no answer");

// ============ 7. already-ok redeem consumes nothing ============
const okr = await reg("t_redeem", { uid: E.uid, code: live.code, name: "e" });
check(okr.ok === true, "already-ok account redeeming: ok:true");
check(find(await list(adm), live.code).used === 0, "...without consuming a use");
const okr2 = await reg("t_redeem", { uid: E.uid, code: "ZZZZ-ZZZZ", name: "e" });
check(okr2.ok === true, "...even with a junk code (an ok account is simply ok)");

// ============ 8. approve by friend code ============
const P = await mk(base, nm("Code"));
const pa = await ask(adm, { type: "admin_approve_code", code: code(P.uid) }, "admin_result");
check(pa && pa.op === "approve" && pa.ok === true && pa.uid === P.uid, "admin_approve_code: ok, op approve, uid");
check((await again(P)).outcome === "welcome" || (await untilTrue(async () => (await again(P)).outcome === "welcome", 3000)), "...the account is unlocked");
const pr = await rowOf(P);
check(pr.status === "ok" && pr.by === "admin", "...registry says ok by admin");
const pb = await ask(adm, { type: "admin_approve_code", code: code(P.uid) }, "admin_result");
check(pb.ok === false && pb.reason === "not-pending", "again on an approved account: not-pending");
const pc = await ask(adm, { type: "admin_approve_code", code: "RH-ZZZZ-ZZZZ" }, "admin_result");
check(pc.ok === false && pc.reason === "not-found", "unknown code: not-found");
const pd = await ask(adm, { type: "admin_approve_code", code: "!!" }, "admin_result");
check(pd.ok === false && pd.reason === "not-found", "malformed code: not-found");
const Q = await mk(base, nm("Plain"));
const pe = await ask(adm, { type: "admin_approve_code", code: code(Q.uid).slice(3).replace("-", "").toLowerCase() }, "admin_result");
check(pe.ok === true && pe.uid === Q.uid, "code without RH- prefix / dash, lower case: accepted");
const pf = await ask(adm, { type: "admin_approve_code", code: code(X.uid) }, "admin_result");
check(pf.ok === false && pf.reason === "not-pending", "a banned account's code: not-pending (not unbanned)");

// ============ 9. rate limits ============
const R = await mk(base, nm("Rate"));
const Z = await mk(base, nm("Fresh"));
const outs = [];
for (let i = 0; i < 5; i++) outs.push((await redeem(R, "ZZZZ-" + rnd(4).toUpperCase().replace(/[01OIL]/g, "Z"))).res);
check(outs.every((o) => o && o.ok === false && o.reason === "invalid"), "5 wrong tries: invalid each time");
const sixth = await redeem(R, live.code);
check(sixth.res && sixth.res.ok === false && sixth.res.reason === "rate-limited", "6th try (even with a VALID code): rate-limited");
check((await rowOf(R)).status === "pending", "...account still pending");
const zr = await redeem(Z, live.code);
check(zr.res && zr.res.ok === true, "another account is not affected by R's limit");
check(find(await list(adm), live.code).used === 1, "...exactly one use consumed so far on the live invite");

// global brute-force cap (30 failures an hour here, 200 in production): spread over many different uids, no sockets needed
let gl = 0;
for (let i = 0; i < 60; i++) {
  const r = await reg("t_redeem", { uid: rnd(26), code: "ZZZZ-ZZZZ", name: "brute" });
  if (r.reason === "rate-limited") break;
  gl++;
}
check(gl > 0 && gl < 30, `the registry-wide limit trips (after ${gl} more failures)`);
const S = await mk(base, nm("Victim"));
const sr = await redeem(S, live.code);
check(sr.res && sr.res.ok === false && sr.res.reason === "rate-limited", "above the global cap even a valid code gets rate-limited");
check((await rowOf(S)).status === "pending", "...and nothing was consumed or approved");
check(find(await list(adm), live.code).used === 1, "...the live invite still has used=1");

console.log(st.fails ? `\n${st.fails} FAILED` : "\nALL PASSED");
for (const u of [adm, E, N, N2, N3, X, Y, P, Q, R, Z, S, back]) { try { u.ws.close(); } catch { /* closed */ } }
process.exit(st.fails ? 1 : 0);
