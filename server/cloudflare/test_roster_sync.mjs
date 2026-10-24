// Node test: RetroHub's room (/hub HubRoom) and Smash's own lobby (/ws NetplayRoom) with the same code stay in step.
// A Smash player passes &hs=<its RetroHub slot>; leaving the RetroHub room drops it from the Smash lobby and the host
// follows RetroHub's host.
// Run: npx wrangler dev --ip 127.0.0.1 --port 9080 --persist-to <fresh dir>, then: node test_roster_sync.mjs ws://127.0.0.1:9080
const BASE = process.argv.find((a) => /^wss?:\/\//.test(a)) || "ws://127.0.0.1:9080";
let fails = 0;
const check = (c, m) => { if (!c) { fails++; console.log("FAIL:", m); } else console.log("ok:  ", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(url) {
  const ws = new WebSocket(url);
  const c = { ws, text: [], closed: null };
  ws.onmessage = (e) => { if (typeof e.data === "string") c.text.push(JSON.parse(e.data)); };
  ws.onclose = (e) => { c.closed = { code: e.code, reason: e.reason }; };
  c.last = (type) => [...c.text].reverse().find((m) => m.type === type);
  c.wait = async (fn, ms = 4000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(20); }
    return false;
  };
  return c;
}
const code = () => {
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = ""; for (let i = 0; i < 6; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
};
const hubOpen = (id, role, name) => client(`${BASE}/hub?room=${id}&role=${role}&name=${name}&caps=hostmig,reasons`);
const smashOpen = (id, role, hs) => client(`${BASE}/ws?room=${id}&role=${role}&v=2&hm=1${hs === undefined ? "" : `&hs=${hs}`}`);

// n hub members; `inSmash` = hub slots that are also in the Smash lobby (host first)
async function setup(n, inSmash) {
  const id = code();
  const hub = [hubOpen(id, "host", "p0")];
  await hub[0].wait(() => hub[0].last("welcome"));
  for (let i = 1; i < n; i++) { hub.push(hubOpen(id, "join", "p" + i)); await hub[i].wait(() => hub[i].last("welcome")); }
  const smash = {};
  for (const hs of inSmash) {
    smash[hs] = smashOpen(id, hs === inSmash[0] && hs === 0 ? "host" : "join", hs);
    await smash[hs].wait(() => smash[hs].last("welcome"));
  }
  await sleep(300);   // the Smash room tells the hub room it is linked
  return { id, hub, smash };
}

// ---- 1. slots agree; a guest leaving the RetroHub room leaves the Smash lobby ----
{
  const { hub, smash } = await setup(3, [0, 1, 2]);
  check([0, 1, 2].every((s) => smash[s].last("welcome").slot === s), "Smash slot == RetroHub slot");
  hub[2].ws.close();
  check(await smash[2].wait(() => smash[2].last("error") || smash[2].closed), "guest left RetroHub -> its Smash socket is told to leave");
  check(await smash[0].wait(() => smash[0].last("peer_left")?.slot === 2), "host sees the guest leave Smash");
  check(await smash[1].wait(() => smash[1].last("peer_left")?.slot === 2), "other guest sees the guest leave Smash");
  check(smash[0].closed === null && smash[1].closed === null, "the others stay");
  hub[0].ws.close(); hub[1].ws.close();
}

// ---- 2. host migration agrees; the renumbered host keeps working through a second leave ----
{
  const { hub, smash } = await setup(3, [0, 1, 2]);
  hub[0].ws.close();
  check(await smash[0].wait(() => smash[0].last("error") || smash[0].closed), "host left RetroHub -> its Smash socket is told to leave");
  check(await hub[1].wait(() => hub[1].last("host_changed")?.name === "p1"), "RetroHub promoted p1");
  check(await smash[1].wait(() => smash[1].last("host")?.slot === 1), "Smash promoted the same player (p1)");
  check(await smash[2].wait(() => smash[2].last("host")?.slot === 1), "other Smash guest told the same host");
  // p1 is slot 0 in RetroHub now; leaving must drop *its* Smash socket (the remap)
  hub[1].ws.close();
  check(await smash[1].wait(() => smash[1].last("error") || smash[1].closed), "renumbered host leaves RetroHub -> its Smash socket is told to leave");
  check(await smash[2].wait(() => smash[2].last("host")?.slot === 2), "last player becomes Smash host");
  check(smash[2].closed === null, "last player stays");
  hub[2].ws.close();
}

// ---- 3. RetroHub's new host is not in Smash: the lowest Smash player leads ----
{
  const { hub, smash } = await setup(3, [0, 2]);
  hub[0].ws.close();
  check(await smash[0].wait(() => smash[0].last("error") || smash[0].closed), "old host dropped from Smash");
  check(await smash[2].wait(() => smash[2].last("host")?.slot === 2), "only Smash player takes over");
  hub[1].ws.close(); hub[2].ws.close();
}

// ---- 4. a Smash player quitting changes nothing in RetroHub's room ----
{
  const { hub, smash } = await setup(2, [0, 1]);
  smash[1].ws.close();
  await sleep(300);
  check(hub[0].closed === null && hub[1].closed === null, "RetroHub members stay when a Smash socket closes");
  check(hub[0].last("members")?.members.length === 2, "RetroHub still lists both");
  hub[0].ws.close(); hub[1].ws.close(); smash[0].ws.close();
}

// ---- 5. an old Smash (no hs) is untouched ----
{
  const id = code();
  const h = hubOpen(id, "host", "a"); await h.wait(() => h.last("welcome"));
  const s = smashOpen(id, "host"); await s.wait(() => s.last("welcome"));
  h.ws.close();
  await sleep(300);
  check(s.closed === null && !s.last("error"), "Smash without hs is not linked");
  s.ws.close();
}

console.log(fails ? `${fails} FAILED` : "all ok");
process.exit(fails ? 1 : 0);
