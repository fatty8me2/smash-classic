// Print a readable summary of the Worker's /admin/stats endpoint.
// Usage: ADMIN_TOKEN=... node scripts/stats.mjs https://<worker-url>
//        (the token is read from the environment only; it is never a command-line argument)
const base = process.argv[2];
const token = process.env.ADMIN_TOKEN;
if (!base || !token) {
  console.error("usage: ADMIN_TOKEN=<token> node scripts/stats.mjs <worker-url>");
  process.exit(2);
}
const url = new URL("/admin/stats", base).toString();
const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
if (!r.ok) {
  console.error(`HTTP ${r.status} from ${url}`);
  process.exit(1);
}
const s = await r.json();
const gb = (b) => (b / 1024 ** 3).toFixed(2) + " GB";
const pct = (u, c) => (c ? ((100 * u) / c).toFixed(1) : "0.0") + "%";
const line = (label, used, cap) => `  ${label.padEnd(16)} ${String(used).padStart(12)} / ${String(cap).padStart(12)}  ${pct(used, cap)}`;

console.log(`Stats at ${s.generated}`);
console.log(`R2 (month ${s.r2.month})`);
console.log(`  storage          ${gb(s.r2.storedBytes)} / ${gb(s.r2.storageCapBytes)}  ${pct(s.r2.storedBytes, s.r2.storageCapBytes)}`);
console.log(line("Class A ops", s.r2.classA.used, s.r2.classA.cap));
console.log(line("Class B ops", s.r2.classB.used, s.r2.classB.cap));
console.log(`Durable Objects (day ${s.durableObjects.day})`);
console.log(line("rows written", s.durableObjects.rowsWritten, s.durableObjects.rowsCap));
console.log(line("rows read", s.durableObjects.rowsRead, s.durableObjects.rowsReadCap));
console.log(line("wall ms (est)", s.durableObjects.wallMs, s.durableObjects.wallMsCap));
const paused = Object.entries(s.paused).filter(([, v]) => v).map(([k]) => k);
console.log(`Paused: ${paused.length ? paused.join(", ") : "none"}`);
console.log(`Today (${s.counters.day})`);
console.log(`  rooms created    ${s.counters.today.rooms}`);
console.log(`  relay minutes    ${s.counters.today.relayMinutes}`);
console.log(`  desync reports   ${s.counters.today.desync}`);
console.log("Client versions, last 7 days (connections):");
const vers = Object.entries(s.counters.clientVersionsWeek).sort((a, b) => b[1] - a[1]);
if (!vers.length) console.log("  (none)");
for (const [v, n] of vers) console.log(`  ${v.padEnd(16)} ${n}`);
