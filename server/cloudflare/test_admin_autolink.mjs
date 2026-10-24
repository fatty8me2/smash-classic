// Admin auto-link must skip test/QA identities. Usage:
//   npx wrangler dev --ip 127.0.0.1 --port 8773 --var ADMIN_UID:aaaaaaaaaaaaaaaaaaaaaaaaaa   (another shell)
//   node test_admin_autolink.mjs [ws://127.0.0.1:8773]
const base = process.argv[2] || "ws://127.0.0.1:8773";
const ADMIN = "a".repeat(26);
let fails = 0;
const check = (c, m) => { if (!c) { fails++; console.log("FAIL:", m); } else console.log("ok:  ", m); };
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const rnd = (n) => Array.from({ length: n }, () => B32[Math.floor(Math.random() * 32)]).join("");

function hello(uid, secret, name, extra = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${base}/friends?uid=${uid}`);
    ws.onopen = () => ws.send(JSON.stringify({ type: "hello", secret, name, ...extra }));
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.type === "welcome") resolve({ ws, w: m }); };
    ws.onclose = () => resolve({ ws, w: null });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const adminSecret = "admin-fixed-secret-for-local-tests";

const a = await hello(ADMIN, adminSecret, "Owner");
check(a.w, "admin connects");
const cases = [
  ["Real" + rnd(4), {}, true],
  ["qa-x" + rnd(3), {}, false],
  ["At3", {}, false],
  ["linktest", {}, false],
  ["scratch-test", {}, false],
  ["testing1", {}, false],
  ["Normal" + rnd(3), { test: true }, false],
  ["Atlas", {}, true],
];
for (const [name, extra, linked] of cases) {
  const u = await hello(rnd(26), rnd(40), name, extra);
  const has = !!(u.w && u.w.friends.some((f) => f.uid === ADMIN));
  check(has === linked, `${name} ${JSON.stringify(extra)} admin-linked=${linked}`);
  u.ws.close();
}
await sleep(200);
const a2 = await hello(ADMIN, adminSecret, "Owner");
const names = a2.w.friends.map((f) => f.name);
check(names.some((n) => n.startsWith("Real")) && names.includes("Atlas"), "admin list has real users");
check(!names.some((n) => /^(qa-|At\d+$|linktest|scratch-test|test)/i.test(n)) && !names.some((n) => n.startsWith("Normal")), "admin list has no test users");
a.ws.close(); a2.ws.close();
console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exit(fails ? 1 : 0);
