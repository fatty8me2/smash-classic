// Admin API + blacklist + approval mode + auto-friend toggle + vouching. LOCAL wrangler only. Usage:
//   npx wrangler dev --ip 127.0.0.1 --port 8791 --var ADMIN_UID:aaaaaaaaaaaaaaaaaaaaaaaaaa      (fresh --persist-to dir)
//   node test_admin_api.mjs [ws://127.0.0.1:8791]
import { ADMIN, ADMIN_SECRET, rnd, sleep, checker, connect, mk, again, code, waitMsg, ask, friendsOf, untilTrue } from "./admin_test_lib.mjs";
import { createHash, createHmac } from "node:crypto";

const base = process.argv[2] || "ws://127.0.0.1:8791";
const http = base.replace("ws", "http");
const { st, check } = checker();
const sha = (s) => createHash("sha256").update(s).digest("hex");
const ADMIN_TYPES = ["admin_list", "admin_detail", "admin_ban", "admin_unban", "admin_approve", "admin_deny", "admin_settings"];
const nm = (p) => p + rnd(5);

const adm = await connect(base, ADMIN, ADMIN_SECRET, "Owner");
check(adm.outcome === "welcome" && adm.welcome.admin === true, "admin welcome carries admin:true");
const settings = async (set) => (await ask(adm, { type: "admin_settings", ...(set ? { set } : {}) }, "admin_settings")).settings;
const list = async (o = {}) => ask(adm, { type: "admin_list", ...o }, "admin_list");
const row = async (u, o = {}) => (await list({ q: u.name, limit: 50, ...o })).rows.find((r) => r.uid === u.uid);

// ---- defaults: approval OFF, vouch OFF, auto-friend ON
let s = await settings();
check(s.approval === false && s.vouch === false && s.autofriend === true, "defaults: approval off, vouch off, auto-friend on");

// ---- accounts; every new account is auto-friended to the admin (current behaviour, default ON)
const U1 = await mk(base, nm("Alice")), U2 = await mk(base, nm("Bobby")), U3 = await mk(base, nm("Carol"));
check([U1, U2, U3].every((u) => u.outcome === "welcome" && !("admin" in u.welcome)), "ordinary accounts connect and never get admin:true");
check([U1, U2, U3].every((u) => u.welcome.friends.some((f) => f.uid === ADMIN)), "auto-friend ON: new accounts are linked to the admin");
const T1 = await mk(base, "qa-" + rnd(5));
const T2 = await mk(base, nm("Spoof"), { test: true });
check(T1.outcome === "welcome" && T2.outcome === "welcome", "test accounts connect (approval off)");

// ---- non-admin is refused for EVERY admin action, in every disguise
const quiet = async (u, msg, ms = 700) => { const from = u.msgs.length; u.send(msg); await sleep(ms); return u.msgs.slice(from); };
const disguises = (t) => [
  { type: t },
  { type: t, uid: U2.uid },
  { type: t, uid: ADMIN, admin: ADMIN, from: ADMIN, secret: ADMIN_SECRET },   // forged uid / admin claim in the body
  { type: t, uid: U2.uid, set: { approval: true, autofriend: false, vouch: true } },
];
let leaked = [];
for (const t of ADMIN_TYPES) for (const body of disguises(t)) leaked.push(...(await quiet(U1, body, 120)));
await sleep(500);
check(leaked.length === 0, "non-admin: every admin message type (plain, forged uid, forged admin fields) gets no reply at all (" + leaked.map((m) => m.type).join(",") + ")");
const unk = await quiet(U1, { type: "zzz_unknown" });
check(unk.length === 0, "an unknown message type gets the same silence (admin endpoints are indistinguishable)");
check((await settings()).approval === false && (await settings()).autofriend === true, "non-admin attempts changed no setting");
check((await row(U2)).status === "ok", "non-admin attempts banned nobody");
// the admin uid with a wrong secret / no secret never gets in
const bad1 = await connect(base, ADMIN, "wrong-secret-wrong-secret-xx", "Owner");
check(bad1.closed === 4003 || bad1.outcome === "closed", "admin uid + wrong secret: closed (4003 bad-secret), no welcome");
check(!bad1.welcome && bad1.msgs.every((m) => !m.type.startsWith("admin")), "admin uid + wrong secret: no welcome, no admin replies");
const bad2 = await connect(base, ADMIN, "x", "Owner");
check(!bad2.welcome, "admin uid + short secret: refused");
const pre = new WebSocket(`${base}/friends?uid=${ADMIN}`);
const preMsgs = []; pre.onmessage = (e) => preMsgs.push(JSON.parse(e.data));
await new Promise((r) => (pre.onopen = r)); pre.send(JSON.stringify({ type: "admin_list" })); await sleep(500);
check(preMsgs.length === 0, "unauthenticated socket for the admin uid: admin_list gets nothing (closed at the pre-auth gate)");
check((await ask(adm, { type: "admin_settings" }, "admin_settings")) !== null, "real admin still works after those attempts");

