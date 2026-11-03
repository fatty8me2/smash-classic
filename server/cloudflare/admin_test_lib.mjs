// Shared helpers for the admin / blacklist tests (test_admin_api.mjs, test_admin_caps.mjs). Local wrangler only.
export const B32 = "abcdefghijklmnopqrstuvwxyz234567";
export const rnd = (n) => Array.from({ length: n }, () => B32[Math.floor(Math.random() * 32)]).join("");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const ADMIN = "a".repeat(26);
export const ADMIN_SECRET = "admin-fixed-secret-for-local-tests";

export function checker() {
  const st = { fails: 0 };
  const check = (c, m) => { if (!c) { st.fails++; console.log("FAIL:", m); } else console.log("ok:  ", m); };
  return { st, check };
}

/* One friends socket. outcome: "welcome" | "error" (a refusal message, no welcome) | "closed" (u.closed = code) | "timeout". */
export async function connect(base, uid, secret, name, extra = {}, wait = 4000) {
  const u = { uid, secret, name, msgs: [], closed: null, welcome: null, error: null, base };
  u.ws = new WebSocket(`${base}/friends?uid=${uid}`);
  u.send = (o) => u.ws.send(JSON.stringify(o));
  u.outcome = await new Promise((res) => {
    const t = setTimeout(() => res("timeout"), wait);
    u.ws.onopen = () => u.ws.send(JSON.stringify({ type: "hello", secret, name, ...extra }));
    u.ws.onmessage = (e) => {
      const m = JSON.parse(e.data); u.msgs.push(m);
      if (m.type === "welcome") { u.welcome = m; clearTimeout(t); res("welcome"); }
      else if (m.type === "error" && !u.welcome && !u.error) { u.error = m; clearTimeout(t); res("error"); }
    };
    u.ws.onclose = (e) => { u.closed = e.code; clearTimeout(t); res(u.welcome ? "welcome" : u.error ? "error" : "closed"); };
  });
  if (u.ws.readyState === 1) u.ws.onclose = (e) => { u.closed = e.code; };
  return u;
}

export const mk = (base, name, extra = {}) => connect(base, rnd(26), rnd(40), name, extra);
export const again = (u, extra = {}) => connect(u.base, u.uid, u.secret, u.name, extra);
export const code = (uid) => { const p = uid.slice(0, 8).toUpperCase(); return `RH-${p.slice(0, 4)}-${p.slice(4)}`; };

/* Wait for a message matching fn that arrives after `from` (an index into u.msgs). */
export async function waitMsg(u, fn, ms = 3000, from = 0) {
  const end = Date.now() + ms;
  for (;;) {
    const m = u.msgs.slice(from).find(fn);
    if (m) return m;
    if (Date.now() > end) return null;
    await sleep(40);
  }
}
/* Send an admin message and return the reply of `type` (null if none arrives: what a non-admin must see). */
export async function ask(u, msg, type, ms = 3000) {
  const from = u.msgs.length;
  u.send(msg);
  return waitMsg(u, (m) => m.type === type, ms, from);
}
export const names = (list) => list.map((r) => r.name);

export async function friendsOf(u) {
  const c = await again(u);
  const out = c.welcome ? c.welcome.friends.map((f) => f.uid) : null;
  const inc = c.welcome ? c.welcome.requests.incoming.map((r) => r.uid) : null;
  const o2 = c.welcome ? c.welcome.requests.outgoing.map((r) => r.uid) : null;
  try { c.ws.close(); } catch { /* closed */ }
  return { friends: out, incoming: inc, outgoing: o2, outcome: c.outcome };
}

export async function untilTrue(fn, ms = 6000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > end) return false;
    await sleep(200);
  }
}
