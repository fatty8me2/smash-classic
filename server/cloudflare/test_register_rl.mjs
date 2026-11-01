// Open registration limits (SV-F4): new accounts per address per day and per service per day, refused with a reason code the
// client can show; test accounts have their own counters; loopback (a local wrangler) and existing accounts are never limited.
//   Pure checks on src/limits.js, then a live run. The live part needs a server started with
//     --var REG_PER_IP:2 --var REG_GLOBAL:7 --var REG_TEST_PER_IP:3 --var REG_TEST_GLOBAL:4 --var TEST_BUDGET:1
//   (run_all_tests.mjs does this): node test_register_rl.mjs [ws://127.0.0.1:8773]
// Client addresses are injected with a CF-Connecting-IP handshake header (wrangler dev passes it through; Cloudflare itself
// always overwrites it, so a real client cannot choose its address).
import { regLimits, regDecision, secondsToUtcMidnight, ipKey, VersionKeys, REG_PER_IP_PER_DAY, REG_GLOBAL_PER_DAY } from "./src/limits.js";
import { DEFAULT_DAILY_ROWS_CAP } from "./src/reqbudget_core.js";

const BASE = process.argv.find((a) => /^wss?:\/\//.test(a)) || "ws://127.0.0.1:8773";
const HTTP = BASE.replace(/^ws/, "http");
let fails = 0;
const check = (c, m) => { if (!c) { fails++; console.log("FAIL:", m); } else console.log("ok:  ", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const rnd = (n) => Array.from({ length: n }, () => B32[Math.floor(Math.random() * 32)]).join("");

// ---------------------------------------------------------------------------------------------------------------- pure
{
  const d = regLimits({});
  check(d.ip.real === REG_PER_IP_PER_DAY && d.global.real === REG_GLOBAL_PER_DAY, "defaults apply without overrides");
  check(REG_PER_IP_PER_DAY >= 3 && REG_PER_IP_PER_DAY <= 10 && REG_GLOBAL_PER_DAY >= 50 && REG_GLOBAL_PER_DAY <= 300, `a few per address (${REG_PER_IP_PER_DAY}) and a bounded service-wide day (${REG_GLOBAL_PER_DAY})`);
  const o = regLimits({ REG_PER_IP: "2", REG_GLOBAL: "0", REG_TEST_PER_IP: "x", REG_TEST_GLOBAL: "" });
  check(o.ip.real === 2 && o.global.real === 0 && o.ip.test === d.ip.test && o.global.test === d.global.test, "overrides: numbers (0 allowed) are taken, junk and empty fall back");
  const lim = { ip: { real: 2, test: 5 }, global: { real: 10, test: 20 } };
  check(regDecision({ ip: 0, global: 0 }, lim, false) === null && regDecision({ ip: 1, global: 9 }, lim, false) === null, "under both limits: accepted");
  check(regDecision({ ip: 2, global: 3 }, lim, false) === "ip", "address used up: ip");
  check(regDecision({ ip: 0, global: 10 }, lim, false) === "global", "service used up: global");
  check(regDecision({ ip: 2, global: 10 }, lim, false) === "global", "both used up: the service-wide reason wins");
  check(regDecision({ ip: 4, global: 19 }, lim, true) === null && regDecision({ ip: 5, global: 0 }, lim, true) === "ip", "test accounts use the test limits");
  const s = secondsToUtcMidnight(Date.parse("2026-11-01T23:59:30Z"));
  check(s === 30, `seconds to the daily reset (${s})`);
  const s2 = secondsToUtcMidnight(Date.parse("2026-11-01T00:00:00Z"));
  check(s2 === 86400, "a full day right after the reset");
  check(secondsToUtcMidnight() >= 1 && secondsToUtcMidnight() <= 86400, "always between 1 s and a day");
  check(ipKey("127.0.0.1") === "" && ipKey("127.5.5.5") === "" && ipKey("::1") === "" && ipKey("::ffff:127.0.0.1") === "" && ipKey("") === "" && ipKey(null) === "",
    "loopback and missing addresses have no key (never limited)");
  check(["10.1.2.3","192.168.1.20","172.16.5.5","169.254.1.1","fd00::1","fe80::1"].every((a) => ipKey(a) === "") && ipKey("172.32.0.1") === "172.32.0.1", "private and link-local addresses (a LAN test of a local wrangler) are never limited");
  check(ipKey("198.51.100.7") === "198.51.100.7", "an IPv4 address is its own key");
  check(ipKey("2001:db8:1:2:3:4:5:6") === ipKey("2001:db8:1:2:ffff::1") && ipKey("2001:db8:1:2::1") !== ipKey("2001:db8:1:3::1"), "IPv6 is keyed by its /64");
  check(ipKey("::ffff:198.51.100.7") === "198.51.100.7", "an IPv4-mapped IPv6 address is the IPv4 address");
  const vk = new VersionKeys(2);
  check(vk.key("1.29.24") === "1.29.24" && vk.key("-") === "-" && vk.key("junk!") === "" && vk.key("9.9.9-evil") === "" && vk.key(undefined) === "", "only plain x.y.z (or none) can become a counter");
  check(vk.key("1.2.3") === "1.2.3" && vk.key("4.5.6") === "other" && vk.key("1.29.24") === "1.29.24", "distinct versions beyond the cap are counted together");
  check(DEFAULT_DAILY_ROWS_CAP <= 70_000 && DEFAULT_DAILY_ROWS_CAP >= 50_000, "rows cap is 50-70% of the free plan's 100,000 rows a day");
}

// ----------------------------------------------------------------------------------------------------------------- live
async function register(label, { ip, test, name, uid = rnd(26), secret = rnd(40) } = {}) {
  const ws = new WebSocket(`${BASE}/friends?uid=${uid}`, ip ? { headers: { "CF-Connecting-IP": ip } } : undefined);
  const msgs = [];
  let closed = null;
  ws.onmessage = (e) => msgs.push(JSON.parse(e.data));
  ws.onclose = (e) => { closed = { code: e.code, reason: e.reason }; };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("connect failed: " + label)); });
  ws.send(JSON.stringify({ type: "hello", secret, name: name || "Reg" + rnd(4), ...(test ? { test: true } : {}) }));
  const t0 = Date.now();
  while (Date.now() - t0 < 8000 && !closed && !msgs.find((m) => m.type === "welcome" || m.reason === "registration-limited")) await sleep(25);
  return {
    ws, uid, secret, label,
    welcome: msgs.find((m) => m.type === "welcome"),
    refusal: msgs.find((m) => m.type === "error" && m.reason === "registration-limited"),
    get closed() { return closed; },
  };
}
const budget = async () => (await fetch(`${HTTP}/__test/budget`)).json();
const open = [];
const ok = async (label, o) => { const a = await register(label, o); open.push(a.ws); return a; };