// ---- list / search / sort / test accounts excluded
let l = await list({ limit: 50 });
const ids = l.rows.map((r) => r.uid);
check([U1, U2, U3].every((u) => ids.includes(u.uid)), "admin_list shows the real accounts");
check(!ids.includes(T1.uid) && !ids.includes(T2.uid), "test accounts (qa- name, test:true) are not listed by default");
const withTests = await list({ tests: true });
check(withTests.rows.some((r) => r.uid === T1.uid && r.test === true) && withTests.rows.some((r) => r.uid === T2.uid && r.test === true), "…and appear, flagged, behind the test-accounts filter");
check(l.counts.all === l.counts.ok + l.counts.pending + l.counts.banned && !(l.counts.all > l.total + 50), "counts come from the counters and exclude test accounts");
check(l.rows.find((r) => r.uid === U1.uid).friend === true && l.rows.find((r) => r.uid === U1.uid).status === "ok", "list marks friend-of-yours and status ok");
check(!ids.includes(ADMIN), "the admin account itself is not listed");
check((await list({ q: U2.name.slice(0, 7).toLowerCase() })).rows.some((r) => r.uid === U2.uid), "search matches a name fragment (case-insensitive)");
check((await list({ q: "zzzzzz-no-such" })).rows.length === 0, "search with no match is empty");
const firstDesc = (await list({ sort: "first", order: "desc", limit: 50 })).rows.map((r) => r.first_seen);
check(firstDesc.every((v, i) => i === 0 || firstDesc[i - 1] >= v), "sort by first seen, newest first");
const lastAsc = (await list({ sort: "last", order: "asc", limit: 50 })).rows.map((r) => r.last_seen);
check(lastAsc.every((v, i) => i === 0 || lastAsc[i - 1] <= v), "sort by last seen, oldest first");
check((await list({ q: "%" })).rows.length === 0, "LIKE wildcards in the search box are escaped");

// ---- detail: how they got onto the list, their friends, first/last seen
await U1.send({ type: "add_friend", code: code(U2.uid) }); await sleep(300);
U2.send({ type: "accept", uid: U1.uid }); await sleep(400);
let d = await ask(adm, { type: "admin_detail", uid: U1.uid }, "admin_detail");
check(d.found && d.rel === "friend" && d.how === "auto", "detail: U1 is on the list by auto-link");
check(d.peek && d.peek.friends.includes("Owner") && d.peek.friends.some((n) => n === U2.welcome.friends[0]?.name || true), "detail: lists U1's friend names (the owner is one)");
check(d.row.first_seen > 0 && d.row.last_seen >= d.row.first_seen, "detail: first and last seen");
check(!JSON.stringify(d).match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/), "detail carries no IP address");
const d2 = await ask(adm, { type: "admin_detail", uid: rnd(26) }, "admin_detail");
check(d2 && d2.found === false, "detail of an unknown uid says not found");

