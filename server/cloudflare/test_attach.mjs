// DM attachments end-to-end against LOCAL `wrangler dev` (isolated registry, --persist-to C:\rhq\<port>; never production).
// Covers: auth, friends-only, caps (8 MB, per-sender pool, per-day), recipient-only download, DM reference stamped by the
// server, 7-day TTL with lazy deletion (no cron), dedupe, budget (Class A/B accounting, paused) and the account pool.
// Usage: node test_attach.mjs
import { randomBytes } from "node:crypto";
import { startServer, client, makeChecker, sha, sleep, sign, b32 } from "./test_v2_lib.mjs";

const { st, check } = makeChecker();
const BASE_PORT = Number(process.env.ATTACH_TEST_PORT) || 10091;
let PORT = BASE_PORT - 1;   // a fresh port per phase (the previous workerd may still hold its persist dir)

function live(BASE, name) {
  const uid = b32(26), secret = b32(52);
  const ws = new WebSocket(`${BASE.replace("http", "ws")}/friends?uid=${uid}`);
  const c = { uid, secret, key: sha(secret), ws, msgs: [], name };
  ws.onmessage = (e) => c.msgs.push(JSON.parse(e.data));
  c.send = (o) => ws.send(JSON.stringify(o));
  c.wait = async (fn, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const r = fn(); if (r) return r; await sleep(25); } return null; };
  c.find = (type, pred = () => true) => c.msgs.find((m) => m.type === type && pred(m));
  c.ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws")); }).then(() => {
    c.send({ type: "hello", secret, name, version: "test", test: true });
    return c.wait(() => c.find("welcome"));
  });
  return c;
}
async function befriend(a, b) {
  const code = b.find("welcome").code;
  a.send({ type: "add_friend", code });
  await b.wait(() => b.find("request", (m) => m.req && m.req.uid === a.uid) || b.find("friend_added"));
  b.send({ type: "accept", uid: a.uid });
  await a.wait(() => a.find("friend_added", (m) => m.friend && m.friend.uid === b.uid));
}

const attPath = (to, kind, name) => `/saves/v2/attach?to=${[].concat(to).join(",")}&kind=${kind}&name=${encodeURIComponent(name)}`;
const hook = async (name, q = {}) => (await fetch(`http://127.0.0.1:${PORT}/saves/_test/${name}?${new URLSearchParams(q)}`)).json();

async function phase(label, vars, fn) {
  console.log("--- " + label + " ---");
  PORT++;
  const srv = await startServer({ port: PORT, vars: { SAVES_RATE_ATT: "1000", SAVES_RATE_GET: "1000", SAVES_RATE_PC: "1000", ...vars } });
  try {
    const api = client(srv.BASE);
    const A = live(srv.BASE, "qa-alice"), B = live(srv.BASE, "qa-bob"), C = live(srv.BASE, "qa-carol");
    await Promise.all([A.ready, B.ready, C.ready]);
    await befriend(A, B);
    await fn(srv, api, A, B, C);
    for (const x of [A, B, C]) try { x.ws.close(); } catch { /* */ }
  } catch (e) { st.fails++; console.log("ERROR:", e); } finally { srv.stop(); await sleep(400); }
}
const put = (api, a, to, kind, name, bytes, o = {}) => api.call(a, "PUT", attPath(to, kind, name), { raw: bytes, ...o });

