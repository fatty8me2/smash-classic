// Link-a-new-PC tests. Run against a local worker:
//   npx wrangler dev --port 8798 --var LINK_TTL_SECONDS:3 --var LINK_REDEEM_LIMIT:5
//   node test_link.mjs [http://127.0.0.1:8798]
// Uses Node's global WebSocket to create the account (hello), then the /link/* routes.

const BASE = process.argv[2] || "http://127.0.0.1:8798";
const WS = BASE.replace(/^http/, "ws");
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const rnd = (n, alpha) => Array.from({ length: n }, () => alpha[Math.floor(Math.random() * alpha.length)]).join("");

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? " " + extra : ""}`);
  if (!cond) failures++;
};

async function newAccount() {
  const uid = rnd(26, B32);
  const secret = rnd(52, B32);
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS}/friends?uid=${uid}`);
    ws.onopen = () => ws.send(JSON.stringify({ type: "hello", secret, name: "linktest" }));
    ws.onmessage = (ev) => {
      if (String(ev.data).includes('"welcome"')) { ws.close(); resolve(); }
    };
    ws.onerror = () => reject(new Error("ws error"));
    setTimeout(() => reject(new Error("welcome timeout")), 10000);
  });
  return { uid, secret };
}

const ip = () => rnd(12, "0123456789abcdef");   // fresh per-test client IP for redeem limits
async function post(path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip(), ...headers },
    body: JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, data };
}

const bundle = () => ({ salt: "c2FsdHNhbHRzYWx0c2FsdA==", iv: "aXZpdml2aXZpdml2", ct: "Y2lwaGVydGV4dGJsb2I=" });

// ---- create -----------------------------------------------------------
const acct = await newAccount();
const bad = await post("/link/create", { uid: acct.uid, secret: "x".repeat(20) });
check("create rejects wrong secret", bad.status === 403, `status=${bad.status}`);

const c1 = await post("/link/create", { uid: acct.uid, secret: acct.secret });
const code = c1.data?.code;
check("create returns 8-char code (XXXX-XXXX)", c1.status === 200 && /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/.test(code || ""), `code=${code}`);
check("create returns expiry", typeof c1.data?.expires_at === "number" && c1.data.expires_at > Date.now());

// ---- put + redeem ------------------------------------------------------
const plain = code && code.replace("-", "");
const put = await post("/link/put", { uid: acct.uid, secret: acct.secret, code, ...bundle() });
check("put stores bundle", put.status === 200 && put.data?.ok === true, `status=${put.status}`);

const pendingRedeemFirst = await post("/link/redeem", { code: "ZZZZZZZZ" });
check("redeem unknown code -> invalid", pendingRedeemFirst.status === 404 && pendingRedeemFirst.data?.error === "invalid");

const r1 = await post("/link/redeem", { code: plain.toLowerCase() });
check("redeem returns the stored ciphertext (normalized code)", r1.status === 200 && r1.data?.ct === bundle().ct && r1.data?.iv === bundle().iv && r1.data?.salt === bundle().salt);

const r2 = await post("/link/redeem", { code });
check("second redeem is refused (single use)", r2.status === 404 && r2.data?.error === "invalid", `status=${r2.status}`);

// ---- wrong code ----------------------------------------------------------
const wrong = await post("/link/create", { uid: acct.uid, secret: acct.secret });
const wrongCode = wrong.data.code.replace(/[A-Z2-9]/, (ch) => (ch === "A" ? "B" : "A"));
const wr = await post("/link/redeem", { code: wrongCode });
check("wrong code -> invalid", wr.status === 404 && wr.data?.error === "invalid");

// ---- put not yet done -> pending ----------------------------------------
const pend = await post("/link/redeem", { code: wrong.data.code });
check("redeem before put -> pending", pend.status === 409 && pend.data?.error === "pending", `status=${pend.status}`);

// ---- put by a different account is refused -------------------------------
const other = await newAccount();
const steal = await post("/link/put", { uid: other.uid, secret: other.secret, code: wrong.data.code, ...bundle() });
check("put from another account refused", steal.status !== 200);
const ok2 = await post("/link/put", { uid: acct.uid, secret: acct.secret, code: wrong.data.code, ...bundle() });
check("owner put succeeds", ok2.status === 200);
const again = await post("/link/put", { uid: acct.uid, secret: acct.secret, code: wrong.data.code, ...bundle() });
check("second put refused (already)", again.status === 409);

// ---- expiry (LINK_TTL_SECONDS=3 in dev) ----------------------------------
const exp = await post("/link/create", { uid: acct.uid, secret: acct.secret });
await post("/link/put", { uid: acct.uid, secret: acct.secret, code: exp.data.code, ...bundle() });
await new Promise((r) => setTimeout(r, 4000));
const er = await post("/link/redeem", { code: exp.data.code });
check("expired code refused", er.status === 404 && er.data?.error === "invalid", `status=${er.status}`);

// ---- rate limits ----------------------------------------------------------
const rlAcct = await newAccount();
let rl = 0;
for (let i = 0; i < 6; i++) {
  const r = await post("/link/create", { uid: rlAcct.uid, secret: rlAcct.secret });
  if (r.status === 429) rl++;
}
check("create rate-limited per account (6th refused)", rl === 1, `429s=${rl}`);

const ipHdr = ip();
let redeemRl = 0;
for (let i = 0; i < 7; i++) {
  const r = await post("/link/redeem", { code: "ABCDEFGH" }, { "cf-connecting-ip": ipHdr });
  if (r.status === 429) redeemRl++;
}
check("redeem rate-limited per IP", redeemRl >= 1, `429s=${redeemRl}`);

console.log(failures ? `${failures} FAILED` : "ALL PASSED");
process.exit(failures ? 1 : 0);
