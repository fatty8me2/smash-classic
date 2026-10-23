// Node test for server limits and presence selection.
// Run: npx wrangler dev --port 8771   (in another shell), then: node test_limits.mjs ws://127.0.0.1:8771
// Pure checks import src/limits.js directly; the last check talks to a running
// `wrangler dev`. Usage: node test_limits.mjs [ws://127.0.0.1:8771]
import { FixedWindow, ByteBucket, onlineTargets, RELAY_BYTES_PER_SEC, RELAY_BURST_BYTES } from "./src/limits.js";

const BASE = process.argv.find((a) => /^wss?:\/\//.test(a)) || "ws://127.0.0.1:8771";
let fails = 0;
const check = (c, m) => { if (!c) { fails++; console.log("FAIL:", m); } else console.log("ok:  ", m); };

// FixedWindow: limit per key per window, keys independent, window rolls over.
{
  let t = 0;
  const fw = new FixedWindow(3, 1000, () => t);
  check([1, 2, 3].every(() => fw.hit("a")), "fixed window allows up to the limit");
  check(fw.hit("a") === false, "fixed window refuses over the limit");
  check(fw.hit("b") === true, "fixed window keys are independent");
  t = 1000;
  check(fw.hit("a") === true, "fixed window resets after the window");
}

// ByteBucket: burst, refill, and oversize refusal.
{
  let t = 0;
  const bk = new ByteBucket(1000, 2000, () => t);
  check(bk.take(2000) === true, "bucket allows a full burst");
  check(bk.take(1) === false, "bucket is empty after the burst");
  t = 500;
  check(bk.take(500) === true, "bucket refills at the sustained rate");
  check(bk.take(1) === false, "bucket refuses past the refill");
  t = 10000;
  check(bk.take(2001) === false, "bucket never exceeds its burst size");
}

// Relay budget is generous: 4 players x 60 frames/s x 1024 bytes per socket fits easily.
{
  let t = 0;
  const bk = new ByteBucket(RELAY_BYTES_PER_SEC, RELAY_BURST_BYTES, () => t);
  let ok = true;
  for (let i = 0; i < 60 * 10; i++) { t += 1000 / 60; if (!bk.take(1024)) ok = false; }
  check(ok, "a 60 fps, 1 KiB-per-frame stream never hits the relay budget");
}

// Presence targets: only online friends, in order, capped.
{
  const friends = ["a", "b", "c", "d", "e"];
  const online = new Set(["b", "d", "e", "zz"]);
  check(JSON.stringify(onlineTargets(friends, online)) === '["b","d","e"]', "presence goes to online friends only, in order");
  check(JSON.stringify(onlineTargets(friends, online, 2)) === '["b","d"]', "presence respects the fan-out cap");
  check(onlineTargets(friends, new Set()).length === 0, "nobody online means no presence calls");
}

// Live: the per-account message budget refuses a burst on /friends.
{
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let uid = "";
  for (let i = 0; i < 26; i++) uid += alphabet[Math.floor(Math.random() * 32)];
  const ws = new WebSocket(`${BASE}/friends?uid=${uid}`);
  const replies = [];
  ws.onmessage = (e) => { try { replies.push(JSON.parse(e.data)); } catch { /* ignore */ } };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("connect failed")); });
  // Unauthenticated sockets are closed on their first non-hello frame, so authenticate first.
  ws.send(JSON.stringify({ type: "hello", secret: "limit-test-secret-0123456789", name: "limit" }));
  for (let t0 = Date.now(); Date.now() - t0 < 5000 && !replies.some((m) => m.type === "welcome"); ) {
    await new Promise((r) => setTimeout(r, 50));
  }
  check(replies.some((m) => m.type === "welcome"), "test account authenticates");
  for (let i = 0; i < 320; i++) ws.send(JSON.stringify({ type: "x" }));
  for (let t0 = Date.now(); Date.now() - t0 < 8000 && !replies.some((m) => m.reason === "rate-limited"); ) {
    await new Promise((r) => setTimeout(r, 100));
  }
  console.log("socket still open after burst:", ws.readyState === WebSocket.OPEN);
  const limited = replies.filter((m) => m.type === "error" && m.reason === "rate-limited").length;
  check(limited > 0, `friends API refuses a burst past the per-account budget (${limited} refused)`);
  ws.close();
}

console.log(fails ? `${fails} FAILED` : "all limit tests passed");
process.exit(fails ? 1 : 0);
