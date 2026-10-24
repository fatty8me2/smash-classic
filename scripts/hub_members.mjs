// Test helper for netplay_lobbytest.ps1 -HubLink: plays the RetroHub room (/hub) of a Smash lobby test.
// node hub_members.mjs <ws-server> <CODE> <players> "<slot>@<seconds>,..."
// Opens <players> hub members (host first) and closes the listed ones at the given times; stays up until killed.
const [server, code, n, leave] = process.argv.slice(2);
const socks = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const open = (role, name) => new Promise((res) => {
  const ws = new WebSocket(`${server}/hub?room=${code}&role=${role}&name=${name}&caps=hostmig,reasons`);
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.type === "welcome") res(ws); if (m.type === "host_changed") console.log("hub: host_changed", e.data); };
  ws.onclose = (e) => console.log("hub: socket closed", name, e.code);
});
const t0 = Date.now();
socks.push(await open("host", "hub0"));
for (let i = 1; i < Number(n); i++) socks.push(await open("join", "hub" + i));
console.log("hub: members up", socks.length);
const plan = String(leave || "").split(",").filter(Boolean).map((s) => s.split("@").map(Number));
for (const [slot, at] of plan.sort((a, b) => a[1] - b[1])) {
  await sleep(Math.max(0, at * 1000 - (Date.now() - t0)));
  console.log("hub: member", slot, "leaves at", Math.round((Date.now() - t0) / 1000), "s");
  socks[slot].close();
}
await sleep(3600 * 1000);