await phase("A: round trip, auth, friends only, recipient only", {}, async (srv, api, A, B, C) => {
  const png = randomBytes(2000);
  check((await api.call(null, "PUT", attPath(B.uid, "shot", "a.png"), { raw: png })).status === 401, "no auth -> 401");
  check((await put(api, { ...A, key: sha("x") }, B.uid, "shot", "a.png", png)).status === 401, "wrong secret -> 401");
  check((await put(api, A, C.uid, "shot", "a.png", png)).data.error === "not-friends", "upload to a non-friend -> 403 not-friends");
  check((await put(api, A, [B.uid, C.uid], "shot", "a.png", png)).status === 403, "one non-friend among recipients refuses the whole upload");
  check((await put(api, A, B.uid, "movie", "a.png", png)).data.error === "bad-kind", "bad kind -> 400");
  check((await put(api, A, "nope", "shot", "a.png", png)).data.error === "bad-recipient", "bad recipient -> 400");
  check((await put(api, A, A.uid, "shot", "a.png", png)).data.error === "bad-recipient", "to yourself -> 400");
  const bad = await put(api, A, B.uid, "shot", "a.png", png, { headers: { "X-RH-Sha": sha("other") } });
  check(bad.status === 400, "body not matching X-RH-Sha -> 400 (nothing stored)");
  const a0 = (await hook("status")).a;
  const up = await put(api, A, B.uid, "shot", "My Shot?.png", png);
  check(up.status === 200 && /^[0-9a-f]{32}$/.test(up.data.id) && up.data.size === 2000 && up.data.kind === "shot" && up.data.sha === sha(png), "upload ok with id/size/sha/kind");
  check(up.data.name === "My Shot.png", "name sanitized: " + up.data.name);
  const days = (up.data.expires - Date.now()) / 86400e3;
  check(days > 6.9 && days < 7.1, "expires in 7 days (" + days.toFixed(2) + ")");
  check((await hook("status")).a === a0 + 1, "exactly one Class A op for the upload");
  const id = up.data.id;
  // the DM carries the reference; the server stamps the metadata
  A.send({ type: "message", to: B.uid, text: "look", attach: { id, name: "EVIL", size: 1, sha: "0".repeat(64), kind: "patch" } });
  const m = await B.wait(() => B.find("msg", (x) => x.msg.attach));
  check(m && m.msg.attach.id === id && m.msg.attach.name === "My Shot.png" && m.msg.attach.size === 2000 && m.msg.attach.kind === "shot" && m.msg.text === "look", "DM delivered with server-stamped attachment reference (client fields ignored)");
  const b0 = (await hook("status")).b;
  const dl = await api.call(B, "GET", `/saves/v2/attach?id=${id}`);
  check(dl.status === 200 && Buffer.compare(dl.data, png) === 0, "recipient downloads identical bytes");
  check(dl.headers.get("x-rh-kind") === "shot" && decodeURIComponent(dl.headers.get("x-rh-name")) === "My Shot.png", "download headers carry kind and name");
  check((await hook("status")).b === b0 + 1, "exactly one Class B op for the download");
  check((await api.call(A, "GET", `/saves/v2/attach?id=${id}`)).status === 404, "sender cannot download through the recipient route (404)");
  check((await api.call(C, "GET", `/saves/v2/attach?id=${id}`)).status === 404, "a third party gets 404 (existence not leaked)");
  check((await api.call(B, "GET", `/saves/v2/attach?id=${"0".repeat(32)}`)).status === 404, "unknown id -> 404");
  check((await api.call(B, "GET", `/saves/v2/attach?id=zzz`)).status === 400, "malformed id -> 400");
  // a forged / foreign reference in a DM is refused
  C.send({ type: "message", to: B.uid, text: "x", attach: { id } });
  check(await C.wait(() => C.find("error")), "C (not the uploader, not a friend) cannot attach A's file");
  A.send({ type: "message", to: C.uid, text: "x", attach: { id } });
  check(await A.wait(() => A.msgs.some((x) => x.type === "error" && x.ref === "message")), "attach for a different recipient is refused");
  A.send({ type: "message", to: B.uid, attach: { id: "f".repeat(32) } });
  check(await A.wait(() => A.msgs.filter((x) => x.type === "error").length >= 2), "unknown attach id refused");
  // text-only DMs and card-only DMs still work
  A.send({ type: "message", to: B.uid, text: "plain" });
  check(await B.wait(() => B.find("msg", (x) => x.msg.text === "plain" && !x.msg.attach)), "plain text DM unchanged");
  A.send({ type: "message", to: B.uid, text: "challenge", card: "RHC1:abc" });
  check(await B.wait(() => B.find("msg", (x) => x.msg.card === "RHC1:abc")), "card DM delivered");
  A.send({ type: "message", to: B.uid, card: "x".repeat(1537) });
  check(await A.wait(() => A.msgs.some((x) => x.type === "error" && x.detail === "text")), "oversize card refused");
  // dedupe: same file to another friend is free (no extra Class A op)
  await befriend(A, C);
  const a1 = (await hook("status")).a;
  const re = await put(api, A, C.uid, "shot", "My Shot.png", png);
  check(re.status === 200 && re.data.reused === true && re.data.id === id && (await hook("status")).a === a1, "same file to a second friend reuses the object (0 R2 ops)");
  check((await api.call(C, "GET", `/saves/v2/attach?id=${id}`)).status === 200, "second recipient can download it too");
  // v1 list never shows attachments; v2 manifest has no game for them
  const man = (await api.manifest(A)).data;
  check(!Object.keys(man.games || {}).some((g) => /attach|\/a\//.test(g)), "attachments do not appear as save games");
});

await phase("B: 8 MB cap", {}, async (srv, api, A, B) => {
  const big = Buffer.alloc(8 * 1024 * 1024 + 1, 7);
  const r = await put(api, A, B.uid, "state", "x.state", big);
  check(r.status === 413 && r.data.error === "attachment-too-large" && r.data.max === 8388608, "8 MB + 1 -> 413 attachment-too-large");
  const ok = Buffer.alloc(8 * 1024 * 1024, 9);
  const r2 = await put(api, A, B.uid, "state", "x.state", ok);
  check(r2.status === 200 && r2.data.size === 8388608, "exactly 8 MB accepted");
  check((await put(api, A, B.uid, "patch", "e.ips", Buffer.alloc(0))).status === 400, "empty body -> 400");
  const d = await api.call(B, "GET", `/saves/v2/attach?id=${r2.data.id}`);
  check(d.status === 200 && d.data.length === ok.length, "8 MB downloads whole");
});

await phase("C: per-sender pool, daily cap, account pool", { ATTACH_POOL_MAX: "5000", ATTACH_DAY_MAX: "4" }, async (srv, api, A, B) => {
  const f = (n) => randomBytes(n);
  const r1 = await put(api, A, B.uid, "shot", "1.png", f(2000));
  const r2 = await put(api, A, B.uid, "shot", "2.png", f(2000));
  check(r1.status === 200 && r2.status === 200, "two files within the pool");
  const r3 = await put(api, A, B.uid, "shot", "3.png", f(2000));
  check(r3.status === 507 && r3.data.error === "attachment-pool-full", "third file over the sender's pool -> 507 attachment-pool-full");
  const acct = await hook("v2/acct", { uid: A.uid });
  check(acct.acct.vused === 4000, "attachment bytes count inside the account pool (vused " + acct.acct.vused + ")");
  // expire one -> lazily swept by the next attachment op, bytes freed
  await hook("v2/attach_age", { id: r1.data.id });
  const r4 = await put(api, A, B.uid, "shot", "4.png", f(2000));
  check(r4.status === 200, "after one expires the pool has room again");
  const rows = await hook("v2/attach_rows", { uid: A.uid });
  check(!rows.attach.some((x) => x.id === r1.data.id), "expired row removed lazily (piggybacked on the next op, no cron)");
  const dead = rows.files.find((x) => x.rkey.endsWith("/" + r1.data.id));
  check(!dead, "expired R2 object deleted and unindexed (" + rows.files.length + " object rows)");
  // daily cap: 4 uploads rolling day (r1,r2,r4 + this one) then refused
  const r5 = await put(api, A, B.uid, "shot", "5.png", f(10));
  check(r5.status === 200, "4th upload of the day ok");
  check((await put(api, A, B.uid, "shot", "5b.png", f(10))).status === 200, "4th live upload ok");
  const r6 = await put(api, A, B.uid, "shot", "6.png", f(10));
  check(r6.status === 429 && r6.data.error === "attachment-daily-limit", "next upload of the day -> 429 attachment-daily-limit");
});

await phase("D: TTL 7 days, expired download", {}, async (srv, api, A, B) => {
  const up = await put(api, A, B.uid, "shot", "t.png", randomBytes(500));
  A.send({ type: "message", to: B.uid, text: "x", attach: { id: up.data.id } });
  await B.wait(() => B.find("msg", (x) => x.msg.attach));
  await hook("v2/attach_age", { id: up.data.id });
  const d = await api.call(B, "GET", `/saves/v2/attach?id=${up.data.id}`);
  check(d.status === 410 && d.data.error === "attachment-expired", "expired attachment -> 410 attachment-expired");
  const rows = await hook("v2/attach_rows", { uid: A.uid });
  check(rows.attach.length === 0, "the expired row was deleted by that access");
  A.send({ type: "message", to: B.uid, text: "late", attach: { id: up.data.id } });
  check(await A.wait(() => A.msgs.some((x) => x.type === "error")), "cannot attach an expired file to a new DM");
  const sum = (await hook("sum")).sum, total = (await hook("status")).total;
  check(sum === total, `budget total ${total} == index sum ${sum} after expiry`);
});

await phase("E: budget fails closed", { BUDGET_A_MAX: "1" }, async (srv, api, A, B) => {
  const r1 = await put(api, A, B.uid, "shot", "1.png", randomBytes(100));
  const r2 = await put(api, A, B.uid, "shot", "2.png", randomBytes(100));
  check(r1.status === 200 && r2.status === 429 && r2.data.error === "cloud-saves-paused", "Class A cap reached -> 429 cloud-saves-paused (first ok, second refused)");
  check((await api.call(B, "GET", `/saves/v2/attach?id=${r1.data.id}`)).status === 200, "downloads still work (Class B budget separate)");
  await hook("fail", { on: "1" });
  const r3 = await put(api, A, B.uid, "shot", "3.png", randomBytes(100));
  check(r3.status === 429 && r3.data.error === "cloud-saves-unavailable", "budget DO down -> upload refused (fail closed)");
});

await phase("F: pool pressure", {}, async (srv, api, A, B) => {
  const storage = 7 * 1024 * 1024 * 1024;
  await hook("v2/total", { total: String(Math.floor(storage * 0.75)) });
  const r1 = await put(api, A, B.uid, "state", "big.state", randomBytes(3 * 1024 * 1024));
  check(r1.status === 507 && r1.data.error === "attachment-pool-tight", "tight pool refuses files over 2 MB");
  const r2 = await put(api, A, B.uid, "shot", "s.png", randomBytes(1000));
  check(r2.status === 200, "tight pool still allows a small screenshot");
  await hook("v2/total", { total: String(Math.floor(storage * 0.95)) });
  const r3 = await put(api, A, B.uid, "shot", "s2.png", randomBytes(1001));
  check(r3.status === 507 && r3.data.error === "cloud-saves-full", "full pool refuses new attachments");
});

console.log(st.fails ? `\n${st.fails} FAILED` : "\nALL OK");
process.exit(st.fails ? 1 : 0);