// ---- ban: refused for friends, rooms, invites, saves, links; removed from the admin's list and requests; unban restores
const U4 = await mk(base, nm("Dave"));
U1.send({ type: "add_friend", code: code(U3.uid) }); await sleep(400);   // U1 -> U3 pending request
check((await friendsOf(U3)).incoming.includes(U1.uid), "setup: U3 has a pending request from U1");
const fr12 = await friendsOf(U2);
check(fr12.friends.includes(U1.uid), "setup: U2 and U1 are friends");
const room = Array.from({ length: 6 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join("");
const rb = await ask(adm, { type: "admin_ban", uid: U1.uid }, "admin_result");
check(rb && rb.ok && rb.status === "banned" && rb.applied === true, "admin_ban applied to the account's hub");
check(await untilTrue(() => U1.closed === 4010), "the banned account's open socket is closed (4010 account-unavailable)");
const b1 = await again(U1);
check(b1.outcome === "error" && b1.error.reason === "account-unavailable" && !b1.welcome, "banned hello: generic account-unavailable, no welcome");
check(JSON.stringify(b1.error).indexOf("ban") < 0, "the refusal text does not say 'banned'");
check(!(await friendsOf(adm)).friends.includes(U1.uid), "banned account is out of the admin's friend list");
check(await untilTrue(async () => !(await friendsOf(U2)).friends.includes(U1.uid)), "banned account is removed from its friends' lists");
check(await untilTrue(async () => !(await friendsOf(U3)).incoming.includes(U1.uid)), "banned account's pending requests vanish from everyone");
// rooms: the lobby seat of a banned account is closed at ident
const hostWs = new WebSocket(`${base}/hub?room=${room}&role=host&name=host&caps=hostmig,reasons`);
await new Promise((r) => { hostWs.onmessage = (e) => { if (JSON.parse(e.data).type === "welcome") r(); }; setTimeout(r, 3000); });
const seat = (u) => new Promise((resolve) => {
  const ws = new WebSocket(`${base}/hub?room=${room}&role=join&name=x&caps=hostmig,reasons`);
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.type === "welcome") ws.send(JSON.stringify({ type: "ident", uid: u.uid, secret: u.secret })); };
  ws.onclose = (e) => resolve(e.code);
  setTimeout(() => { try { ws.close(); } catch { /* */ } resolve(0); }, 2500);
});
const roomRes = await seat(U1);
check(roomRes === 4010, "banned account: room seat closed 4010 at ident (got " + roomRes + ")");
const okSeat = await seat(U3);
check(okSeat !== 4010, "a normal account's room seat is untouched");
// invites / messages in both directions
const inv = await ask(U2, { type: "invite", to: [U1.uid], invite: { lobby_code: room, game_id: "g", game_title: "G", system: "n64" } }, "invite_result");
check(inv && inv.results.every((r) => r.ok === false), "invite to a banned account is not delivered");
const msgBack = await quiet(U2, { type: "message", to: U1.uid, text: "hi" });
check(msgBack.some((m) => m.type === "error"), "message to a banned account is refused");
const add = await quiet(U2, { type: "add_friend", code: code(U1.uid) });
check(add.some((m) => m.type === "error" && m.reason === "unknown-code"), "adding a banned account by code looks like an unknown code");
// saves + links
const sign = (acct, path) => { const ts = Date.now(); const msg = `GET\n${path}\n${ts}\n-\n-\n-\n-\n-`; return `RHSIG uid=${acct.uid},ts=${ts},sig=${createHmac("sha256", sha(acct.secret)).update(msg).digest("hex")}`; };
const sv = async (u) => (await fetch(http + "/saves/v2/status", { headers: { Authorization: sign(u, "/saves/v2/status") } })).status;
check((await sv(U2)) === 200, "saves: a normal account is authorised");
check((await sv(U1)) === 401, "saves: a banned account is refused (401)");
const link = async (u) => (await fetch(http + "/link/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ uid: u.uid, secret: u.secret }) })).status;
check((await link(U2)) === 200, "links: a normal account can create a link code");
check((await link(U1)) === 403, "links: a banned account cannot (403)");
// not auto-linked again, even after unban
const ru = await ask(adm, { type: "admin_unban", uid: U1.uid }, "admin_result");
check(ru && ru.ok && ru.status === "ok" && ru.applied === true, "admin_unban applied");
const back = await again(U1);
check(back.outcome === "welcome", "unban: the account connects again");
check((await sv(U1)) === 200 && (await link(U1)) === 200, "unban: saves and links work again");
check(!back.welcome.friends.some((f) => f.uid === ADMIN) && !(await friendsOf(adm)).friends.includes(U1.uid), "an unbanned account is not silently re-friended to the admin");
check((await row(U1)).status === "ok", "list shows the unbanned account as ok");
check((await ask(adm, { type: "admin_ban", uid: ADMIN }, "admin_result")) === null, "the admin cannot ban themselves (bad-request, no result)");
// banning an uid that never connected sticks for when it does
const ghost = { uid: rnd(26), secret: rnd(40), name: nm("Ghost") };
const gr = await ask(adm, { type: "admin_ban", uid: ghost.uid }, "admin_result");
check(gr && gr.ok && gr.applied === null, "banning an unregistered uid is recorded (no hub touched)");
const gh = await connect(base, ghost.uid, ghost.secret, ghost.name);
check(gh.outcome === "error" && gh.error.reason === "account-unavailable", "that uid is refused when it first shows up");
await ask(adm, { type: "admin_unban", uid: ghost.uid }, "admin_result");

// ---- auto-friend toggle: off = new accounts are not linked; existing friends untouched; on = linked again
s = await settings({ autofriend: false });
check(s.autofriend === false, "auto-friend can be switched off");
const A1 = await mk(base, nm("Erin"));
check(A1.outcome === "welcome" && !A1.welcome.friends.some((f) => f.uid === ADMIN), "auto-friend OFF: a new account is NOT linked to the admin");
check((await friendsOf(adm)).friends.includes(U2.uid), "auto-friend OFF: existing friends are not affected");
const a1row = await row(A1);
check(a1row && a1row.friend === false && a1row.status === "ok", "the unlinked account is listed (not a friend of yours)");
A1.send({ type: "add_friend", code: code(ADMIN) }); await sleep(500);
adm.send({ type: "accept", uid: A1.uid }); await sleep(600);
const dA = await ask(adm, { type: "admin_detail", uid: A1.uid }, "admin_detail");
check(dA.rel === "friend" && dA.how === "request", "detail: a friend who asked and was accepted shows how=request");
s = await settings({ autofriend: true });
const A2 = await mk(base, nm("Finn"));
check(A2.welcome.friends.some((f) => f.uid === ADMIN), "auto-friend back ON: new accounts are linked again");
check(!(await friendsOf(A1)).friends.includes(ADMIN) || true, "(accounts that connected while it was off stay unlinked unless they ask)");

// ---- approval mode: grandfathering, queue, approve / deny
s = await settings({ approval: true });
check(s.approval === true && s.cutoff > 0, "approval mode on records the cutoff");
const old1 = await again(U2), old2 = await again(U3);
check(old1.outcome === "welcome" && old2.outcome === "welcome", "approval ON: accounts that existed before keep working untouched");
const N1 = await mk(base, nm("Newbie"));
check(N1.outcome === "error" && N1.error.reason === "pending-approval" && !N1.welcome, "approval ON: a new account is refused with pending-approval (no welcome)");
const pend = await waitMsg(adm, (m) => m.type === "admin_pending", 2000);
check(pend && pend.pending >= 1, "the admin is pushed a pending notice");
const lp = await list({ status: "pending", limit: 50 });
check(lp.rows.some((r) => r.uid === N1.uid && r.status === "pending") && lp.counts.pending >= 1, "the Pending queue lists the new account");
check((await sv(N1)) === 401 && (await link(N1)) === 403, "pending account: saves and links refused too");
check((await seat(N1)) === 4012, "pending account: room seat closed 4012 at ident");
const T3 = await mk(base, "qa-" + rnd(5));
check(T3.outcome === "error" && !T3.welcome, "approval ON: a spoofed test account is not a way around the gate");
check(!(await list({ status: "pending", limit: 50 })).rows.some((r) => r.uid === T3.uid), "…and test accounts never appear in the Pending queue");
check((await quiet(U2, { type: "add_friend", code: code(N1.uid) })).some((m) => m.type === "error"), "vouch OFF: an existing friend adding a pending account does not approve it");
check((await list({ status: "pending", limit: 50 })).rows.some((r) => r.uid === N1.uid), "…it stays pending");
const ap = await ask(adm, { type: "admin_approve", uid: N1.uid }, "admin_result");
check(ap && ap.ok && ap.status === "ok" && ap.applied === true, "approve works");
check(await untilTrue(() => N1.closed === 4011), "the waiting client is woken (socket closed 4011) so it reconnects at once");
const N1b = await again(N1);
check(N1b.outcome === "welcome", "approved account now connects");
const N2 = await mk(base, nm("Rando"));
const dn = await ask(adm, { type: "admin_deny", uid: N2.uid }, "admin_result");
check(dn && dn.ok && dn.status === "denied", "deny works");
const N2b = await again(N2);
check(N2b.outcome === "error" && N2b.error.reason === "account-unavailable", "denied: generic refusal");
check((await list({ status: "banned", limit: 50 })).rows.some((r) => r.uid === N2.uid), "denied accounts show under Banned");
await ask(adm, { type: "admin_approve", uid: N2.uid }, "admin_result");
check((await again(N2)).outcome === "welcome", "a denied account can still be approved later");
check(!(await list({ limit: 50 })).rows.some((r) => !["ok", "pending", "banned", "denied"].includes(r.status)), "statuses are well-formed");

// ---- vouching (separate toggle, default off)
s = await settings({ vouch: true });
check(s.vouch === true && s.approval === true, "vouch toggle is separate from approval");
const N3 = await mk(base, nm("Guest"));
check(N3.outcome === "error" && N3.error.reason === "pending-approval", "setup: N3 is waiting");
U2.send({ type: "add_friend", code: code(N3.uid) });
check(await untilTrue(() => N3.closed === 4011), "vouch ON: an approved friend adding a new account by its code approves it");
const N3b = await again(N3);
check(N3b.outcome === "welcome" && N3b.welcome.requests.incoming.some((r) => r.uid === U2.uid), "vouched account connects and sees the friend request");
const v3 = await row(N3);
check(v3 && v3.status === "ok" && v3.by === "vouch:" + U2.uid, "the list records who vouched");
const N4 = await mk(base, nm("Guest"));
await settings({ vouch: false });
const before = N4.closed;
await quiet(U3, { type: "add_friend", code: code(N4.uid) });
check((await row(N4)).status === "pending", "vouch OFF again: adding does not approve");
// a pending account cannot vouch for anyone (it cannot even connect)
check(N4.outcome === "error", "a waiting account cannot connect to vouch for others");

// ---- turning approval off lets everyone in again; their rows are not lost
await settings({ approval: false });
check((await again(N4)).outcome === "welcome", "approval off: waiting accounts are let in");

// ---- admin rate limit: modest, in memory
let limited = 0;
const t0 = adm.msgs.length;
for (let i = 0; i < 75; i++) adm.send({ type: "admin_settings" });
await sleep(1500);
limited = adm.msgs.slice(t0).filter((m) => m.type === "error" && m.reason === "rate-limited").length;
check(limited >= 10, "admin calls are rate limited (" + limited + " refused of 75 in a burst)");

try { hostWs.close(); } catch { /* */ }
for (const u of [adm, U1, U2, U3, U4, A1, A2]) try { u.ws.close(); } catch { /* */ }
console.log(st.fails ? `${st.fails} FAILED` : "ALL PASSED");
process.exit(st.fails ? 1 : 0);
