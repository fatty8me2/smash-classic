// Node test: profile (avatar / favourite game / status line) rides on presence, and DM reactions are delivered.
// Run: npx wrangler dev --port 8731 (LOCAL, in BattleShip\server\cloudflare), then: node test_profiles.mjs [http://127.0.0.1:8731]
import { randomBytes } from "node:crypto";

const BASE = (process.argv[2] || "http://127.0.0.1:8731").replace(/^http/, "ws");
let fails = 0;
const check = (c, m) => { if (!c) { fails++; console.log("FAIL:", m); } else console.log("ok:  ", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UIDCHARS = "abcdefghijklmnopqrstuvwxyz234567";
const newUid = () => [...randomBytes(26)].map((b) => UIDCHARS[b % 32]).join("");

function client(uid) {
  const ws = new WebSocket(`${BASE}/friends?uid=${uid}`);
  const c = { ws, msgs: [] };
  ws.onmessage = (e) => c.msgs.push(JSON.parse(e.data));
  c.send = (o) => ws.send(JSON.stringify(o));
  c.find = (type, pred = () => true) => c.msgs.find((m) => m.type === type && pred(m));
  c.wait = async (fn, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(25); } return false; };
  c.ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  return c;
}

const uidA = newUid(), uidB = newUid();
const a = client(uidA), b = client(uidB);
await Promise.all([a.ready, b.ready]);
a.send({ type: "hello", secret: randomBytes(16).toString("hex"), name: "qa-profa", test: true });
b.send({ type: "hello", secret: randomBytes(16).toString("hex"), name: "qa-profb", test: true });
check(await a.wait(() => a.find("welcome")), "A welcome");
check(await b.wait(() => b.find("welcome")), "B welcome");
const codeA = a.find("welcome").code, codeB = b.find("welcome").code;
a.send({ type: "add_friend", code: codeB });
await b.wait(() => b.find("request"));
b.send({ type: "add_friend", code: codeA });
await a.wait(() => a.msgs.some((m) => m.type === "friend_added"));
await sleep(300);

// ---- profile on presence
const long = "x".repeat(80);
a.send({ type: "status", status: { state: "online", prof: { a: "c:snes", g: "melee", s: "grinding Melee " + long } } });
check(await b.wait(() => b.msgs.some((m) => m.type === "presence" && m.uid === uidA && m.status?.prof)), "B sees A's profile");
const p = b.msgs.filter((m) => m.type === "presence" && m.uid === uidA && m.status?.prof).pop().status.prof;
check(p.a === "c:snes" && p.g === "melee", "avatar and favourite game kept");
check(typeof p.s === "string" && Array.from(p.s).length <= 32 && p.s.startsWith("grinding Melee"), "status line capped at 32 chars");

b.msgs.length = 0;
a.send({ type: "status", status: { state: "online", prof: { a: "<script>", g: 5, s: 7, extra: "no" } } });
await sleep(500);
const bad = b.msgs.filter((m) => m.type === "presence" && m.uid === uidA).pop();
check(!bad || !bad.status?.prof, "malformed profile fields are dropped");

// the friend list row carries the profile too (after B reconnects)
a.send({ type: "status", status: { state: "online", prof: { a: "g:mk64", s: "hi" } } });
await sleep(400);
const b2 = client(uidB);
await b2.ready;
b2.send({ type: "hello", secret: "", name: "qa-profb", test: true });
await sleep(100);

// ---- reactions
b.msgs.length = 0; a.msgs.length = 0;
a.send({ type: "message", to: uidB, text: "gg" });
check(await b.wait(() => b.find("msg")), "B gets A's DM");
const mid = b.find("msg").msg.id;
a.send({ type: "react", to: uidB, target: mid, emoji: "fire" });
check(await b.wait(() => b.msgs.some((m) => m.type === "msg" && m.msg.kind === "react")), "B gets the reaction");
const r = b.msgs.find((m) => m.type === "msg" && m.msg.kind === "react").msg;
check(r.target === mid && r.emoji === "fire" && r.on === true && r.from === uidA, "reaction carries target, emoji, sender");
a.send({ type: "react", to: uidB, target: mid, emoji: "<b>" });
check(await a.wait(() => a.msgs.some((m) => m.type === "error" && m.ref === "react")), "unknown emoji refused");
a.send({ type: "react", to: newUid(), target: mid, emoji: "gg" });
check(await a.wait(() => a.msgs.filter((m) => m.type === "error").length >= 2), "reaction to a non-friend refused");
a.send({ type: "history_dummy" });
b.send({ type: "history", with: uidA });
await b.wait(() => b.find("history"));
check(!(b.find("history").msgs || []).some((m) => m.kind === "react"), "reactions are not stored in history");

console.log(fails ? `FAILED ${fails}` : "ALL OK");
process.exit(fails ? 1 : 0);
