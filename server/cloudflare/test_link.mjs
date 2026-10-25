// Link-a-new-PC tests. Run against a local worker:
//   npx wrangler dev        (plain; picks up the tracked .dev.vars: LINK_TTL_SECONDS=3, LINK_REDEEM_LIMIT=5)
//   node test_link.mjs [http://127.0.0.1:8787]   (8787 is the wrangler dev default port)
// Uses Node's global WebSocket to create the account (hello), then the /link/* routes.

const BASE = process.argv[2] || "http://127.0.0.1:8787";
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

// Local dev only: Cloudflare's edge rejects requests with a spoofed CF-Connecting-IP (error 1000), and
// the live Worker has no short TTL / low redeem limit, so those two checks are skipped when remote.
const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost)/.test(BASE);
const ip = () => rnd(12, "0123456789abcdef");   // fresh per-test client IP for redeem limits
async function post(path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(LOCAL ? { "cf-connecting-ip": ip() } : {}), ...(LOCAL ? headers : {}) },
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
if (LOCAL) {
const exp = await post("/link/create", { uid: acct.uid, secret: acct.secret });
await post("/link/put", { uid: acct.uid, secret: acct.secret, code: exp.data.code, ...bundle() });
await new Promise((r) => setTimeout(r, 4000));
const er = await post("/link/redeem", { code: exp.data.code });
check("expired code refused", er.status === 404 && er.data?.error === "invalid", `status=${er.status}`);
}

// ---- rate limits ----------------------------------------------------------
const rlAcct = await newAccount();
let rl = 0;
for (let i = 0; i < 6; i++) {
  const r = await post("/link/create", { uid: rlAcct.uid, secret: rlAcct.secret });
  if (r.status === 429) rl++;
}
check("create rate-limited per account (6th refused)", rl === 1, `429s=${rl}`);

if (LOCAL) {
const ipHdr = ip();
let redeemRl = 0;
for (let i = 0; i < 7; i++) {
  const r = await post("/link/redeem", { code: "ABCDEFGH" }, { "cf-connecting-ip": ipHdr });
  if (r.status === 429) redeemRl++;
}
check("redeem rate-limited per IP", redeemRl >= 1, `429s=${redeemRl}`);
}

// ---- persistent account code (/link/keep) ----------------------------------
{
  const { createHash, randomBytes } = await import("node:crypto");
  const hex = (s) => createHash("sha256").update(s).digest("hex");
  const mk = () => rnd(12, "ABCDEFGHJKMNPQRSTUVWXYZ23456789");
  const fmt = (c) => `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8)}`;
  const K = await newAccount();
  const K2 = await newAccount();
  const auth = (a) => ({ uid: a.uid, secret: a.secret });
  const c1 = mk();
  const b1 = { ...bundle(), ct: randomBytes(60).toString("base64") };
  check("keep rejects wrong secret", (await post("/link/keep", { uid: K.uid, secret: "x".repeat(20), box: hex(c1), ...b1 })).status === 403);
  check("keep rejects bad box hash", (await post("/link/keep", { ...auth(K), box: "nope", ...b1 })).status === 400);
  check("keep rejects bad ciphertext", (await post("/link/keep", { ...auth(K), box: hex(c1), ...b1, ct: "!!" })).status === 400);
  const k1 = await post("/link/keep", { ...auth(K), box: hex(c1), ...b1 });
  check("keep stores the persistent code", k1.status === 200 && k1.data?.ok === true, `status=${k1.status}`);
  const rd1 = await post("/link/redeem", { code: fmt(c1).toLowerCase() });
  check("redeem 12-char code returns bundle + username", rd1.status === 200 && rd1.data?.ct === b1.ct && rd1.data?.salt === b1.salt && rd1.data?.iv === b1.iv && "username" in rd1.data, JSON.stringify(rd1.data).slice(0, 80));
  check("redeem response has no uid", !JSON.stringify(rd1.data).includes(K.uid));
  const rd2 = await post("/link/redeem", { code: c1 });
  check("persistent code can be redeemed again", rd2.status === 200 && rd2.data?.ct === b1.ct);
  check("another account cannot claim the same code", (await post("/link/keep", { ...auth(K2), box: hex(c1), ...b1 })).status === 409);
  const c2 = mk();
  const b2 = { ...bundle(), ct: "QUJDRA==" };
  check("keep replaces the previous code", (await post("/link/keep", { ...auth(K), box: hex(c2), ...b2 })).status === 200);
  check("old persistent code is revoked", (await post("/link/redeem", { code: c1 })).status === 404);
  check("new persistent code works", (await post("/link/redeem", { code: c2 })).data?.ct === "QUJDRA==");
  check("wrong 12-char code -> 404 invalid", (await post("/link/redeem", { code: mk() })).data?.error === "invalid");
  const tmp = await post("/link/create", auth(K));
  check("creating a temporary code leaves the persistent one alone", tmp.status === 200 && (await post("/link/redeem", { code: c2 })).status === 200);
  if (LOCAL) {
    await new Promise((r) => setTimeout(r, 3500));   // LINK_TTL_SECONDS=3
    check("persistent code does not expire", (await post("/link/redeem", { code: c2 })).status === 200);
  }
  check("remove revokes the persistent code", (await post("/link/keep", { ...auth(K), remove: true })).status === 200 && (await post("/link/redeem", { code: c2 })).status === 404);
  check("remove without secret is refused", (await post("/link/keep", { uid: K.uid, secret: "y".repeat(20), remove: true })).status === 403);
  // per-IP redeem limit applies to persistent codes too
  if (LOCAL) {
    const ipH = ip();
    let n429 = 0;
    for (let i = 0; i < 7; i++) if ((await post("/link/redeem", { code: mk() }, { "cf-connecting-ip": ipH })).status === 429) n429++;
    check("redeem of 12-char codes is rate limited per IP", n429 >= 1, `429s=${n429}`);
  }
}

console.log(failures ? `${failures} FAILED` : "ALL PASSED");
process.exit(failures ? 1 : 0);
