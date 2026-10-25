// Regenerates test_fixtures/v2/*.json: REAL replies of the v2 Worker (local wrangler dev) for the client's golden tests.
// Usage: node gen_fixtures.mjs   (port 10061 / 10062; isolated registry; never production)
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { startServer, account, client, devId, sha, sleep, sign } from "./test_v2_lib.mjs";

const OUT = "test_fixtures/v2";
mkdirSync(OUT, { recursive: true });
const det = (label, n) => Buffer.from(createHash("sha256").update(label).digest().subarray(0, 1).toString("hex").repeat(1) && Buffer.alloc(n, label.charCodeAt(0)));
const save = (name, r) => {
  const body = { status: r.status, ...(r.data && !Buffer.isBuffer(r.data) ? { body: r.data } : { bytes: r.data ? r.data.length : 0 }) };
  writeFileSync(`${OUT}/${name}.json`, JSON.stringify(body, null, 2) + "\n");
  console.log("wrote", name, r.status);
};

async function main1() {
  const srv = await startServer({ port: 10061, vars: { SAVES_RATE_PC: "1000", SAVES_RATE_META: "1000" } });
  try {
    const api = client(srv.BASE);
    const A = await account(srv.BASE);
    const d1 = "d-fixture01", d2 = "d-fixture02";
    const G = "n64/smash-64";
    save("err_unauthorized", await api.call(null, "GET", "/saves/v2/status"));
    save("err_stale_timestamp", await api.call(A, "GET", "/saves/v2/status", { ts: Date.now() - 3600e3 }));
    save("status", await api.status(A, d1));
    save("device", await api.device(A, d1, "PC-DESK"));
    await api.device(A, d2, "PC-LIVING");
    const files = [{ path: "battery/ssb64.sra", data: det("b", 32768), mtime: 1760000000 }, { path: "meta.json", data: Buffer.from('{"fixture":1}'), mtime: 1760000001 },
      { path: "states/auto.state", data: det("s", 20000), mtime: 1760000002, deflate: true }];
    const r = await api.push(A, G, files, { dev: d1, played: 1760000100 });
    save("plan_upload", r.plan);
    save("blob_put", r.ups[0]);
    save("commit", r.commit);
    save("manifest", await api.manifest(A, "", d1));
    save("manifest_delta", await api.manifest(A, `?since=${r.commit.data.rev}`, d1));
    const same = await api.plan(A, G, [{ path: "battery/ssb64.sra", sha: sha(files[0].data), size: 32768, stored: 32768, enc: "none", mtime: 1760000000, base: 1 },
      { path: "battery/copy.sra", sha: sha(files[0].data), size: 32768, stored: 32768, enc: "none", mtime: 1760000000, base: 0 },
      { path: "battery/other.sra", sha: sha("zz"), size: 5, stored: 5, enc: "none", mtime: 1, base: 7 }]);
    save("plan_same_have_conflict", same);
    save("blob_get_headers", { status: 0, data: null });
    const bg = await api.blobGet(A, G, "battery/ssb64.sra");
    writeFileSync(`${OUT}/blob_get_headers.json`, JSON.stringify({ status: bg.status, headers: Object.fromEntries([...bg.headers].filter(([k]) => k.startsWith("x-rh") || k === "content-length" || k === "content-type")) }, null, 2) + "\n");
    const rg = await api.blobGet(A, G, "battery/ssb64.sra", null, { Range: "bytes=32000-" });
    writeFileSync(`${OUT}/blob_get_range_headers.json`, JSON.stringify({ status: rg.status, headers: Object.fromEntries([...rg.headers].filter(([k]) => k.startsWith("x-rh") || k.startsWith("content-"))) }, null, 2) + "\n");
    const v2 = await api.push(A, G, [{ path: "battery/ssb64.sra", data: det("c", 32768), base: 1, mtime: 1760000200 }], { dev: d1 });
    save("restore", await api.restore(A, G, "battery/ssb64.sra", 1, 2));
    save("restore_conflict", await api.restore(A, G, "battery/ssb64.sra", 1, 2));
    const stale = await api.plan(A, G, [{ path: "battery/ssb64.sra", sha: sha("new"), size: 3, stored: 3, enc: "none", mtime: 1, base: 1 }]);
    save("plan_conflict", stale);
    save("lease_ok", await api.lease(A, G, "rw", d1));
    save("lease_held", await api.lease(A, G, "rw", d2));
    save("lease_readonly", await api.lease(A, G, "readonly", d2));
    save("lease_beat", await api.beat(A, G, d1));
    save("lease_take_over", await api.lease(A, G, "rw", d2, true));
    save("lease_release", await api.release(A, G, d2));
    save("game_pin", await api.gameOp(A, { game: G, pin: true }));
    save("err_bad_plan", await api.plan(A, G, [{ path: "../x", sha: sha("x"), size: 1, stored: 1, enc: "none", mtime: 1, base: 0 }]));
    save("err_ticket_expired", await api.commit(A, "0".repeat(40), d1));
    save("device_limit_hint", await api.device(A, "BAD", "x"));
    save("recovery_set", await api.call(A, "POST", "/saves/v2/recovery", { json: { hash: sha("rh-recover:FIXTURE"), salt: "c2FsdHNhbHRzYWx0", iv: "aXZpdml2aXZp", ct: "Zml4dHVyZS1jaXBoZXJ0ZXh0" } }));
    save("recover_ok", await api.call(null, "POST", "/saves/v2/recover", { raw: Buffer.from(JSON.stringify({ hash: sha("rh-recover:FIXTURE") })) }));
    save("recover_bad", await api.call(null, "POST", "/saves/v2/recover", { raw: Buffer.from(JSON.stringify({ hash: sha("rh-recover:NOPE") })) }));
  } finally { srv.stop(); await sleep(500); }
}

