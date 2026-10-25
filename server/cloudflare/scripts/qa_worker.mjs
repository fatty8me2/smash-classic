// QA harness: starts the REAL local Worker (isolated wrangler dev, never production), creates N friends accounts and
// stays alive until a stop-file appears or the parent PID is gone.
//   node scripts/qa_worker.mjs --port 10400 --out C:\rhq\qa.json [--stop-file F] [--parent-pid PID] [--accounts 1]
//        [--account-cap BYTES] [--prot-cap BYTES] [--log FILE]
// Writes {base, pid, accounts:[{uid,secret}]} to --out once the server is up (pid = this node process; wrangler is its child tree).
import { writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer, account, sleep } from "../test_v2_lib.mjs";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : d; };
const port = Number(opt("port", "10400"));
if (port < 10400 || port > 10449) { console.error("port must be 10400-10449"); process.exit(2); }
const out = opt("out"), stopFile = opt("stop-file"), parent = Number(opt("parent-pid", "0")), logFile = opt("log");
const n = Number(opt("accounts", "1"));
if (!out) { console.error("--out required"); process.exit(2); }

process.chdir(join(dirname(fileURLToPath(import.meta.url)), ".."));   // test_v2_lib reads wrangler.jsonc from the cwd
const vars = {};
if (opt("account-cap")) vars.ACCOUNT_CAP = opt("account-cap");
if (opt("prot-cap")) vars.PROT_CAP = opt("prot-cap");
const srv = await startServer({ port, vars });
const accounts = [];
for (let i = 0; i < n; i++) { const a = await account(srv.BASE); accounts.push({ uid: a.uid, secret: a.secret }); }
writeFileSync(out, JSON.stringify({ base: srv.BASE, pid: process.pid, accounts }));

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const flush = () => { if (logFile) try { writeFileSync(logFile, srv.log()); } catch { /* */ } };
while (!(stopFile && existsSync(stopFile)) && !(parent && !alive(parent))) { flush(); await sleep(1000); }
flush();
srv.stop();
await sleep(1500);
process.exit(0);
