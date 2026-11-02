// Pure test: stale-socket reaping decision (SO-F6, Worker side).
import { staleSockets, STALE_SOCKET_MS } from "./src/limits.js";
let fails = 0; const check = (c, m) => { if (!c) { fails++; console.log("FAIL:", m); } else console.log("ok:  ", m); };
const now = 1_000_000_000;
check(JSON.stringify(staleSockets([{ id: 0, last: now - 10_000 }], now)) === "[]", "fresh keepalive is alive");
check(JSON.stringify(staleSockets([{ id: 0, last: now - STALE_SOCKET_MS - 1 }, { id: 1, last: now - 5_000 }], now)) === "[0]", "silent socket reaped, live one kept");
check(JSON.stringify(staleSockets([{ id: 0, last: null }], now)) === "[]", "a socket that never answered a keepalive (old client) is never reaped");
check(JSON.stringify(staleSockets([{ id: 0, last: now - 5_000 }], now, 1_000)) === "[0]", "limit is configurable");
console.log(fails ? "FAILED" : "ALL OK"); process.exit(fails ? 1 : 0);