async function main2() {
  const srv = await startServer({ port: 10062, vars: { ACCOUNT_CAP: "100000", PROT_CAP: "30000", DAY_PUT_MAX: "9", SAVES_RATE_PC: "1000" } });
  try {
    const api = client(srv.BASE);
    const A = await account(srv.BASE);
    const d1 = "d-fixture01";
    for (let i = 1; i <= 3; i++) await api.push(A, `n64/g${i}`, [{ path: "states/a.state", data: Buffer.alloc(30000, 40 + i), mtime: i }], { dev: d1, played: 100 * i });
    const r = await api.push(A, "n64/g4", [{ path: "states/a.state", data: Buffer.alloc(30000, 50), mtime: 4 }], { dev: d1, played: 400 });
    save("commit_with_eviction", r.commit);
    save("manifest_with_tombstone", await api.manifest(A, "?game=" + encodeURIComponent("n64/g1"), d1));
    save("blob_get_evicted", await api.blobGet(A, "n64/g1", "states/a.state"));
    save("plan_skip_over_cap", await api.plan(A, "n64/g9", [{ path: "states/huge.state", sha: sha("h"), size: 120000, stored: 120000, enc: "none", mtime: 1, base: 0 }]));
    save("plan_skip_too_large", await api.plan(A, "n64/g9", [{ path: "states/huge2.state", sha: sha("h2"), size: 20000000, stored: 17000000, enc: "deflate", mtime: 1, base: 0 }]));
    save("err_too_big_protected", await api.plan(A, "n64/g8", [{ path: "battery/big.sra", sha: sha("p"), size: 40000, stored: 40000, enc: "none", mtime: 1, base: 0 }]));
    const many = Array.from({ length: 9 }, (_, i) => ({ path: `battery/m${i}.sra`, sha: sha("m" + i), size: 10, stored: 10, enc: "none", mtime: 1, base: 0 }));
    save("err_account_daily_limit", await api.plan(A, "n64/g7", many));
  } finally { srv.stop(); await sleep(500); }
}
await main1();
await main2();
process.exit(0);
