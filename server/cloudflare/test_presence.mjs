// Node test: an in_game presence keeps its lobby_code on the wire (friends /friends websocket).
// Run: npx wrangler dev --port 8725   (in BattleShip\server\cloudflare, another shell), then:
//   node test_presence.mjs [http://127.0.0.1:8725]
// Two throwaway accounts are created; nothing real is touched.
import { randomBytes } from "node:crypto";

const BASE = (process.argv[2] || "http://127.0.0.1:8725").replace(/^http/, "ws");
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
  c.wait = async (fn, ms = 4000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(25); }
    return false;
  };
  c.ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  return c;
}

const uidA = newUid(), uidB = newUid();
const a = client(uidA);
const b = client(uidB);
await Promise.all([a.ready, b.ready]);
a.send({ type: "hello", secret: randomBytes(16).toString("hex"), name: "PresA" });
b.send({ type: "hello", secret: randomBytes(16).toString("hex"), name: "PresB" });
check(await a.wait(() => a.find("welcome")), "A receives welcome");
check(await b.wait(() => b.find("welcome")), "B receives welcome");
const codeA = a.find("welcome").code, codeB = b.find("welcome").code;

// A asks for B; B asks for A, which resolves to a mutual friendship.
a.send({ type: "add_friend", code: codeB });
await b.wait(() => b.find("request"));
b.send({ type: "add_friend", code: codeA });
check(await a.wait(() => a.find("friend_added") || a.find("friends") || a.msgs.some((m) => m.type !== "welcome" && m.type !== "presence" && /friend/.test(m.type))), "friendship formed");
await sleep(300);

// A is in a lobby-backed game: in_game with a lobby_code.
const lobby = "ABCDEF";
a.send({ type: "status", status: { state: "in_game", game_id: "mk64", game_title: "Mario Kart 64", system: "n64", lobby_code: lobby, joinable: true, players: 2, max_players: 4 } });
const got = await b.wait(() => b.msgs.some((m) => m.type === "presence" && m.uid === uidA && m.status?.state === "in_game" && m.status?.lobby_code));
check(got, "B sees A in_game (presence pushed)");
const pres = b.msgs.find((m) => m.type === "presence" && m.status?.state === "in_game" && m.status?.lobby_code === lobby);
check(pres?.status?.lobby_code === lobby, "in_game presence keeps lobby_code");
check(pres?.status?.joinable === true && pres?.status?.players === 2, "joinable and players kept in in_game");

// A malformed lobby_code is dropped; the in_game state itself is kept.
a.send({ type: "status", status: { state: "in_game", game_id: "mk64", system: "n64", lobby_code: "<bad>", joinable: true } });
await sleep(400);
const bad = b.msgs.filter((m) => m.type === "presence" && m.status?.state === "in_game").pop();
check(bad && bad.status.lobby_code === undefined, "malformed lobby_code is dropped, in_game kept");

a.ws.close(); b.ws.close();
console.log(fails ? `FAILED (${fails})` : "all ok");
process.exit(fails ? 1 : 0);