// 1. Loopback (no injected address = 127.0.0.1 under wrangler dev) is never limited, and registrations cost REQ_BUDGET rows.
const b0 = await budget();
const loop = [];
for (let i = 0; i < 8; i++) loop.push(await ok("loopback " + i));
check(loop.every((a) => a.welcome), "8 accounts from loopback all register (local wrangler is never limited)");
const b1 = await budget();
const perAcct = (b1.rows - b0.rows) / 8;
check(perAcct >= 20, `a registration is charged to the REQ_BUDGET rows axis (${perAcct.toFixed(1)} rows each)`);
check(b1.rows > b0.rows && b1.rows < 2000, `rows counter is sane (${b0.rows} -> ${b1.rows})`);

// 2. One address (A): 2 accounts, then refused with the reason code, socket left open.
const A = "198.51.100.10", B = "198.51.100.11", D = "198.51.100.12";
const a1 = await ok("A1", { ip: A }), a2 = await ok("A2", { ip: A });
check(a1.welcome && a2.welcome, "address A: first two accounts are accepted");
const a3 = await ok("A3", { ip: A });
check(!a3.welcome && a3.refusal, "address A: the third account is refused");
check(a3.refusal && a3.refusal.detail === "ip", `refusal names the address limit (detail=${a3.refusal && a3.refusal.detail})`);
check(a3.refusal && a3.refusal.retry_after >= 1 && a3.refusal.retry_after <= 86400, `refusal carries retry_after seconds (${a3.refusal && a3.refusal.retry_after})`);
await sleep(700);
check(a3.closed === null && a3.ws.readyState === WebSocket.OPEN, "the refused socket is left open (an older client would reconnect-loop on a close)");

