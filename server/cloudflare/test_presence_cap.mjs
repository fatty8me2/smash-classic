// Presence fan-out cap (SO-F1 / SV-F8): one presence event reaches at most PRESENCE_FANOUT_CAP friends (the Workers Free plan
// allows 50 subrequests per invocation), the skipped ones rotate, and a friend that missed an event is correct again on its
// next hello.
//   Pure checks on src/limits.js, then a live run. The live part needs a server started with
//     --var ADMIN_UID:aaaaaaaaaaaaaaaaaaaaaaaaaa --var PRESENCE_FANOUT_CAP:3
//   (run_all_tests.mjs does this): node test_presence_cap.mjs [ws://127.0.0.1:8773]
import { onlineTargets, FanoutRotation, PRESENCE_FANOUT_CAP } from "./src/limits.js";

const BASE = process.argv.find((a) => /^wss?:\/\//.test(a)) || "ws://127.0.0.1:8773";
const ADMIN = "a".repeat(26);
let fails = 0;
const check = (c, m) => { if (!c) { fails++; console.log("FAIL:", m); } else console.log("ok:  ", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const rnd = (n) => Array.from({ length: n }, () => B32[Math.floor(Math.random() * 32)]).join("");

// ---------------------------------------------------------------------------------------------------------------- pure
check(PRESENCE_FANOUT_CAP === 40, "the production cap is 40 (41 subrequests with the directory call, under the Free plan's 50)");
{
  const friends = ["a", "b", "c", "d", "e", "f"];
  const on = new Set(["b", "c", "e", "f", "zz"]);
  check(JSON.stringify(onlineTargets(friends, on)) === '["b","c","e","f"]', "only online friends, in list order, unknown ids ignored");
  check(onlineTargets(friends, on, Infinity).length === 4 && onlineTargets(friends, on, NaN).length === 4 && onlineTargets(friends, on, -1).length === 4 && onlineTargets(friends, on, 4).length === 4, "no usable cap, or a list that fits the cap = everyone");
  check(JSON.stringify(onlineTargets(friends, on, 2)) === '["b","c"]', "capped, nobody served yet: the start of the online list");
  check(JSON.stringify(onlineTargets(friends, on, 2, null, 2)) === '["e","f"]', "...rotated by the offset");
  check(onlineTargets(friends, on, 0).length === 0, "cap 0 selects nobody");
  const served = new Map([["b", 5], ["c", 5], ["e", 3]]);
  check(JSON.stringify(onlineTargets(friends, on, 2, served)) === '["f","e"]', "the least recently served come first (never served, then oldest)");
}
{
  // Fairness: 100 friends online, cap 40. Every capped event has exactly `cap` distinct targets, and a friend is never skipped
  // for more than ceil(n/cap) - 1 events in a row.
  const n = 100, cap = 40, list = Array.from({ length: n }, (_, i) => "f" + i);
  const online = new Set(list);
  const rot = new FanoutRotation(7);
  const last = new Map(), worst = new Map();
  let sizes = true, distinct = true;
  for (let ev = 1; ev <= 60; ev++) {
    const t = rot.pick(list, online, cap);
    if (t.length !== cap) sizes = false;
    if (new Set(t).size !== t.length) distinct = false;
    for (const f of list) {
      if (t.includes(f)) last.set(f, ev);
      else worst.set(f, Math.max(worst.get(f) || 0, ev - (last.get(f) || 0)));
    }
  }
  const gap = Math.max(...worst.values());
  check(sizes && distinct, "every capped event has exactly `cap` distinct targets");
  check(gap <= Math.ceil(n / cap) - 1, `no friend is skipped for more than ${Math.ceil(n / cap) - 1} events in a row (worst ${gap})`);
  check(list.every((f) => last.has(f)), "every friend was served");
  const small = new FanoutRotation(0);
  small.pick(list.slice(0, 30), new Set(list.slice(0, 30)), cap);
  check(small.served.size === 0, "an event that is not capped records nothing");
  const gone = new FanoutRotation(0);
  const big = Array.from({ length: 300 }, (_, i) => "h" + i);
  for (let i = 0; i < 70; i++) gone.pick(big, new Set(big), 5);
  const before = gone.served.size;
  const few = big.slice(0, 3);
  gone.pick(few, new Set(few), 2);
  check(before > 100 && gone.served.size <= few.length, `friends that left the list are forgotten (${before} remembered, then ${gone.served.size})`);
}
for (const flip of [0.03, 0.5]) {
  // Churn: of 130 other friends a share flips online/offline between events; 20 friends stay online throughout.
  let seed = 12345;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const all = Array.from({ length: 150 }, (_, i) => "g" + i);
  const stay = all.slice(0, 20);
  const online = new Set([...stay, ...all.slice(20).filter(() => rand() < 0.5)]);
  const rot = new FanoutRotation(0);
  const lastServed = new Map(), worst = new Map();
  for (let ev = 1; ev <= 400; ev++) {
    for (const f of all.slice(20)) if (rand() < flip) { if (online.has(f)) online.delete(f); else online.add(f); }
    const t = rot.pick(all, online, 40);
    for (const f of stay) {
      if (t.includes(f)) lastServed.set(f, ev);
      else worst.set(f, Math.max(worst.get(f) || 0, ev - (lastServed.get(f) || 0)));
    }
  }
  const gap = Math.max(...worst.values());
  check(gap <= 3, `with ${Math.round(flip * 100)}% of the friends joining or leaving between events, a friend that stays online is skipped at most ${gap} events in a row`);
}

// ----------------------------------------------------------------------------------------------------------------- live
function client(uid, secret, name) {
  const c = { uid, secret, name, msgs: [], closed: false };
  c.ws = new WebSocket(`${BASE}/friends?uid=${uid}`);
  c.ws.onmessage = (e) => c.msgs.push(JSON.parse(e.data));
  c.ws.onclose = () => { c.closed = true; };
  c.opened = new Promise((res, rej) => { c.ws.onopen = res; c.ws.onerror = () => rej(new Error("connect failed")); });
  c.send = (o) => c.ws.send(JSON.stringify(o));
  c.wait = async (fn, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const r = fn(); if (r) return r; await sleep(25); } return null; };
  c.hello = async () => { await c.opened; c.send({ type: "hello", secret, name }); return c.wait(() => c.msgs.find((m) => m.type === "welcome")); };
  return c;
}
const presenceOf = (c, game) => c.msgs.some((m) => m.type === "presence" && m.uid === ADMIN && m.status && m.status.game_id === game);

const CAP = 3, N = 8, EVENTS = 7;
const admin = client(ADMIN, "admin-fixed-secret-for-local-tests", "Owner");
check(!!(await admin.hello()), "admin connects");
const friends = [];
for (let i = 0; i < N; i++) {
  const f = client(rnd(26), rnd(40), "Pal" + i);
  const w = await f.hello();
  check(!!w && w.friends.some((x) => x.uid === ADMIN), `friend ${i} is welcomed and auto-linked to the admin`);
  friends.push(f);
}
check(!!(await admin.wait(() => admin.msgs.filter((m) => m.type === "friend_added").length >= N, 8000)), `the admin has ${N} online friends`);

// The admin changes its status EVENTS times; each event is told apart by its game id.
const got = [];   // got[k] = Set of friend indexes that received event k
for (let k = 1; k <= EVENTS; k++) {
  admin.send({ type: "status", status: { state: "in_game", game_id: "ev" + k, game_title: "Event " + k, system: "n64" } });
  await admin.wait(() => friends.filter((f) => presenceOf(f, "ev" + k)).length >= CAP, 4000);
  await sleep(300);   // stragglers, if the cap were not applied, would arrive now
  got[k] = new Set(friends.map((f, i) => (presenceOf(f, "ev" + k) ? i : -1)).filter((i) => i >= 0));
}
check(got.slice(1).every((s) => s.size === CAP), `every event reached exactly ${CAP} of the ${N} online friends (${got.slice(1).map((s) => s.size).join(",")})`);
const worst = friends.map((_, i) => { let run = 0, best = 0; for (let k = 1; k <= EVENTS; k++) { if (got[k].has(i)) run = 0; else best = Math.max(best, ++run); } return best; });
check(Math.max(...worst) <= Math.ceil(N / CAP) - 1, `nobody is skipped more than ${Math.ceil(N / CAP) - 1} events in a row (worst ${Math.max(...worst)})`);
check(friends.every((_, i) => got.slice(1).some((s) => s.has(i))), "every friend received at least one of the events");

// A friend that missed the latest event is right again on its next hello.
const lastEvent = got[EVENTS];
const missed = friends.findIndex((_, i) => !lastEvent.has(i));
check(missed >= 0 && !presenceOf(friends[missed], "ev" + EVENTS), `friend ${missed} missed the last event`);
const old = friends[missed];
old.ws.close();
await old.wait(() => old.closed, 3000);
await sleep(300);
const again = client(old.uid, old.secret, old.name);
const w2 = await again.hello();
const adminRow = w2 && w2.friends.find((x) => x.uid === ADMIN);
check(!!adminRow && adminRow.status.state === "in_game" && adminRow.status.game_id === "ev" + EVENTS,
  `its next hello shows the admin's current status (${adminRow ? adminRow.status.state + "/" + adminRow.status.game_id : "no row"})`);

// The admin's own hello lists every friend even though presence pushes are capped.
admin.ws.close();
await admin.wait(() => admin.closed, 3000);
await sleep(300);
const admin2 = client(ADMIN, "admin-fixed-secret-for-local-tests", "Owner");
const aw = await admin2.hello();
check(!!aw && aw.friends.length === N, `the admin's welcome lists all ${N} friends (${aw ? aw.friends.length : 0})`);

for (const c of [admin2, again, ...friends]) try { c.ws.close(); } catch { /* closed */ }
console.log(fails ? `${fails} FAILED` : "ALL PASSED");
process.exit(fails ? 1 : 0);
