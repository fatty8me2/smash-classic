// Per-PC credentials sign cloud-save requests, a locked-out PC loses cloud access, and deleting an account wipes its cloud saves. Usage:
//   npx wrangler dev --port 8785 --var BUDGET_TEST:1 --var ALLOW_TEST_FLAG:1 --var REG_APPROVAL_DEFAULT:0   (another shell)
//   node test_account_wipe.mjs [http://127.0.0.1:8785]
import { startServer, client, makeChecker, devId, sha, sleep, b32 } from "./test_v2_lib.mjs";

const { st, check } = makeChecker();
let srv = null;
let BASE = process.argv.find((a) => /^https?:\/\//.test(a));
if (!BASE) { srv = await startServer({ port: Number(process.env.ACCT_WIPE_PORT) || 10061, vars: {} }); BASE = srv.BASE; }
const api = client(BASE);
const codeOf = (uid) => { const p = uid.slice(0, 8).toUpperCase(); return `RH-${p.slice(0, 4)}-${p.slice(4)}`; };

class Pc {
  constructor(uid, secret, pc) { this.uid = uid; this.secret = secret; this.pc = pc; this.events = []; this.closeCode = null; }
  connect() {
    return new Promise((resolve) => {
      this.events = []; this.closeCode = null;
      const ws = this.ws = new WebSocket(`${BASE.replace("http", "ws")}/friends?uid=${this.uid}`);
      ws.onopen = () => ws.send(JSON.stringify({ type: "hello", secret: this.secret, name: "wipe", dev: 1, pc: this.pc }));
      ws.onmessage = (e) => { const m = JSON.parse(e.data); this.events.push(m); if (m.type === "welcome") resolve(m); };
      ws.onclose = (e) => { this.closeCode = e.code; resolve(null); };
    });
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  async wait(pred, ms = 5000) { const t = Date.now(); while (Date.now() - t < ms) { if (pred()) return true; await sleep(30); } return false; }
}
const acctOf = (uid, secret) => ({ uid, secret, key: sha(secret) });

try {
  const uid = b32(26), root = b32(52);
  const p1 = new Pc(uid, root, "pc-wipe-0001");
  const w1 = await p1.connect();
  const d1 = w1.device.secret; p1.secret = d1;
  const A1 = acctOf(uid, d1), AR = acctOf(uid, root);

  const dev1 = devId();
  check((await api.device(A1, dev1, "PC one")).status === 200, "cloud saves accept a request signed with a PC's own secret");
  check((await api.status(AR, dev1)).status === 200, "...and one signed with the shared (legacy) secret");
  check((await api.status(acctOf(uid, b32(52)), dev1)).status === 401, "a wrong secret is still refused");

  const data = Buffer.from("save-data-" + b32(40));
  const pushed = await api.push(A1, "gameA", [{ path: "a.sav", data, mtime: 1000 }], { dev: dev1 });
  check(pushed.commit && pushed.commit.status === 200, "a save uploads with the PC's own secret");

  // PC 2 enrols from the shared secret, then PC 1 locks it out
  const p2 = new Pc(uid, root, "pc-wipe-0002");
  const w2 = await p2.connect();
  const A2 = acctOf(uid, w2.device.secret);
  check((await api.status(A2, devId())).status === 200, "PC 2 signs with its own secret");
  await p1.connect();
  p1.send({ type: "devices" });
  await p1.wait(() => p1.events.some((e) => e.type === "devices"));
  const row2 = p1.events.find((e) => e.type === "devices").devices.find((d) => d.pc === "pc-wipe-0002");
  p1.send({ type: "revoke_device", id: row2.id });
  check(await p1.wait(() => p1.events.some((e) => e.type === "device_revoked" && e.ok)), "PC 2 locked out");
  check((await api.status(A2, devId())).status === 401, "the locked-out PC's cloud-save requests are refused (401)");
  check((await api.status(A1, dev1)).status === 200, "the other PC still syncs");
  check((await api.status(AR, dev1)).status === 401, "locking a PC out also kills the shared secret for cloud saves");

  // sign out all others: the shared secret stops signing
  p1.send({ type: "revoke_others" });
  check(await p1.wait(() => p1.events.some((e) => e.type === "others_revoked" && e.ok)), "revoke_others ok");
  check((await api.status(A1, dev1)).status === 200, "the PC that asked still syncs");

  // delete account: cloud saves are wiped
  let before = await api.hook("v2/acct", { uid });
  check(before.files.filter((f) => f.dead == null).length > 0, `account has stored objects before the delete (${before.files.length})`);
  p1.events = [];
  p1.send({ type: "delete_account", confirm: true, typed: codeOf(uid) });
  check(await p1.wait(() => p1.events.some((e) => e.type === "account_deleted")), "delete accepted");
  let gone = false;
  for (let i = 0; i < 40 && !gone; i++) {
    await sleep(500);
    const a = await api.hook("v2/acct", { uid });
    gone = a.files.length === 0 && a.vers.length === 0;
  }
  check(gone, "the account's objects and versions are gone from the index after the delete");
  check((await api.status(A1, dev1)).status === 401, "the deleted account can no longer use cloud saves");
  const other = acctOf(b32(26), b32(52));
  const oth = new Pc(other.uid, other.secret, "pc-other-0001");
  await oth.connect();
  const od = devId();
  const op = await api.push(acctOf(other.uid, other.secret), "gameB", [{ path: "b.sav", data: Buffer.from("other-" + b32(30)), mtime: 1000 }], { dev: od });
  check(!op.commit || op.commit.status === 200, "other accounts are unaffected (control)");
} catch (e) { st.fails++; console.log("ERROR:", e); }
finally { if (srv) srv.stop(); }
console.log(st.fails ? `${st.fails} FAILED` : "ALL PASSED");
process.exit(st.fails ? 1 : 0);
