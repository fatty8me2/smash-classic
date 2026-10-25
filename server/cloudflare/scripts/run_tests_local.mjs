// Runs every node test sequentially against its own LOCAL `wrangler dev` (isolated registry, fresh --persist-to,
// ports from 10200 up). Only kills processes it started (by PID tree). Usage: node scripts/run_tests_local.mjs [filter]
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const ADMIN = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const cfg = {
  "test_admin_autolink.mjs": [`ADMIN_UID:${ADMIN}`],
  "test_autofriend.mjs": ["TEST_FRIEND_CAP:2"],
  "test_dupes2.mjs": ["TEST_ALIAS:1", `ADMIN_UID:${ADMIN}`],
  "test_fix3.mjs": ["TEST_ALIAS:1", "TEST_ALIAS_FAIL_ONCE:1", "TEST_FRIEND_CAP:2"],
  "test_friends_dedupe.mjs": [`ADMIN_UID:${ADMIN}`],
  "test_retire.mjs": ["TEST_RETIRE_FAIL_AFTER:1", `ADMIN_UID:${ADMIN}`],
};
const selfStarting = new Set(["test_saves.mjs", "test_r2budget.mjs", "test_stats.mjs", "test_reqbudget.mjs"]);
const filter = process.argv[2] || "";
const files = fs.readdirSync(ROOT).filter((f) => /^test_.*\.mjs$/.test(f) && f.includes(filter)).sort();
let port = 10200, bad = 0;
const kill = (pid) => spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args, env) => new Promise((res) => {
  const c = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d));
  const t = setTimeout(() => { kill(c.pid); }, 280000);
  c.on("close", (code) => { clearTimeout(t); res({ code, out }); });
});

for (const f of files) {
  let srv = null, p = port++;
  const env = { WRANGLER_REGISTRY_PATH: `C:\\rhq\\reg${p}` };
  if (!selfStarting.has(f)) {
    const dir = `C:\\rhq\\${p}`; fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
    const vars = (cfg[f] || []).flatMap((v) => ["--var", v]);
    srv = spawn(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "dev", "--ip", "127.0.0.1", "--port", String(p), "--persist-to", dir, ...vars],
      { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let log = ""; srv.stdout.on("data", (d) => (log += d)); srv.stderr.on("data", (d) => (log += d));
    for (let i = 0; i < 120 && !/Ready on/.test(log); i++) await sleep(500);
  }
  const target = f === "test_usernames.mjs" || f === "test_link.mjs" || /fixes|invite|presence/.test(f) ? `http://127.0.0.1:${p}` : `ws://127.0.0.1:${p}`;
  const args = selfStarting.has(f) ? [f] : [f, target];
  const r = await run(process.execPath, args, env);
  if (srv) kill(srv.pid);
  const fails = (r.out.match(/^FAIL/gm) || []).length;
  console.log(`${r.code === 0 && !fails ? "OK  " : "BAD "} ${f} (exit ${r.code}, ${fails} FAIL lines)`);
  if (r.code !== 0 || fails) { bad++; console.log(r.out.split("\n").filter((l) => /FAIL|rror/.test(l)).slice(0, 12).join("\n")); }
  await sleep(1500);
}
console.log(bad ? `\n${bad} test files failed` : "\nall test files passed");
process.exit(bad ? 1 : 0);
