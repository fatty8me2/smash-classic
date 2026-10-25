// Brute-force protection for /link/redeem. Needs a local worker started with
//   LINK_REDEEM_LIMIT=5 LINK_GLOBAL_LIMIT=12   (run_all_tests.mjs passes these)
//   node test_link_bruteforce.mjs http://127.0.0.1:<port>
const BASE = process.argv[2] || "http://127.0.0.1:8787";
const ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const rnd = (n, a) => Array.from({ length: n }, () => a[Math.floor(Math.random() * a.length)]).join("");
const ip = () => rnd(12, "0123456789abcdef");
let failures = 0;
const check = (name, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? " " + extra : ""}`); if (!cond) failures++; };

async function redeem(code, ipH) {
  const res = await fetch(BASE + "/link/redeem", {
    method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ipH },
    body: JSON.stringify({ code }),
  });
  let data = null; try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, data, retry: res.headers.get("retry-after") };
}

// Real persistent code so we can prove a locked-out IP is refused even with the RIGHT code.
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const uid = rnd(26, B32), secret = rnd(52, B32);
await new Promise((resolve, reject) => {
  const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/friends?uid=${uid}`);
  ws.onopen = () => ws.send(JSON.stringify({ type: "hello", secret, name: "bftest", test: true }));
  ws.onmessage = (ev) => { if (String(ev.data).includes('"welcome"')) { ws.close(); resolve(); } };
  ws.onerror = () => reject(new Error("ws error"));
  setTimeout(() => reject(new Error("welcome timeout")), 10000);
});
const { createHash } = await import("node:crypto");
const good = rnd(12, ALPHA);
const keep = await fetch(BASE + "/link/keep", {
  method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip() },
  body: JSON.stringify({ uid, secret, box: createHash("sha256").update(good).digest("hex"), salt: "c2FsdHNhbHRzYWx0c2FsdA==", iv: "aXZpdml2aXZpdml2", ct: "Y2lwaGVydGV4dA==" }),
});
check("setup: persistent code stored", keep.status === 200);

// Per-IP: 5 attempts allowed, 6th locked out with retry-after.
const A = ip();
const rs = [];
for (let i = 0; i < 6; i++) rs.push(await redeem(rnd(12, ALPHA), A));
check("first 5 wrong guesses answered 404", rs.slice(0, 5).every((r) => r.status === 404), rs.map((r) => r.status).join(","));
check("6th attempt from same IP is 429 with retry-after", rs[5].status === 429 && Number(rs[5].retry) >= 1 && rs[5].data?.error === "rate-limited", JSON.stringify(rs[5]));
const locked = await redeem(good, A);
check("locked-out IP is refused even with the correct code", locked.status === 429);
const locked2 = await redeem(good, A);
check("lockout persists (still 429)", locked2.status === 429);

// Another IP with the right code still works (global budget not yet spent: 5 failures so far).
const B = ip();
const ok = await redeem(good, B);
check("other IP redeems the correct code", ok.status === 200 && ok.data?.ct === "Y2lwaGVydGV4dA==");
const okAgain = await redeem(good.toLowerCase().replace(/(.{4})/g, "$1-"), B);
check("normalized code still works (not consumed)", okAgain.status === 200);

// Global: failures across many IPs trip the global cap (12) for everyone.
let tripped = 0;
for (let i = 0; i < 12; i++) { const r = await redeem(rnd(12, ALPHA), ip()); if (r.status === 429) tripped++; }
check("global failed-redeem cap trips across IPs", tripped >= 1, `429s=${tripped}`);
const after = await redeem(good, ip());
check("while global cap is hit, even a correct code gets 429", after.status === 429 && after.data?.error === "rate-limited");

console.log(failures ? `${failures} FAILED` : "ALL PASSED");
process.exit(failures ? 1 : 0);
