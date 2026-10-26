// Runs the whole server test suite SEQUENTIALLY, every test on its own fresh local `wrangler dev` (isolated registry,
// short --persist-to under C:\rhq\<port>, ports 10100+). Never touches production. Usage:
//   node run_all_tests.mjs            all tests
//   node run_all_tests.mjs saves      only tests whose file name contains "saves"
import { spawn } from "node:child_process";
import { startServer } from "./test_v2_lib.mjs";

const ADMIN = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
// kind: "ws"/"http" = needs a server (URL passed as argument); "self" = starts its own servers; "pure" = no server
const SUITE = [
  { file: "test_reqbudget.mjs", kind: "pure" },
  { file: "test_saves_pool.mjs", kind: "pure" },
  { file: "test_saves.mjs", kind: "self", env: { SAVES_TEST_PORT: "10031" } },
  { file: "test_saves.mjs", args: ["--nor2"], kind: "self", env: { SAVES_TEST_PORT: "10031" } },
  { file: "test_r2budget.mjs", kind: "self", env: { BUDGET_TEST_PORT: "10041" } },
  { file: "test_stats.mjs", kind: "self", env: { STATS_TEST_PORT: "10051" } },
  { file: "test_saves_v2.mjs", kind: "self", env: { SAVES_V2_PORT: "10021" } },
  { file: "test_admin_autolink.mjs", kind: "ws", vars: { ADMIN_UID: ADMIN } },
  { file: "test_autofriend.mjs", kind: "ws", vars: { TEST_FRIEND_CAP: "2" } },
  { file: "test_dupes2.mjs", kind: "ws", vars: { TEST_ALIAS: "1", ADMIN_UID: ADMIN } },
  { file: "test_fix3.mjs", kind: "ws", vars: { TEST_ALIAS: "1", TEST_ALIAS_FAIL_ONCE: "1", TEST_FRIEND_CAP: "2" } },
  { file: "test_friends_dedupe.mjs", kind: "ws", vars: { ADMIN_UID: ADMIN } },
  { file: "test_friends_fixes.mjs", kind: "http" },
  { file: "test_hostmig.mjs", kind: "ws" },
  { file: "test_hub_reasons.mjs", kind: "ws" },
  { file: "test_invite.mjs", kind: "http" },
  { file: "test_limits.mjs", kind: "ws" },
  { file: "test_link.mjs", kind: "http", vars: { LINK_TTL_SECONDS: "3", LINK_REDEEM_LIMIT: "5" } },
  { file: "test_link_bruteforce.mjs", kind: "http", vars: { LINK_REDEEM_LIMIT: "5", LINK_GLOBAL_LIMIT: "12" } },
  { file: "test_usernames.mjs", kind: "http" },
  { file: "test_presence.mjs", kind: "http" },
  { file: "test_playtime.mjs", kind: "ws", vars: { TEST_PT_STALE_MS: "0" } },
  { file: "test_relay.mjs", kind: "ws" },
  { file: "test_retire.mjs", kind: "ws", vars: { TEST_RETIRE_FAIL_AFTER: "1", ADMIN_UID: ADMIN } },
  { file: "test_ask.mjs", kind: "self", env: { ASK_TEST_PORT: "10061" } },
  { file: "test_room4.mjs", kind: "ws" },
  { file: "test_roster_sync.mjs", kind: "ws" },
];

const filter = process.argv[2] || "";
const PB = Number(process.env.SUITE_PORT_BASE) || 0;   // set to move every port (e.g. 10300); default keeps the historic ports
let port = PB ? PB + 42 : 10100;
const results = [];
function run(file, args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [file, ...args], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
    let out = "";
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => { out += "\nTIMEOUT"; try { p.kill(); } catch { /* own child */ } }, 600000);
    p.on("exit", (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}
for (const t of SUITE) {
  if (filter && !t.file.includes(filter)) continue;
  const label = t.file + (t.args ? " " + t.args.join(" ") : "");
  let srv = null;
  const args = [...(t.args || [])];
  try {
    if (t.kind === "ws" || t.kind === "http") {
      const p = PB ? PB + 42 + (port++ - PB - 42) % 8 : port++;
      srv = await startServer({ port: p, vars: t.vars || {} });
      args.push(t.kind === "ws" ? `ws://127.0.0.1:${p}` : `http://127.0.0.1:${p}`);
    }
    const shifted = {}; for (const [k, v] of Object.entries(t.env || {})) shifted[k] = PB ? String(PB + ((Number(v) % 100) % 50)) : v;
    const env = { ...shifted, WRANGLER_REGISTRY_PATH: "C:\\rhq\\regsuite", TEMP: "C:\\rhq\\t", TMP: "C:\\rhq\\t" };
    const r = await run(t.file, args, env);
    const failed = (r.code !== 0 && !/ALL PASSED/.test(r.out)) || /\bFAIL\b|\bFAILED\b|TIMEOUT|ERROR:/.test(r.out.replace(/ALL PASSED/g, ""));
    results.push({ label, ok: !failed });
    console.log(`${failed ? "FAIL" : "PASS"}  ${label}`);
    if (failed) console.log(r.out.split("\n").filter((l) => !l.startsWith("ok")).slice(-25).join("\n"));
  } catch (e) {
    results.push({ label, ok: false });
    console.log(`FAIL  ${label}: ${e.message}`);
  } finally {
    if (srv) srv.stop();
    await new Promise((r) => setTimeout(r, 800));
  }
}
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} test files passed` + (bad.length ? `; failed: ${bad.map((b) => b.label).join(", ")}` : ""));
process.exit(bad.length ? 1 : 0);
