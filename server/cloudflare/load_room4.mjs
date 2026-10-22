// Load test: N players blast small relay frames at each other at 60 Hz, like a match.
// Usage: node load_room4.mjs [players=3] [seconds=8] [ws://127.0.0.1:8799]
const PLAYERS = Number(process.argv[2] || 3);
const SECONDS = Number(process.argv[3] || 8);
const BASE = process.argv[4] || "ws://127.0.0.1:8799";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
let room = ""; for (let i = 0; i < 6; i++) room += a[Math.floor(Math.random() * a.length)];

const peers = [];
for (let i = 0; i < PLAYERS; i++) {
  const ws = new WebSocket(`${BASE}/ws?room=${room}&role=${i === 0 ? "host" : "join"}&v=2`);
  ws.binaryType = "arraybuffer";
  const p = { ws, rx: new Array(PLAYERS).fill(0), open: false };
  ws.onopen = () => { p.open = true; };
  ws.onmessage = (e) => { if (typeof e.data !== "string") p.rx[new Uint8Array(e.data)[0]]++; else if (JSON.parse(e.data).type === "relaying") p.relaying = true; };
  peers.push(p);
  await sleep(200);
}
peers[0].ws.send(JSON.stringify({ type: "relay" }));
await sleep(300);
const payload = new Uint8Array(17);
const t0 = Date.now();
let frames = 0;
while (Date.now() - t0 < SECONDS * 1000) {
  for (let i = 0; i < PLAYERS; i++) for (let j = 0; j < PLAYERS; j++) if (i !== j) {
    payload[0] = 1 << j; peers[i].ws.send(payload);
  }
  frames++;
  await sleep(16);
}
await sleep(1000);
console.log("frames sent per pair:", frames);
for (let i = 0; i < PLAYERS; i++) console.log(`player ${i} received from:`, peers[i].rx.join(","));
process.exit(0);
