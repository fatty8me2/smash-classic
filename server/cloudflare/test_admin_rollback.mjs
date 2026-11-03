// Rollback: a deployment WITHOUT the ADMIN_REG binding (the previous code, or this code with the feature removed) must let everyone in,
// whatever verdicts the registry stored earlier (bans, waiting accounts). Starts its own LOCAL wrangler dev twice on the same storage
// (ROLLBACK_PORT, default 10111). Usage: node test_admin_rollback.mjs
import { createHash, createHmac } from "node:crypto";
import { startServer } from "./test_v2_lib.mjs";
import { ADMIN, ADMIN_SECRET, rnd, sleep, checker, connect, mk, again, ask } from "./admin_test_lib.mjs";

const PORT = Number(process.env.ROLLBACK_PORT) || 10111;
const { st, check } = checker();
const sha = (s) => createHash("sha256").update(s).digest("hex");
let srv = await startServer({ port: PORT, vars: { ADMIN_UID: ADMIN, REG_TOUCH_MS: "0", REG_PENDING_RECHECK_MS: "0", REG_BAN_RECHECK_MS: "0" } });
let base = srv.BASE.replace("http", "ws");
let http = srv.BASE;
try {
  const adm = await connect(base, ADMIN, ADMIN_SECRET, "Owner");
  const X = await mk(base, "Banned" + rnd(4));
  const old = await mk(base, "Regular" + rnd(4));
  const ban = await ask(adm, { type: "admin_ban", uid: X.uid }, "admin_result");
  check(ban && ban.ok, "setup (with the registry): X is banned");
  check((await again(X)).outcome === "error", "setup: X is refused while the registry is bound");
  await ask(adm, { type: "admin_settings", set: { approval: true } }, "admin_settings");
  const Y = await mk(base, "Waiting" + rnd(4));
  check(Y.outcome === "error" && Y.error.reason === "pending-approval", "setup: a new account waits while approval mode is on");
  const link = async (u) => (await fetch(http + "/link/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ uid: u.uid, secret: u.secret }) })).status;
  check((await link(X)) === 403 && (await link(Y)) === 403, "setup: banned and waiting accounts cannot create link codes");
  for (const u of [adm, X, Y, old]) try { u.ws.close(); } catch { /* */ }
  srv.stop();
  await sleep(3000);

  // the same storage, the binding gone
  srv = await startServer({ port: PORT, noreg: true, keep: true, vars: { ADMIN_UID: ADMIN } });
  base = srv.BASE.replace("http", "ws"); http = srv.BASE;
  const X2 = await again(X), Y2 = await again(Y), O2 = await again(old);
  check(X2.outcome === "welcome", "ROLLBACK (no ADMIN_REG): the formerly banned account is welcomed");
  check(Y2.outcome === "welcome", "ROLLBACK: the formerly waiting account is welcomed");
  check(O2.outcome === "welcome", "ROLLBACK: an ordinary account is welcomed");
  check((await link(X)) === 200 && (await link(Y)) === 200, "ROLLBACK: links work for everyone again");
  const sign = (acct, path) => { const ts = Date.now(); const msg = `GET\n${path}\n${ts}\n-\n-\n-\n-\n-`; return `RHSIG uid=${acct.uid},ts=${ts},sig=${createHmac("sha256", sha(acct.secret)).update(msg).digest("hex")}`; };
  const sv = async (u) => (await fetch(http + "/saves/v2/status", { headers: { Authorization: sign(u, "/saves/v2/status") } })).status;
  check((await sv(X)) === 200 && (await sv(Y)) === 200, "ROLLBACK: cloud saves authorise everyone again");
  const adm2 = await connect(base, ADMIN, ADMIN_SECRET, "Owner");
  check(adm2.outcome === "welcome", "ROLLBACK: the owner still connects");
  adm2.send({ type: "admin_list" }); await sleep(600);
  check(adm2.msgs.every((m) => m.type !== "admin_list"), "ROLLBACK: admin messages return nothing useful without the registry");
  for (const u of [adm2, X2, Y2, O2]) try { u.ws.close(); } catch { /* */ }
} finally {
  srv.stop();
}
console.log(st.fails ? `${st.fails} FAILED` : "ALL PASSED");
process.exit(st.fails ? 1 : 0);