// 3. Existing accounts are never limited; a refused uid left nothing behind.
const a1b = await ok("A1 again", { ip: A, uid: a1.uid, secret: a1.secret });
check(!!a1b.welcome, "an existing account from the limited address still connects");
const a3b = await ok("A3 from loopback", { uid: a3.uid, secret: a3.secret });
check(!!a3b.welcome, "the refused uid registers fine later (the refusal wrote nothing)");

// 4. Other addresses have their own share; the service-wide limit counts them all.
const b1a = await ok("B1", { ip: B }), b2a = await ok("B2", { ip: B });
check(b1a.welcome && b2a.welcome, "address B: its own two accounts are accepted");
const c1 = await ok("C1", { ip: "2001:db8:1:2::1" }), c2 = await ok("C2", { ip: "2001:db8:1:2:aaaa::7" });
check(c1.welcome && c2.welcome, "IPv6: two accounts from one /64 are accepted");
const c3 = await ok("C3", { ip: "2001:db8:1:2:bbbb::9" });
check(!c3.welcome && c3.refusal && c3.refusal.detail === "ip", "IPv6: a third address in the same /64 shares the limit");

// 5. The service-wide limit (7): 6 used so far (A 2, B 2, C 2), one more fresh address fits, then `global` refuses the rest.
const e1 = await ok("E1", { ip: "198.51.100.13" });
check(!!e1.welcome, "the seventh account of the day (a fresh address) is accepted");
const d1 = await ok("D1", { ip: D });
check(!d1.welcome && d1.refusal && d1.refusal.detail === "global", `service-wide limit reached: refused with detail=global (${d1.refusal && d1.refusal.detail})`);
const b1b = await ok("B1 again", { ip: D, uid: b1a.uid, secret: b1a.secret });
check(!!b1b.welcome, "existing accounts still connect once the service-wide limit is reached");

// 6. Test accounts ("test":true, or a qa- name) have their own counters: address A still has room for them.
const t1 = await ok("T1", { ip: A, test: true }), t2 = await ok("T2", { ip: A, test: true }), t3 = await ok("T3", { ip: A, name: "qa-" + rnd(5) });
check(t1.welcome && t2.welcome && t3.welcome, "test accounts register although the address and the service are used up for real ones");
const t4 = await ok("T4", { ip: A, test: true });
check(!t4.welcome && t4.refusal && t4.refusal.detail === "ip", "...up to the test limit of the address");
const t5 = await ok("T5", { ip: B, test: true });
check(!!t5.welcome, "a test account from another address is accepted (service-wide test count: 4)");
const t6 = await ok("T6", { ip: D, test: true });
check(!t6.welcome && t6.refusal && t6.refusal.detail === "global", "the service-wide test limit refuses the next one");
const d2 = await ok("D2", { ip: D });
check(!d2.welcome && d2.refusal && d2.refusal.detail === "global", "real accounts are still refused (their counters are separate)");
const tLoop = await ok("test account on loopback", { test: true });
check(!!tLoop.welcome, "test accounts on a local wrangler (loopback) are never limited");

for (const ws of open) try { ws.close(); } catch { /* closed */ }
console.log(fails ? `${fails} FAILED` : "ALL PASSED");
process.exit(fails ? 1 : 0);
