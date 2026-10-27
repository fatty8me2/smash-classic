// Cloud saves v2 end-to-end tests against LOCAL `wrangler dev` instances (isolated registry, --persist-to C:\rhq\<port>,
// simulated R2; never production). Each phase starts a fresh server with its own caps, so the whole file runs
// sequentially on fresh instances.   Usage: node test_saves_v2.mjs [phase ...]   (A B C D E F; default all)
import { randomBytes } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { createHmac } from "node:crypto";
import { startServer, account, client, makeChecker, devId, sha, sleep, sign, b32 } from "./test_v2_lib.mjs";

const { st, check } = makeChecker();
const rnd = (n) => randomBytes(n);
const nowS = () => Math.floor(Date.now() / 1000);
const BASE_PORT = Number(process.env.SAVES_V2_PORT) || 10021;
const want = process.argv.slice(2).filter((a) => /^[A-G]$/.test(a));
const phases = [];

async function withServer(port, vars, fn, opts = {}) {
  const srv = await startServer({ port, vars, ...opts });
  try { await fn(srv, client(srv.BASE)); } catch (e) { st.fails++; console.log("ERROR:", e); } finally { srv.stop(); await sleep(300); }
}
const manifestOf = async (api, a, q = "") => (await api.manifest(a, q)).data;
const acctDbg = async (api, uid) => api.hook("v2/acct", { uid });
// blobs in the files index == blobs referenced by live versions (no leaks, no dangling refs)
async function blobsConsistent(api, uid, msg, maxOrphans = 0) {
  const d = await acctDbg(api, uid);
  const idx = new Set(d.files.filter((f) => /\/o\/[0-9a-f]{64}(\.z)?$/.test(f.rkey) && f.dead == null).map((f) => f.rkey));
  const ref = new Set(d.vers.filter((v) => v.state !== "evicted" && v.rkey && /\/o\//.test(v.rkey)).map((v) => v.rkey));
  const orphans = [...idx].filter((k) => !ref.has(k)).length;
  check([...ref].every((k) => idx.has(k)) && orphans <= maxOrphans, `${msg}: every referenced blob exists, ${orphans} orphan(s) (<= ${maxOrphans}), ${idx.size} blobs`);
}
async function totalMatchesIndex(api, msg) {
  const total = (await api.hook("status")).total, sum = (await api.hook("sum")).sum;
  check(total === sum, `${msg}: R2Budget total ${total} == index sum ${sum}`);
}
const classA = async (api) => (await api.hook("status")).a;
const files = (m, g) => (m.games[g] ? m.games[g].files : {});

// =====================================================================================================================
// A: endpoints, auth, dedup, retention, restore, CAS, tickets, leases, devices, isolation, rate limits
// =====================================================================================================================
phases.push(["A", async () => withServer(BASE_PORT, { SAVES_RATE_PC: "1000", SAVES_RATE_PUT: "1000", SAVES_RATE_GET: "1000", SAVES_RATE_META: "1000" }, async (srv, api) => {
  console.log("--- phase A: endpoints ---");
  const BASE = srv.BASE;
  const A = await account(BASE), B = await account(BASE);
  const d1 = devId(), d2 = devId();
  const G = "n64/smash-64", G2 = "gba/pokemon";

  // ---- auth ----
  check((await api.call(null, "GET", "/saves/v2/status")).status === 401, "no auth -> 401");
  check((await api.call({ ...A, key: sha("wrong") }, "GET", "/saves/v2/status")).status === 401, "wrong secret -> 401");
  check((await api.call({ uid: b32(26), key: A.key }, "GET", "/saves/v2/status")).status === 401, "unknown uid -> 401");
  const stale = await api.call(A, "GET", "/saves/v2/status", { ts: Date.now() - 3600e3 });
  check(stale.status === 401 && stale.data.error === "stale-timestamp" && Math.abs(stale.data.serverTime - Date.now()) < 60e3, "stale timestamp -> 401 with serverTime to correct the clock");
  const okAuth = sign(A, "GET", "/saves/v2/status");
  check((await fetch(BASE + "/saves/v2/manifest", { headers: { Authorization: okAuth } })).status === 401, "signature is bound to the path");
  check((await fetch(BASE + "/saves/v2/status", { headers: { Authorization: okAuth.replace(A.uid, B.uid) } })).status === 401, "A's signature with B's uid -> 401");
  check((await fetch(BASE + "/saves/v2/status", { method: "POST", headers: { Authorization: okAuth } })).status === 405, "wrong method -> 405");
  check((await api.call(A, "GET", "/saves/v2/nope")).status === 404, "unknown v2 route -> 404");
  const nosha = await api.call(A, "POST", "/saves/v2/device", { json: { dev: d1, name: "x" }, noSha: true });
  check(nosha.status === 400 && nosha.data.error === "bad-sha", "JSON body without X-RH-Sha -> 400");
  const wrongSha = await api.call(A, "POST", "/saves/v2/device", { json: { dev: d1, name: "x" }, shaOverride: sha("other") });
  check(wrongSha.status === 400 && wrongSha.data.error === "bad-sha", "body not matching the signed X-RH-Sha -> 400");
  const badJson = await api.call(A, "POST", "/saves/v2/device", { raw: Buffer.from("{nope"), headers: {} });
  check(badJson.status === 400, "malformed JSON body -> 400");

  // ---- status + devices ----
  const s0 = await api.status(A, d1);
  check(s0.status === 200 && s0.data.account.cap === 52428800 && s0.data.account.protCap === 20971520 && s0.data.account.pool === "ok" && s0.data.account.paused === false, "status: caps 50 MB / 20 MB, pool ok");
  const dv = await api.device(A, d1, "PC-DESK");
  check(dv.status === 200 && dv.data.devices.length === 1 && dv.data.devices[0].name === "PC-DESK", "device registered");
  const dv2 = await api.device(A, d1, "PC-RENAMED\u0001");
  check(dv2.data.devices.length === 1 && dv2.data.devices[0].name === "PC-RENAMED", "device renamed, control chars stripped");
  check((await api.device(A, "BAD ID", "x")).status === 400, "bad device id -> 400");
  await api.device(A, d2, "PC-LIVING");
  const C = await account(BASE);
  for (let i = 0; i < 8; i++) await api.device(C, devId(), "pc" + i);
  const over = await api.device(C, devId(), "ninth");
  check(over.status === 403 && over.data.error === "device-limit", "ninth active device -> 403 device-limit");

  // ---- linked PCs: list + revoke (Settings > Account) ----
  {
    const reg = (a, d, n) => api.call(a, "POST", "/saves/v2/device", { json: { dev: d, name: n }, dev: d });
    const L = await account(BASE);
    const e1 = devId(), e2 = devId(), e3 = devId();
    await reg(L, e1, "PC-ONE"); await reg(L, e2, "PC-TWO"); await reg(L, e3, "PC-THREE");
    const ls = await api.call(L, "GET", "/saves/v2/devices", { dev: e1 });
    check(ls.status === 200 && ls.data.devices.length === 3 && ls.data.devices.map((x) => x.name).join() === "PC-ONE,PC-TWO,PC-THREE", "devices: lists name per PC");
    check(ls.data.devices.filter((x) => x.current).length === 1 && ls.data.devices.find((x) => x.current).dev === e1 && ls.data.devices.every((x) => x.lastSeen > 0), "devices: marks the calling PC, has last seen");
    check((await api.call(null, "GET", "/saves/v2/devices")).status === 401, "devices: needs auth");
    check((await api.call(B, "GET", "/saves/v2/devices", { dev: e1 })).data.devices.length === 0, "devices: another account sees none of these PCs");
    const self = await api.call(L, "POST", "/saves/v2/device/revoke", { json: { dev: e1 }, dev: e1 });
    check(self.status === 400 && self.data.error === "cannot-revoke-self", "revoke: a PC cannot revoke itself");
    const nohdr = await api.call(L, "POST", "/saves/v2/device/revoke", { json: { dev: e2 } });
    check(nohdr.status === 400 && nohdr.data.error === "bad-device", "revoke: needs the caller's device header");
    check((await api.call(B, "POST", "/saves/v2/device/revoke", { json: { dev: e2 }, dev: devId() })).status === 404, "revoke: another account cannot touch these PCs");
    check((await api.call(L, "POST", "/saves/v2/device/revoke", { json: { dev: devId() }, dev: e1 })).status === 404, "revoke: unknown PC -> 404");
    check((await api.call(L, "POST", "/saves/v2/device/revoke", { json: { dev: "BAD ID" }, dev: e1 })).status === 400, "revoke: bad id -> 400");
    check((await api.status(L, e2)).status === 200, "revoked-to-be PC still works before the revoke");
    const rv = await api.call(L, "POST", "/saves/v2/device/revoke", { json: { dev: e2 }, dev: e1 });
    check(rv.status === 200 && rv.data.devices.length === 2 && !rv.data.devices.some((x) => x.dev === e2), "revoke: PC removed from the list");
    const after = await api.status(L, e2);
    check(after.status === 401 && after.data.error === "device-revoked", "revoked PC: next call -> 401 device-revoked");
    check((await api.manifest(L, "", e2)).status === 401, "revoked PC: manifest refused too");
    const re = await reg(L, e2, "PC-TWO");
    check(re.status === 401 && re.data.error === "device-revoked", "revoked PC cannot register again under the same id");
    check((await api.status(L, e1)).status === 200 && (await api.status(L, e3)).status === 200, "other PCs keep working");
    const e4 = devId();
    check((await reg(L, e4, "PC-TWO")).status === 200, "the same PC signs in again with a NEW device id");
    check((await api.call(L, "GET", "/saves/v2/devices", { dev: e4 })).data.devices.length === 3, "list: new id counted, revoked one gone");
    // a full account (8 PCs): revoking one frees the slot for a ninth
    const F = await account(BASE);
    const f = Array.from({ length: 8 }, () => devId());
    for (const [i, d] of f.entries()) await reg(F, d, "pc" + i);
    check((await reg(F, devId(), "ninth")).status === 403, "8 active PCs: ninth refused");
    await api.call(F, "POST", "/saves/v2/device/revoke", { json: { dev: f[7] }, dev: f[0] });
    check((await reg(F, devId(), "ninth")).status === 200, "after a revoke the ninth PC fits");
  }

  // ---- first push: classes, dedup, compression ----
  const ssb = rnd(2000), meta = Buffer.from('{"k":1}'), state = rnd(100000), shot = rnd(3000);
  let r = await api.push(A, G, [{ path: "battery/ssb64.sra", data: ssb, mtime: 100 }, { path: "meta.json", data: meta, mtime: 101 },
    { path: "states/auto.state", data: state, mtime: 102 }, { path: "states/auto.png", data: shot, mtime: 103 }], { dev: d1, played: 5000 });
  const cls = Object.fromEntries(r.plan.data.files.map((f) => [f.path, f.class]));
  check(r.plan.status === 200 && cls["battery/ssb64.sra"] === "battery" && cls["meta.json"] === "settings" && cls["states/auto.state"] === "state" && cls["states/auto.png"] === "shot", "plan classifies by path");
  check(r.plan.data.files.every((f) => f.action === "upload") && r.ups.every((u) => u.status === 200 && !u.data.unchanged), "4 new files -> upload");
  check(r.commit.status === 200 && r.commit.data.results.every((x) => x.cloud === "synced" && x.ver === 1), "commit: all synced as ver 1");
  let m = await manifestOf(api, A);
  check(m.full === true && m.games[G].playedAt === 5000 && m.games[G].device === "PC-RENAMED" && files(m, G)["battery/ssb64.sra"].vers[0].devName === "PC-RENAMED", "manifest: game, played_at, device names");
  check(m.account.used === 2000 + meta.length + 100000 + 3000 && m.account.protUsed === 2000 + meta.length, "manifest: used / protUsed count stored bytes");
  const usedBefore = m.account.used;
  // same content again -> same; same content under a new path -> have (no blob upload, no Class A)
  const a0 = await classA(api);
  r = await api.push(A, G, [{ path: "battery/ssb64.sra", data: ssb, mtime: 100, base: 1 }, { path: "battery/copy.sra", data: ssb, mtime: 100 }], { dev: d1 });
  const act = Object.fromEntries(r.plan.data.files.map((f) => [f.path, f.action]));
  check(act["battery/ssb64.sra"] === "same" && act["battery/copy.sra"] === "have", "identical file -> same; identical content elsewhere -> have");
  check(r.ups.length === 0 && (await classA(api)) === a0, "no blob PUT and no Class A op for dedup");
  m = await manifestOf(api, A);
  check(m.account.used === usedBefore, "a blob shared by two paths is counted once");
  // two new files with identical new content in one plan: one upload
  const dupl = rnd(777);
  r = await api.push(A, G2, [{ path: "battery/a.sav", data: dupl }, { path: "battery/b.sav", data: dupl }], { dev: d1 });
  const acts = r.plan.data.files.map((f) => f.action).sort();
  check(acts[0] === "have" && acts[1] === "upload" && r.ups.length === 1 && r.commit.data.results.every((x) => x.cloud === "synced"), "duplicate content inside one plan uploads once");
  // compressed blob
  const zero = Buffer.alloc(50000, 0);
  r = await api.push(A, G2, [{ path: "battery/big.sav", data: zero, deflate: true, mtime: 5 }], { dev: d1 });
  m = await manifestOf(api, A);
  const zv = files(m, G2)["battery/big.sav"].vers[0];
  check(zv.enc === "deflate" && zv.stored < 1000 && zv.size === 50000 && zv.sha === sha(zero), "deflate blob: stored is small, sha/size are of the plain file");
  const zg = await api.blobGet(A, G2, "battery/big.sav");
  check(zg.status === 200 && zg.headers.get("x-rh-enc") === "deflate" && zg.headers.get("x-rh-plain-sha") === sha(zero) && inflateRawSync(zg.data).equals(zero), "deflate blob downloads and inflates to the original");
  check(m.account.used === usedBefore + 777 + zv.stored, "quota counts the stored (compressed) bytes");

  // ---- download: version, range, other account ----
  const g1 = await api.blobGet(A, G, "battery/ssb64.sra");
  check(g1.status === 200 && g1.data.equals(ssb) && g1.headers.get("x-rh-sha") === sha(ssb) && g1.headers.get("x-rh-size") === "2000", "blob GET returns bytes + headers");
  const rg = await api.blobGet(A, G, "battery/ssb64.sra", null, { Range: "bytes=1500-" });
  check(rg.status === 206 && rg.data.equals(ssb.subarray(1500)) && rg.headers.get("content-range") === "bytes 1500-1999/2000", "Range resume works");
  check((await api.blobGet(A, G, "battery/ssb64.sra", null, { Range: "bytes=2000-" })).status === 416, "Range past the end -> 416");
  check((await api.blobGet(A, G, "nope.sav")).status === 404 && (await api.blobGet(A, G, "battery/ssb64.sra", 99)).status === 404, "unknown path / version -> 404");
  check((await api.blobGet(A, "bad", "x")).status === 400, "bad game key -> 400");
  check((await api.blobGet(B, G, "battery/ssb64.sra")).status === 404, "account B cannot read A's blob");
  check((await manifestOf(api, B)).games && Object.keys((await manifestOf(api, B)).games).length === 0, "account B manifest is empty");
  const bp = await api.push(B, G, [{ path: "battery/ssb64.sra", data: ssb }]);
  check(bp.plan.data.files[0].action === "upload", "no cross-account dedup (B must upload)");

  // ---- retention: protected keeps 3, large keeps 1 ----
  let base = 0, vers = [];
  for (let i = 1; i <= 5; i++) {
    vers.push(rnd(500));
    r = await api.push(A, G, [{ path: "battery/ret.sav", data: vers[i - 1], base, mtime: 200 + i }, { path: "states/ret.state", data: rnd(300), base, mtime: 200 + i }], { dev: d1 });
    base = r.commit.data.results[0].ver;
  }
  m = await manifestOf(api, A);
  const rv = files(m, G)["battery/ret.sav"];
  check(rv.cur === 5 && rv.vers.map((v) => v.ver).join() === "5,4,3", "protected file retains the last 3 versions (newest first)");
  check(files(m, G)["states/ret.state"].vers.length === 1 && files(m, G)["states/ret.state"].cur === 5, "large file retains 1 version");
  await blobsConsistent(api, A.uid, "after retention");
  await totalMatchesIndex(api, "after retention");
  const old3 = await api.blobGet(A, G, "battery/ret.sav", 3);
  check(old3.status === 200 && old3.data.equals(vers[2]), "an older retained version can be downloaded");
  check((await api.blobGet(A, G, "battery/ret.sav", 2)).status === 404, "dropped versions are gone");

  // ---- restore ----
  const a1 = await classA(api);
  const rs = await api.restore(A, G, "battery/ret.sav", 3, 5);
  check(rs.status === 200 && rs.data.ver === 6, "restore ver 3 -> becomes ver 6");
  check((await classA(api)) === a1, "restore costs no R2 op");
  check((await api.blobGet(A, G, "battery/ret.sav")).data.equals(vers[2]), "restored content is current");
  m = await manifestOf(api, A);
  check(files(m, G)["battery/ret.sav"].vers.map((v) => v.ver).join() === "6,5,4", "history after restore: 6,5,4");
  const rs2 = await api.restore(A, G, "battery/ret.sav", 4, 5);
  check(rs2.status === 412 && rs2.data.error === "conflict" && rs2.data.current.ver === 6, "restore with a stale base -> 412 + current");
  check((await api.restore(A, G, "battery/ret.sav", 1, 6)).status === 404, "restore of a version that is no longer retained -> 404");
  check((await api.restore(A, G, "nope/x", 1, 0)).status === 404, "restore of an unknown file -> 404");
  await blobsConsistent(api, A.uid, "after restore");

  // ---- CAS conflicts ----
  const cur = files(m, G)["battery/ssb64.sra"].cur;
  const x1 = rnd(100);
  let p1 = await api.plan(A, G, [{ path: "battery/cas.sav", sha: sha(x1), size: 100, stored: 100, enc: "none", mtime: 1, base: 0 }], { dev: d1 });
  await api.blobPut(A, sha(x1), p1.data.ticket, x1, d1);
  const other = await api.push(A, G, [{ path: "battery/cas.sav", data: rnd(50), base: 0 }], { dev: d2 });   // another PC wins the race
  const c1 = await api.commit(A, p1.data.ticket, d1);
  check(c1.status === 200 && c1.data.results[0].cloud === "conflict" && c1.data.results[0].current.ver === 1, "commit CAS miss -> that file is a conflict (with current)");
  check(files(await manifestOf(api, A), G)["battery/cas.sav"].cur === 1, "the losing commit changed nothing");
  const pc = await api.plan(A, G, [{ path: "battery/cas.sav", sha: sha(x1), size: 100, stored: 100, enc: "none", mtime: 1, base: 0 }]);
  check(pc.data.files[0].action === "conflict" && pc.data.files[0].current.ver === 1 && pc.data.ticket === null, "plan with a wrong base -> conflict, no ticket");
  const c2 = await api.commit(A, other.plan.data.ticket, d2);
  check(c2.status === 200 && c2.data.replay === true && c2.data.results[0].ver === 1, "re-sending a commit is idempotent (replay)");
  check(files(await manifestOf(api, A), G)["battery/cas.sav"].vers.length === 1, "replay did not add a version");
  check(cur >= 1, "(sanity) ssb64 cur known");
  // mixed commit: conflict on one file does not affect the others
  const y = rnd(64), z = rnd(65);
  const sp = [{ path: "battery/m1.sav", sha: sha(y), size: 64, stored: 64, enc: "none", mtime: 1, base: 0 }, { path: "battery/cas.sav", sha: sha(z), size: 65, stored: 65, enc: "none", mtime: 1, base: 1 }];
  const pm = await api.plan(A, G, sp);
  await api.blobPut(A, sha(y), pm.data.ticket, y); await api.blobPut(A, sha(z), pm.data.ticket, z);
  await api.push(A, G, [{ path: "battery/cas.sav", data: rnd(66), base: 1 }]);
  const cm = await api.commit(A, pm.data.ticket);
  const byPath = Object.fromEntries(cm.data.results.map((x) => [x.path, x]));
  check(byPath["battery/m1.sav"].cloud === "synced" && byPath["battery/cas.sav"].cloud === "conflict", "per-file CAS: one conflict, the other file still commits");

  // ---- tickets and blob PUT validation ----
  const t1 = rnd(100);
  const pt = await api.plan(A, G, [{ path: "battery/t.sav", sha: sha(t1), size: 100, stored: 100, enc: "none", mtime: 1, base: 0 }]);
  const tk = pt.data.ticket;
  const wl = await api.blobPut(A, sha(t1), tk, t1.subarray(0, 99), d1, sha(t1.subarray(0, 99)));
  check(wl.status === 400 && wl.data.error === "bad-body", "blob with the wrong length -> 400");
  const wsha = await api.blobPut(A, sha(t1), tk, t1, d1, sha("different"));
  check(wsha.status === 400, "blob not matching X-RH-Sha -> 400");
  const cmiss = await api.commit(A, tk);
  check(cmiss.status === 200 && cmiss.data.results[0].cloud === "missing", "commit without the blob -> missing (nothing committed)");
  check((await api.blobPut(A, sha(rnd(9)), tk, t1)).status === 400, "blob whose sha is not in the ticket -> 400");
  check((await api.blobPut(B, sha(t1), tk, t1)).status === 409, "another account cannot use A's ticket");
  check((await api.blobPut(A, sha(t1), "0".repeat(40), t1)).status === 409, "unknown ticket -> 409 ticket-expired");
  check((await api.blobPut(A, sha(t1), tk, t1)).status === 200, "correct blob accepted after the failures");
  check((await api.blobPut(A, sha(t1), tk, t1)).data.unchanged === true, "uploading the same blob twice is idempotent");
  const cok = await api.commit(A, tk);
  check(cok.data.results[0].cloud === "synced", "commit works after the missing blob was uploaded");
  await api.hook("v2/expire_ticket", { uid: A.uid });
  const ce = await api.commit(A, tk);
  check(ce.status === 409 && ce.data.error === "ticket-expired", "expired ticket -> 409 ticket-expired");
  check((await api.commit(A, "zz")).status === 400, "malformed ticket -> 400");
  await blobsConsistent(api, A.uid, "after ticket failures", 6);
  const bigBody = Buffer.alloc(16 * 1024 * 1024 + 1, 1);
  const bigR = await api.blobPut(A, sha(bigBody), tk, bigBody);
  check(bigR.status === 413, "blob over 16 MB -> 413");

  // ---- plan validation ----
  const okFile = { path: "battery/v.sav", sha: sha("v"), size: 1, stored: 1, enc: "none", mtime: 1, base: 0 };
  for (const [label, f] of [["path ../x", { ...okFile, path: "../x" }], ["path a/../b", { ...okFile, path: "a/../b" }], ["path _identity/x", { ...okFile, path: "_identity/x" }],
    ["path .hubtmp", { ...okFile, path: "x.hubtmp" }], ["path backslash", { ...okFile, path: "a\\b" }], ["path //", { ...okFile, path: "a//b" }], ["bad sha", { ...okFile, sha: "xyz" }],
    ["stored != size for enc none", { ...okFile, stored: 5 }], ["bad enc", { ...okFile, enc: "gzip" }], ["negative size", { ...okFile, size: -1 }], ["fractional mtime", { ...okFile, mtime: 1.5 }]]) {
    const pr = await api.plan(A, G, [f]);
    check(pr.status === 400 && pr.data.error === "bad-plan", `bad plan rejected: ${label}`);
  }
  check((await api.plan(A, "n64", [okFile])).status === 400, "bad game key rejected");
  check((await api.plan(A, G, [okFile], { mode: "readonly" })).status === 400, "readonly plans are refused (nothing is pushed)");
  check((await api.plan(A, G, [okFile, okFile])).status === 400, "duplicate path in a plan -> 400");
  const many = Array.from({ length: 201 }, (_, i) => ({ ...okFile, path: `battery/f${i}.sav` }));
  check((await api.plan(A, G, many)).status === 400, "more than 200 files -> 400");
  const huge = await api.call(A, "POST", "/saves/v2/plan", { json: { game: "x".repeat(70000), played_at: 1, mode: "rw", files: [] } });
  check(huge.status === 413, "plan body over 64 KB -> 413");
  const empty = await api.plan(A, G, []);
  check(empty.status === 200 && empty.data.ticket === null, "empty plan is fine and has no ticket");

  // ---- manifest delta / game filter ----
  m = await manifestOf(api, A);
  const rev0 = m.rev;
  await api.push(A, "snes/zelda", [{ path: "battery/z.srm", data: rnd(300) }], { dev: d1 });
  const md = await manifestOf(api, A, `?since=${rev0}`);
  check(md.full === false && Object.keys(md.games).join() === "snes/zelda" && md.rev > rev0, "manifest?since returns only changed games");
  check((await manifestOf(api, A, `?since=${md.rev + 50}`)).full === true, "a since newer than the server's rev -> full");
  const mg = await manifestOf(api, A, `?game=${encodeURIComponent(G)}`);
  check(Object.keys(mg.games).join() === G, "manifest?game= filters one game");
  check((await api.manifest(A, "?game=bad")).status === 400, "manifest with a bad game key -> 400");

  // ---- leases ----
  const gl = "n64/lease-game";
  check((await api.lease(A, gl, "rw", d1)).status === 200, "lease taken by PC 1");
  const held = await api.lease(A, gl, "rw", d2);
  check(held.status === 423 && held.data.error === "lease-held" && held.data.held.dev === d1 && held.data.held.name === "PC-RENAMED", "second PC gets 423 with the holder's name");
  const ro = await api.lease(A, gl, "readonly", d2);
  check(ro.status === 200 && ro.data.lease === false, "readonly never takes (or checks) a lease");
  check((await manifestOf(api, A)).games[gl].lease.dev === d1, "manifest shows the lease");
  check((await api.beat(A, gl, d1)).status === 200, "holder heartbeat extends");
  const take = await api.lease(A, gl, "rw", d2, true);
  check(take.status === 200 && take.data.tookOver === true, "take over moves the lease");
  const lost = await api.beat(A, gl, d1);
  check(lost.status === 423, "the old holder's heartbeat now fails (423)");
  check((await api.release(A, gl, d1)).status === 200 && (await manifestOf(api, A)).games[gl].lease.dev === d2, "release by a non-holder changes nothing");
  await api.release(A, gl, d2);
  check(!(await manifestOf(api, A)).games[gl].lease, "release by the holder clears it");
  await api.lease(A, gl, "rw", d1);
  await api.hook("v2/lease_expire", { uid: A.uid });
  check((await api.lease(A, gl, "rw", d2)).status === 200, "an expired lease can simply be taken");
  check((await api.lease(A, gl, "rw", "bad id")).status === 400, "lease without a valid device id -> 400");

  // ---- "another PC" = same account, different device: sees the same cloud data ----
  const pc2 = await api.manifest(A, "", d2);
  check(pc2.data.games[G] && Object.keys(pc2.data.games).length >= 3, "second PC of the same account sees the same games");
  const pcSame = await api.plan(A, G, [{ path: "battery/ssb64.sra", sha: sha(ssb), size: 2000, stored: 2000, enc: "none", mtime: 100, base: 1 }], { dev: d2 });
  check(pcSame.data.files[0].action === "same", "second PC compares against the same cloud versions");

  // ---- orphaned blobs (lost CAS races, abandoned tickets) are collected after an hour ----
  await api.hook("v2/expire_ticket", { uid: A.uid });
  await api.hook("v2/age_blobs", { uid: A.uid });
  await api.push(A, G, [{ path: "battery/gc.sav", data: rnd(30) }], { dev: d1 });
  await blobsConsistent(api, A.uid, "after orphan gc", 0);
  await totalMatchesIndex(api, "after orphan gc");

  // ---- consistency after reconcile ----
  const before = (await acctDbg(api, A.uid)).acct;
  await api.hook("reconcile");
  const after = (await acctDbg(api, A.uid)).acct;
  check(after.vused === before.vused && after.v2 === 1 && after.rev === before.rev, "reconcile keeps the v2 account columns");
  m = await manifestOf(api, A);
  check(Object.keys(m.games).length >= 4, "manifest intact after reconcile");
  await totalMatchesIndex(api, "after reconcile");
  const post = await api.push(A, G, [{ path: "battery/after.sav", data: rnd(40) }]);
  if (!post.commit) console.log("POST", JSON.stringify(post.plan.data));
  check(post.commit && post.commit.data.results[0].cloud === "synced", "pushing still works after reconcile");

}, {})]);

// =====================================================================================================================
// B: quota accounting, protected ceiling, LRU eviction, pin, remove
// =====================================================================================================================
phases.push(["B", async () => withServer(BASE_PORT + 1, { ACCOUNT_CAP: "100000", PROT_CAP: "30000" }, async (srv, api) => {
  console.log("--- phase B: quota + eviction ---");
  const S = await account(srv.BASE);
  const dev = devId();
  await api.device(S, dev, "PC-B");
  const st1 = (await api.status(S)).data.account;
  check(st1.cap === 100000 && st1.protCap === 30000, "caps come from vars (ACCOUNT_CAP / PROT_CAP)");
  const push = async (game, path, size, played, extra = {}) => {
    const r = await api.push(S, game, [{ path, data: rnd(size), mtime: played, base: extra.base ?? 0 }], { dev, played });
    return r;
  };
  const g = (n) => `n64/g${n}`;
  for (let i = 1; i <= 3; i++) { const r = await push(g(i), "states/a.state", 30000, i * 100); check(r.commit.data.results[0].cloud === "synced" && r.commit.data.evicted.length === 0, `game ${i}: 30000 state fits`); }
  let m = await manifestOf(api, S);
  check(m.account.used === 90000, "used = 90000 of 100000");
  // 4th: needs 20000 -> evicts the least recently played game's large item
  let r = await push(g(4), "states/a.state", 30000, 400);
  check(r.commit.data.results[0].cloud === "synced" && r.commit.data.evicted.length === 1 && r.commit.data.evicted[0].game === g(1) && r.commit.data.evicted[0].path === "states/a.state", "4th state evicts the LRU game's state (game 1)");
  m = await manifestOf(api, S);
  check(m.account.used === 90000 && files(m, g(1))["states/a.state"].cloud === "evicted" && files(m, g(1))["states/a.state"].vers.length === 0, "evicted file is a tombstone (cloud:evicted, no versions)");
  check(files(m, g(4))["states/a.state"].cloud === "synced", "new state is stored");
  await blobsConsistent(api, S.uid, "after first eviction");
  await totalMatchesIndex(api, "after first eviction");
  const ev = await api.blobGet(S, g(1), "states/a.state");
  check(ev.status === 404 && ev.data.evicted === true, "downloading an evicted file -> 404 evicted:true");
  // pin game 2 -> it is evicted last
  const pin = await api.gameOp(S, { game: g(2), pin: true });
  check(pin.status === 200 && (await manifestOf(api, S)).games[g(2)].pin === true, "pin recorded");
  r = await push(g(5), "states/a.state", 30000, 500);
  check(r.commit.data.evicted.length === 1 && r.commit.data.evicted[0].game === g(3), "pinned game 2 survives; game 3 (next LRU) is evicted");
  // the game being saved is never evicted: game 1 pushes again with base = tombstone ver
  const tomb = files(await manifestOf(api, S), g(1))["states/a.state"].cur;
  const pc = await api.plan(S, g(1), [{ path: "states/a.state", sha: sha(rnd(5)), size: 30000, stored: 30000, enc: "none", mtime: 1, base: 0 }]);
  check(pc.data.files[0].action === "conflict" && pc.data.files[0].current.cloud === "evicted", "plan against a tombstone with base 0 -> conflict showing cloud:evicted");
  r = await push(g(1), "states/a.state", 30000, 600, { base: tomb });
  check(r.commit.data.results[0].cloud === "synced" && r.commit.data.evicted.length === 1 && r.commit.data.evicted[0].game === g(4), "pushing game 1 again evicts others (game 4), never itself");
  // too large for the whole cap
  const big = await api.plan(S, g(6), [{ path: "states/huge.state", sha: sha(rnd(4)), size: 120000, stored: 120000, enc: "none", mtime: 1, base: 0 }]);
  check(big.status === 200 && big.data.files[0].action === "skip" && big.data.files[0].reason === "over-cap" && big.data.ticket === null, "an item bigger than the account cap -> skip over-cap");
  const huge = await api.plan(S, g(6), [{ path: "states/huge.state", sha: sha(rnd(4)), size: 20 * 1024 * 1024, stored: 17 * 1024 * 1024, enc: "deflate", mtime: 1, base: 0 }]);
  check(huge.data.files[0].reason === "too-large", "stored > 16 MB -> skip too-large");
  // protected data takes precedence over large items
  r = await push(g(7), "battery/s.sra", 20000, 700);
  m = await manifestOf(api, S);
  check(r.commit.data.results[0].cloud === "synced" && r.commit.data.evicted.length === 1 && r.commit.data.evicted[0].game === g(5) && m.account.used <= 100000 && m.account.protUsed === 20000, "a protected file evicts large items to make room (game 5, LRU)");
  // protected ceiling
  const p2 = await api.plan(S, g(8), [{ path: "battery/s2.sra", sha: sha(rnd(4)), size: 20000, stored: 20000, enc: "none", mtime: 1, base: 0 }]);
  check(p2.status === 507 && p2.data.error === "too-big-protected", "protected data above the 30000 ceiling -> 507 too-big-protected");
  const p3 = await api.plan(S, g(8), [{ path: "battery/s2.sra", sha: sha(rnd(4)), size: 20000, stored: 20000, enc: "none", mtime: 1, base: 0 }, { path: "battery/small.sra", sha: sha(rnd(5)), size: 5000, stored: 5000, enc: "none", mtime: 1, base: 0 }]);
  const pa = Object.fromEntries(p3.data.files.map((f) => [f.path, f]));
  check(p3.status === 200 && pa["battery/s2.sra"].reason === "too-big-protected" && pa["battery/small.sra"].action === "upload", "mixed plan: the oversized protected file is skipped, the small one goes on");
  // history counts against the protected ceiling
  const hv = await api.plan(S, g(7), [{ path: "battery/s.sra", sha: sha(rnd(4)), size: 20000, stored: 20000, enc: "none", mtime: 2, base: 1 }]);
  check(hv.status === 507 && hv.data.error === "too-big-protected", "kept history counts: a second 20000 version would exceed the protected ceiling");
  // remove a game from the cloud
  const usedBefore = (await manifestOf(api, S)).account.used;
  const rm = await api.gameOp(S, { game: g(1), remove: true });
  m = await manifestOf(api, S);
  check(rm.status === 200 && Object.keys(files(m, g(1))).length === 0 && m.account.used === usedBefore - 30000, "remove drops all versions and frees the quota");
  check((await api.gameOp(S, { game: "n64/never", remove: true })).status === 404, "removing an unknown game -> 404");
  await blobsConsistent(api, S.uid, "after remove");
  await totalMatchesIndex(api, "after remove");
  check((await api.gameOp(S, { game: g(2), pin: "yes" })).status === 400, "bad pin value -> 400");
  // file/path limits
}, {})]);

// =====================================================================================================================
// C: global pressure (tight / full), floor, fair-share eviction, idle sweep
// =====================================================================================================================
phases.push(["C", async () => withServer(BASE_PORT + 2, { BUDGET_STORAGE_MAX: "1000000", ACCOUNT_CAP: "300000", PROT_CAP: "100000" }, async (srv, api) => {
  console.log("--- phase C: pool pressure ---");
  const setTotal = (t) => api.hook("v2/total", { total: String(t) });
  const X = await account(srv.BASE), Y = await account(srv.BASE);
  const dx = devId(), dy = devId();
  const pushS = (a, dev, game, path, size, played, base = 0) => api.push(a, game, [{ path, data: rnd(size), mtime: played, base }], { dev, played });
  for (let i = 1; i <= 4; i++) await pushS(X, dx, `n64/x${i}`, "states/a.state", 50000, i * 10);
  await pushS(Y, dy, "n64/y1", "states/a.state", 50000, 5);
  let m = await manifestOf(api, X);
  check(m.account.used === 200000 && m.account.pool === "ok" && m.account.largeCap === 300000, "pool ok: large cap is the whole account cap");
  // tight 75%: cap 180000 (60% of the account cap) -> X is above it and shrinks on its next commit
  await setTotal(750000);
  check((await manifestOf(api, X)).account.pool === "tight" && (await manifestOf(api, X)).account.largeCap === 180000, "tight (75%): large cap 60% of the account cap");
  let r = await pushS(X, dx, "n64/x5", "battery/b.sra", 1000, 50);
  check(r.commit.data.evicted.length === 1 && r.commit.data.evicted[0].game === "n64/x1", "tight: the next commit shrinks the account (LRU game x1 goes)");
  m = await manifestOf(api, X);
  check(m.account.used - m.account.protUsed === 150000, "large items now 150000 <= 180000");
  // 85%: 40% = 120000
  await setTotal(850000);
  check((await manifestOf(api, X)).account.largeCap === 120000, "tight (85%): large cap 40%");
  r = await pushS(X, dx, "n64/x5", "meta.json", 100, 51);
  check(r.commit.data.evicted.length === 1 && r.commit.data.evicted[0].game === "n64/x2", "85%: shrinks again (x2)");
  // an account under the floor (20% = 60000) is never shrunk
  r = await pushS(Y, dy, "n64/y2", "battery/b.sra", 500, 6);
  check(r.commit.data.evicted.length === 0 && (await manifestOf(api, Y)).account.used - (await manifestOf(api, Y)).account.protUsed === 50000, "an account at or under the 10 MB-equivalent floor keeps its large items");
  // full 95%
  await setTotal(950000);
  const fm = (await manifestOf(api, X)).account;
  check(fm.pool === "full" && fm.largeCap === 60000, "full: large cap is the floor");
  const pf = await api.plan(X, "n64/x9", [{ path: "states/new.state", sha: sha(rnd(3)), size: 1000, stored: 1000, enc: "none", mtime: 1, base: 0 }, { path: "battery/new.sra", sha: sha(rnd(4)), size: 1000, stored: 1000, enc: "none", mtime: 1, base: 0 }]);
  const pfa = Object.fromEntries(pf.data.files.map((f) => [f.path, f.action + ":" + (f.reason || "")]));
  check(pfa["states/new.state"] === "skip:over-cap" && pfa["battery/new.sra"] === "upload:", "full: no new large items accepted, protected still accepted");
  // X shrinks to the full-pool floor on its own commit
  r = await pushS(X, dx, "n64/x9", "battery/new2.sra", 800, 60);
  m = await manifestOf(api, X);
  check(m.account.used - m.account.protUsed <= 60000, "full: X shrunk to the floor (<= 60000 large)");
  check(files(m, "n64/x5")["battery/b.sra"].cloud === "synced" && files(m, "n64/x5")["meta.json"].cloud === "synced", "protected data is never evicted for pressure");

  // global fair-share eviction: P holds a lot of large data; Q's commit (full pool) evicts P's LRP items
  await setTotal(0);
  const P = await account(srv.BASE), Q = await account(srv.BASE);
  const dp = devId(), dq = devId();
  for (let i = 1; i <= 9; i++) await pushS(P, dp, `snes/p${i}`, "states/a.state", 25000, i);
  await pushS(P, dp, "snes/p1", "battery/p.srm", 400, 1);
  await pushS(Q, dq, "snes/q1", "states/a.state", 10000, 1);
  const revP = (await manifestOf(api, P)).rev;
  await setTotal(960000);
  r = await pushS(Q, dq, "snes/q2", "battery/q.srm", 300, 2);
  const mp = await manifestOf(api, P, `?since=${revP}`);
  const evictedP = Object.entries(mp.games).filter(([, gm]) => Object.values(gm.files).some((f) => f.cloud === "evicted")).map(([k]) => k).sort();
  check(evictedP.join() === "snes/p1,snes/p2,snes/p3,snes/p4", `fair share: P (above its share) lost its 4 least recently played large items (${evictedP})`);
  check(mp.rev > revP && mp.full === false, "P's manifest delta shows the evictions");
  check(files(await manifestOf(api, P), "snes/p1")["battery/p.srm"].cloud === "synced", "P's protected data survives global pressure");
  const mq = await manifestOf(api, Q);
  check(files(mq, "snes/q1")["states/a.state"].cloud === "synced", "Q (under its fair share) loses nothing");
  const mx = await manifestOf(api, Y);
  check(files(mx, "n64/y1")["states/a.state"].cloud === "synced", "Y (under its fair share) loses nothing");
  await blobsConsistent(api, P.uid, "P after global eviction");

  // inactivity: 90 days (only under pressure) / 24 months
  await setTotal(750000);
  const I = await account(srv.BASE);
  const di = devId();
  await pushS(I, di, "gba/i1", "states/a.state", 20000, 1);
  await pushS(I, di, "gba/i1", "battery/i.sav", 500, 1);
  await api.hook("v2/active", { uid: I.uid, active: String(nowS() - 100 * 86400) });
  await api.hook("v2/sweep");
  let mi = await manifestOf(api, I);
  check(files(mi, "gba/i1")["states/a.state"].cloud === "evicted" && files(mi, "gba/i1")["battery/i.sav"].cloud === "synced", "idle 100 days + tight pool: large items evicted, protected data kept");
  await setTotal(0);
  const J = await account(srv.BASE), K = await account(srv.BASE);
  await pushS(J, devId(), "gba/j1", "states/a.state", 20000, 1);
  await pushS(K, devId(), "gba/k1", "battery/k.sav", 600, 1);
  await api.hook("v2/active", { uid: J.uid, active: String(nowS() - 100 * 86400) });
  await api.hook("v2/active", { uid: K.uid, active: String(nowS() - 800 * 86400) });
  await api.hook("v2/sweep");
  check(files(await manifestOf(api, J), "gba/j1")["states/a.state"].cloud === "synced", "idle 100 days but pool ok: nothing evicted");
  const mk = await manifestOf(api, K);
  check(Object.keys(mk.games).length === 0 && mk.account.used === 0, "idle for 24+ months: everything removed");
  await blobsConsistent(api, K.uid, "after 24 month removal");
}, {})]);

// =====================================================================================================================
// D: budgets - fail closed, request share, Class A / storage guards, daily per-account limits, kill switch
// =====================================================================================================================
phases.push(["D", async () => {
  await withServer(BASE_PORT + 3, { BUDGET_A_MAX: "3", BUDGET_STORAGE_MAX: "100000", DAY_PUT_MAX: "100" }, async (srv, api) => {
    console.log("--- phase D1: R2 budget guards ---");
    const A = await account(srv.BASE);
    const fl = (n, base = 0) => Array.from({ length: n }, () => rnd(100)).map((b, i) => ({ path: `battery/f${base + i}.sav`, data: b }));
    let r = await api.push(A, "n64/d1", fl(3));
    check(r.commit.data.results.length === 3 && r.commit.data.results.every((x) => x.cloud === "synced"), "3 uploads fit in a Class A budget of 3");
    const p = await api.plan(A, "n64/d1", fl(1, 10).map((f) => ({ path: f.path, sha: sha(f.data), size: 100, stored: 100, enc: "none", mtime: 1, base: 0 })));
    check(p.status === 429 && p.data.error === "cloud-saves-paused" && p.data.retryAfter > 0, "Class A exhausted: plan refuses uploads with 429 cloud-saves-paused");
    const same = await api.plan(A, "n64/d1", [{ path: "battery/f0.sav", sha: sha("x"), size: 1, stored: 1, enc: "none", mtime: 1, base: 1 }]);
    check(same.status === 429, "(plan needing an upload is paused even for an update)");
    const mm = await api.manifest(A);
    check(mm.status === 200 && mm.data.account.paused === true, "manifest/status still answer and report paused");
    // storage guard 100000 total
    const B2 = await account(srv.BASE);
    const pb = await api.plan(B2, "n64/d2", [{ path: "states/s.state", sha: sha(rnd(3)), size: 200000, stored: 200000, enc: "none", mtime: 1, base: 0 }]);
    check(pb.status === 429 || pb.status === 507, "global storage / budget guards stop a huge upload");
  });
  await withServer(BASE_PORT + 11, {}, async (srv, api) => {
    console.log("--- phase D0: per-account per-minute rate limits (default limits) ---");
    const okFile = { path: "battery/v.sav", sha: "bad", size: 1, stored: 1, enc: "none", mtime: 1, base: 0 };
    const R = await account(srv.BASE);
    let limited = null, n = 0;
    for (; n < 40 && !limited; n++) { const x = await api.plan(R, "n64/g", [okFile]); if (x.status === 429) limited = x; }
    check(limited && limited.data.error === "rate-limited" && limited.data.retryAfter > 0 && n === 31, `plan/commit class: the 31st call in a minute is 429 rate-limited (n=${n})`);
    const R2 = await account(srv.BASE);
    let lim2 = null, m = 0;
    for (; m < 70 && !lim2; m++) { const x = await api.manifest(R2); if (x.status === 429) lim2 = x; }
    check(lim2 && lim2.data.error === "rate-limited" && m === 61, `manifest/status class: the 61st call in a minute is 429 (m=${m})`);
    const R3 = await account(srv.BASE);
    check((await api.manifest(R3)).status === 200, "other accounts are unaffected by someone else's limit");
    const bb = rnd(10);
    let lim3 = null;
    const pp = await api.plan(R3, "n64/g", [{ path: "battery/a.sav", sha: sha(bb), size: 10, stored: 10, enc: "none", mtime: 1, base: 0 }]);
    for (let i = 0; i < 130 && !lim3; i++) { const x = await api.blobPut(R3, sha(bb), pp.data.ticket, bb); if (x.status === 429) lim3 = x; }
    check(lim3 && lim3.data.error === "rate-limited", "blob PUT class: 120 per minute -> 429");
    let lim4 = null;
    for (let i = 0; i < 310 && !lim4; i++) { const x = await api.blobGet(R3, "n64/g", "battery/none.sav"); if (x.status === 429) lim4 = x; }
    check(lim4 && lim4.data.error === "rate-limited", "blob GET class: 300 per minute -> 429");
  });
  await withServer(BASE_PORT + 4, { BUDGET_STORAGE_MAX: "5000" }, async (srv, api) => {
    console.log("--- phase D2: storage guard ---");
    const A = await account(srv.BASE);
    const pb = await api.plan(A, "n64/d2", [{ path: "battery/s.sav", sha: sha(rnd(3)), size: 6000, stored: 6000, enc: "none", mtime: 1, base: 0 }]);
    check(pb.status === 507 && pb.data.error === "cloud-saves-full", "global storage guard: 507 cloud-saves-full");
  });
  await withServer(BASE_PORT + 5, { DAY_PUT_MAX: "3", DAY_GET_MAX: "2" }, async (srv, api) => {
    console.log("--- phase D3: per-account daily limits ---");
    const A = await account(srv.BASE);
    const mk = (n, b = 0) => Array.from({ length: n }, (_, i) => ({ path: `battery/f${b + i}.sav`, data: rnd(100) }));
    const big = await api.plan(A, "n64/d", mk(4).map((f) => ({ path: f.path, sha: sha(f.data), size: 100, stored: 100, enc: "none", mtime: 1, base: 0 })));
    check(big.status === 429 && big.data.error === "account-daily-limit" && big.data.retryAfter > 0 && big.data.retryAfter <= 86400, "plan needing more PUTs than the daily limit -> 429 account-daily-limit (+ retryAfter to midnight)");
    const r1 = await api.push(A, "n64/d", mk(3));
    check(r1.commit.data.results.every((x) => x.cloud === "synced"), "3 PUTs allowed");
    const p4 = await api.plan(A, "n64/d", mk(1, 7).map((f) => ({ path: f.path, sha: sha(f.data), size: 100, stored: 100, enc: "none", mtime: 1, base: 0 })));
    check(p4.status === 429 && p4.data.error === "account-daily-limit", "4th PUT of the day refused");
    const gets = [];
    for (let i = 0; i < 3; i++) gets.push((await api.blobGet(A, "n64/d", "battery/f0.sav")).status);
    check(gets[0] === 200 && gets[1] === 200 && gets[2] === 429, "3rd GET of the day refused (limit 2 here)");
    const other = await account(srv.BASE);
    check((await api.push(other, "n64/d", mk(1))).commit.status === 200, "another account has its own daily budget");
  });
  await withServer(BASE_PORT + 6, { DAILY_REQ_CAP: "200" }, async (srv, api) => {
    console.log("--- phase D4: saves share of the request budget (35%) ---");
    const A = await account(srv.BASE);
    let busy = null, n = 0;
    for (; n < 120 && !busy; n++) { const x = await api.manifest(A); if (x.status === 429) busy = x; }
    check(busy && busy.data.error === "cloud-saves-busy-today" && busy.data.retryAfter > 0, `request units exhausted after ${n} calls -> 429 cloud-saves-busy-today`);
    check((await api.status(A)).status === 200, "status stays answerable (cheap probe)");
    check((await fetch(srv.BASE + "/health")).ok, "the rest of the Worker is unaffected");
  });
  await withServer(BASE_PORT + 7, {}, async (srv, api) => {
    console.log("--- phase D5: fail closed ---");
    const A = await account(srv.BASE);
    check((await api.status(A)).status === 200, "healthy first");
    await api.hook("fail", { on: "1" });
    const f1 = await api.manifest(A), f2 = await api.plan(A, "n64/x", []);
    check(f1.status === 429 && f1.data.error === "cloud-saves-unavailable" && f2.status === 429, "budget DO failing -> v2 refuses (429 cloud-saves-unavailable), never touches R2");
    await api.hook("fail", { on: "0" });
    check((await api.manifest(A)).status === 200, "recovers when the budget DO is back");
  });
  await withServer(BASE_PORT + 8, { SAVES_V2: "0" }, async (srv, api) => {
    console.log("--- phase D6: SAVES_V2=0 kill switch ---");
    const A = await account(srv.BASE);
    const r = await api.status(A);
    check(r.status === 503 && r.data.error === "cloud-saves-disabled", "SAVES_V2=0 -> 503 cloud-saves-disabled");
    const put = await v1put(srv.BASE, A, "x/y/battery/a.sav", Buffer.from("hello"));
    check(put.status === 200, "v1 keeps working with SAVES_V2=0");
  });
  await withServer(BASE_PORT + 9, {}, async (srv, api) => {
    const r = await fetch(srv.BASE + "/saves/v2/status");
    check(r.status === 503 && (await r.json()).error === "cloud-saves-disabled", "no R2 binding -> v2 routes 503 cloud-saves-disabled");
    check((await fetch(srv.BASE + "/health")).ok, "rest of the worker healthy without R2");
  }, { nor2: true });
}]);

// =====================================================================================================================
// E: old (v1) clients against the v2 server: compat, conversion, write-through, caps
// =====================================================================================================================
function sign1(a, method, pathq, shaHdr, hdrs = {}) {
  const ts = Date.now(), v = (n) => hdrs[n] ?? "-";
  const msg = `${method}\n${pathq}\n${ts}\n${shaHdr || "-"}\n${v("If-Match")}\n${v("If-None-Match")}\n${v("Content-Length")}\n${v("X-RH-Mtime")}`;
  return `RHSIG uid=${a.uid},ts=${ts},sig=${createHmac("sha256", a.key).update(msg).digest("hex")}`;
}
async function v1call(BASE, a, method, pathq, body, extra = {}) {
  const h = {};
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) h[k] = v;
  if (body !== undefined) h["X-RH-Sha"] = sha(body);
  h.Authorization = sign1(a, method, pathq, h["X-RH-Sha"], { ...h, ...(body !== undefined ? { "Content-Length": String(body.length) } : {}) });
  const r = await fetch(BASE + pathq, { method, headers: h, body });
  const ct = r.headers.get("content-type") || "";
  return { status: r.status, data: ct.includes("json") ? await r.json() : Buffer.from(await r.arrayBuffer()) };
}
const K = (k) => `/saves/obj?key=${encodeURIComponent(k)}`;
const v1put = (BASE, a, key, body, mtime = "1000", extra = {}) => v1call(BASE, a, "PUT", K(key), body, { "X-RH-Mtime": mtime, "If-None-Match": "*", ...extra });
const v1list = (BASE, a) => v1call(BASE, a, "GET", "/saves/list");

phases.push(["E", async () => withServer(BASE_PORT + 10, { ACCOUNT_CAP: "100000", PROT_CAP: "30000" }, async (srv, api) => {
  console.log("--- phase E: v1 clients ---");
  const BASE = srv.BASE;
  const V = await account(BASE);
  const aSav = rnd(500), sState = rnd(40000);
  const keys = { "n64/smash/battery/a.sav": [aSav, "1000"], "n64/smash/states/s.state": [sState, "2000"], "n64/smash/meta.json": [Buffer.from("{}"), "1500"], "_account/prefs.json": [Buffer.from("{\"a\":1}"), "10"], "loose.sav": [rnd(50), "7"] };
  let etagA;
  for (const [k, [b, mt]] of Object.entries(keys)) { const r = await v1put(BASE, V, k, b, mt); check(r.status === 200, `v1 PUT ${k}`); if (k.endsWith("a.sav")) etagA = r.data.etag; }
  let l = await v1list(BASE, V);
  check(l.status === 200 && l.data.files.length === 5 && l.data.quota === 200 * 1024 * 1024, "v1 list on an unconverted account is unchanged (200 MB quota)");
  // first v2 call converts
  const m = await manifestOf(api, V);
  const sm = m.games["n64/smash"];
  check(sm && sm.files["battery/a.sav"].cur === 1 && sm.files["battery/a.sav"].vers[0].class === "battery" && sm.files["states/s.state"].vers[0].class === "state" && sm.files["meta.json"].vers[0].class === "settings", "v1 objects converted to ver 1 with classes");
  check(sm.files["battery/a.sav"].vers[0].mtime === 1000 && sm.files["battery/a.sav"].vers[0].enc === "none" && sm.playedAt === 2000, "mtime / enc / played_at carried over");
  check(m.games["_account/_"].files["_account/prefs.json"] && m.games["_misc/_"].files["loose.sav"], "_account/ and short keys get synthetic games");
  check(m.account.used === 500 + 40000 + 2 + 7 + 50, "converted usage = sum of v1 object sizes");
  const gv = await api.blobGet(V, "n64/smash", "battery/a.sav");
  check(gv.status === 200 && gv.data.equals(aSav) && gv.headers.get("x-rh-sha") === sha(aSav), "a v1 object downloads through v2");
  // v2 push on a converted account; v1 list stays clean (no blobs)
  const dv = devId();
  const pr = await api.push(V, "n64/smash", [{ path: "battery/b.sav", data: rnd(300), mtime: 3000 }], { dev: dv });
  check(pr.commit.data.results[0].cloud === "synced", "v2 push works on a converted account");
  l = await v1list(BASE, V);
  check(l.data.files.length === 5 && l.data.files.every((f) => !f.key.startsWith("o/")), "v1 list never shows v2 blobs");
  check((await v1call(BASE, V, "GET", K("o/" + sha("x")))).status === 400, "v1 cannot address the blob area (o/...)");
  // v1 write-through
  const upd = await v1put(BASE, V, "n64/smash/battery/a.sav", rnd(600), "4000", { "If-None-Match": undefined, "If-Match": etagA });
  check(upd.status === 200, "v1 update of a converted object");
  const m2 = await manifestOf(api, V);
  const av = m2.games["n64/smash"].files["battery/a.sav"];
  check(av.cur === 2 && av.vers.length === 1 && av.vers[0].size === 600 && av.vers[0].mtime === 4000, "v1 write-through: new version, no history for v1 writes");
  check((await api.blobGet(V, "n64/smash", "battery/a.sav")).data.length === 600, "v2 downloads the v1-written bytes");
  const dl = await v1call(BASE, V, "DELETE", K("loose.sav"));
  check(dl.status === 200 && dl.data.deleted === true, "v1 delete");
  check(!(await manifestOf(api, V)).games["_misc/_"].files["loose.sav"], "v1 delete removes the file from the v2 manifest");
  // v1 writes respect the v2 account cap once converted
  const cap = await v1put(BASE, V, "n64/smash/states/huge.state", rnd(70000));
  check(cap.status === 507 && cap.data.error === "quota-exceeded", "v1 PUT over the v2 account cap -> 507 quota-exceeded");
  check((await v1put(BASE, V, "n64/smash/states/ok.state", rnd(10000))).status === 200, "v1 PUT within the cap still works");
  await blobsConsistent(api, V.uid, "converted account");
  await totalMatchesIndex(api, "converted account");
  check((await v1call(BASE, V, "GET", K("n64/smash/battery/a.sav"))).data.length === 600, "v1 GET still returns the object");

  // conversion against the new caps: oversized v1 accounts lose their least recently played large items
  const W = await account(BASE);
  for (const [i, mt] of [[1, "10"], [2, "20"], [3, "30"]]) await v1put(BASE, W, `n64/g${i}/states/s.state`, rnd(40000), mt);
  await v1put(BASE, W, "n64/g1/battery/b.sav", rnd(500), "5");
  const wm = await manifestOf(api, W);
  check(wm.games["n64/g1"].files["states/s.state"].cloud === "evicted" && wm.games["n64/g2"].files["states/s.state"].cloud === "synced" && wm.games["n64/g3"].files["states/s.state"].cloud === "synced", "conversion: 120500 > 100000 -> least recently played game's state evicted");
  check(wm.games["n64/g1"].files["battery/b.sav"].cloud === "synced" && wm.account.used <= 100000, "conversion keeps protected data and ends under the cap");
  const wl = await v1list(BASE, W);
  check(!wl.data.files.some((f) => f.key === "n64/g1/states/s.state") && wl.data.files.length === 3, "the evicted v1 object is gone from the v1 list too");
  await blobsConsistent(api, W.uid, "oversized conversion");
  await totalMatchesIndex(api, "oversized conversion");
}, {})]);

// G: GET /saves/v2/devices obeys the saves share of the daily request budget (it is not a free "status" probe)
phases.push(["G", async () => withServer(BASE_PORT + 11, { DAILY_REQ_CAP: "10", SAVES_RATE_META: "1000" }, async (srv, api) => {
  console.log("--- phase G: devices obeys the daily guard ---");
  const A = await account(srv.BASE), d = devId();
  let last = 0;
  for (let i = 0; i < 4; i++) last = (await api.call(A, "GET", "/saves/v2/devices", { dev: d })).status;
  check(last === 429, "devices: over the saves cap of the daily budget -> 429 (not exempt like status)");
})]);

for (const [name, fn] of phases) if (!want.length || want.includes(name)) await fn();
console.log(st.fails ? `${st.fails} FAILED` : "ALL PASSED");
process.exit(st.fails ? 1 : 0);
