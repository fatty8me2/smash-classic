// Game-room seats belong to the lobby's members (netcore-M3): a "-N" room started from lobby CODE only lets in an account that sits in
// that lobby with the same slot. LOCAL wrangler only. Needs --var REG_APPROVAL_DEFAULT:0 --var STRICT_IDENT_MS:1200
//   node test_hub_gameauth.mjs [ws://127.0.0.1:PORT]
import { mk, sleep, checker } from "./admin_test_lib.mjs";
import { gameSeatVerdict } from "./src/hub_auth.js";

const base = process.argv[2] || "ws://127.0.0.1:8799";
const { st, check } = checker();
const code = () => Array.from({ length: 6 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join("");

// One /hub seat. who = account that sends an ident right after the welcome (null = a v1.39 client without an account / with ident off).
function seat(room, role, { who = null, slot, caps = "reasons", dropin = false } = {}) {
  const q = `room=${room}&role=${role}&name=t${slot ?? 0}${caps ? `&caps=${caps}` : ""}${slot !== undefined ? `&slot=${slot}` : ""}${dropin ? "&dropin=1" : ""}`;
  const ws = new WebSocket(`${base}/hub?${q}`);
  const c = { ws, text: [], closed: null };
  ws.onmessage = (e) => {
    if (typeof e.data !== "string") return;
    const m = JSON.parse(e.data); c.text.push(m);
    if (m.type === "welcome" && who) ws.send(JSON.stringify({ type: "ident", uid: who.uid, secret: who.secret, nopair: true }));
  };
  ws.onclose = (e) => { c.closed = { code: e.code, reason: e.reason }; };
  c.welcomed = () => c.text.some((m) => m.type === "welcome");
  c.err = () => c.text.find((m) => m.type === "error")?.reason;
  c.until = async (fn, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(25); } return false; };
  return c;
}

// ---- pure rules ----
{
  const lobby = [{ slot: 0, uid: "A" }, { slot: 1, uid: "B" }, { slot: 2, uid: "" }, { slot: 4, uid: "S", spec: true }];
  check(gameSeatVerdict({ slot: 1, uid: "B" }, lobby) === null, "rule: a member at its own slot is allowed");
  check(gameSeatVerdict({ slot: 2, uid: "B" }, lobby) === "wrong-slot", "rule: a member at another slot -> wrong-slot");
  check(gameSeatVerdict({ slot: 1, uid: "X" }, lobby) === "slot-not-yours", "rule: a stranger on a proven member's slot -> slot-not-yours");
  check(gameSeatVerdict({ slot: 3, uid: "X" }, lobby) === "not-in-lobby", "rule: a stranger on a slot the lobby does not have -> not-in-lobby");
  check(gameSeatVerdict({ slot: 2, uid: "X" }, lobby) === null, "rule: a lobby seat that never proved an account stays allowed (older clients)");
  check(gameSeatVerdict({ slot: 1, uid: "S", spec: true }, lobby) === null && gameSeatVerdict({ slot: 3, uid: "B", dropin: true }, lobby) === null, "rule: spectators and drop-ins only need to be in the lobby");
  check(gameSeatVerdict({ slot: 1, uid: "X", spec: true }, [{ slot: 0, uid: "A" }, { slot: 1, uid: "B" }]) === "not-in-lobby", "rule: a stranger spectator -> not-in-lobby");
  check(gameSeatVerdict({ slot: 1, uid: "X" }, null) === null && gameSeatVerdict({ slot: 1, uid: "X" }, []) === null, "rule: no roster -> never locks anybody out");
}

const A = await mk(base, "ga_host"), B = await mk(base, "ga_b"), C = await mk(base, "ga_c"), D = await mk(base, "ga_d"), F = await mk(base, "ga_f");
check([A, B, C, D, F].every((u) => u.outcome === "welcome"), "setup: five accounts");
await sleep(100);

// the lobby: A host, B slot 1, D slot 2, an unproven (old client) seat on slot 3
const L = code();
const lh = seat(L, "host", { who: A });
await lh.until(() => lh.welcomed());
const lb = seat(L, "join", { who: B, slot: 1 });
const ld = seat(L, "join", { who: D, slot: 2 });
const lo = seat(L, "join", { slot: 3 });
await Promise.all([lb, ld, lo].map((s) => s.until(() => s.welcomed())));
await sleep(1200);   // the idents are checked against the account hubs
lh.ws.send(JSON.stringify({ type: "msg", body: { kind: "launch", game: "x" } }));   // the host starts a game: the lobby remembers who was in it
await sleep(400);

// a member joins fine
const G1 = L + "-1";
const gh = seat(G1, "host", { who: A });
await gh.until(() => gh.welcomed());
const gb = seat(G1, "join", { who: B, slot: 1 });
check(await gb.until(() => gb.welcomed()), "member: B joins game room at its own slot");
await sleep(1500);
check(!gb.closed && !gb.err(), "member: B keeps the seat after its proof is checked");
check(!gh.closed && !gh.err(), "member: the host keeps its seat");

// a non-member with the code is refused (a lobby that has only its host: no seat 1 there)
const L2 = code();
const l2h = seat(L2, "host", { who: A });
await l2h.until(() => l2h.welcomed());
await sleep(800);
const g2h = seat(L2 + "-1", "host", { who: A });
await g2h.until(() => g2h.welcomed());
const gc = seat(L2 + "-1", "join", { who: C, slot: 1 });
check(await gc.until(() => gc.closed) && gc.err() === "not-in-lobby" && gc.closed.code === 4015, "non-member: C with the code, lobby has no such slot -> not-in-lobby (4015)");
const gc2 = seat(G1, "join", { who: C, slot: 2 });
await gc2.until(() => gc2.welcomed());
check(await gc2.until(() => gc2.closed) && gc2.err() === "slot-not-yours", "non-member: C on D's slot -> slot-not-yours");

// a member taking someone else's slot is refused
const gd = seat(G1, "join", { who: D, slot: 1 });
const gdOut = await gd.until(() => gd.closed || gd.err());
check(gdOut, "member on a taken slot: D asks slot 1 (B holds it): refused by the existing slot rule");
const G2 = L + "-2";
const gh2 = seat(G2, "host", { who: A });
await gh2.until(() => gh2.welcomed());
const gb2 = seat(G2, "join", { who: B, slot: 2 });
check(await gb2.until(() => gb2.closed) && gb2.err() === "wrong-slot", "member: B taking D's slot 2 -> wrong-slot");
const gd2 = seat(G2, "join", { who: D, slot: 2 });
await gd2.until(() => gd2.welcomed());
await sleep(1500);
check(!gd2.closed, "member: D still gets its own slot 2 right after (the refused seat freed it)");

// a v1.39-style join keeps working: no account proof at all / an account on a lobby seat that never proved one
const G3 = L + "-3";
const gh3 = seat(G3, "host", { who: A, caps: "hostmig,reasons" });
await gh3.until(() => gh3.welcomed());
const old = seat(G3, "join", { slot: 1, caps: "hostmig,reasons" });
await old.until(() => old.welcomed());
const f3 = seat(G3, "join", { who: F, slot: 3, caps: "hostmig,reasons" });
await f3.until(() => f3.welcomed());
await sleep(2500);
check(!old.closed && !old.err(), "v1.39: a join without any proof keeps its seat");
check(!f3.closed && !f3.err(), "v1.39: a join on a lobby seat that never proved an account keeps its seat");

// the opt-in flag: a seat that says it will prove its account must do so
const G4 = L + "-4";
const gh4 = seat(G4, "host", { who: A, caps: "reasons,gameauth" });
await gh4.until(() => gh4.welcomed());
const noProof = seat(G4, "join", { slot: 1, caps: "reasons,gameauth" });
await noProof.until(() => noProof.welcomed());
await noProof.until(() => noProof.closed, 6000);
check(noProof.err() === "ident-required", "gameauth: a seat that never proves its account is closed ident-required");
check(!gh4.closed, "gameauth: the proven host stays");

// onlineflow-M6: the 3DS room password in a launch is for seated players only
{
  const L3 = code();
  const h = seat(L3, "host"), g = seat(L3, "join", { slot: 1 });
  await h.until(() => h.welcomed()); await g.until(() => g.welcomed());
  const w1 = seat(L3, "watch");
  await w1.until(() => w1.welcomed());
  h.ws.send(JSON.stringify({ type: "msg", body: { kind: "launch", game: "x", np_3ds: { password: "s3cret" } } }));
  const got = (c) => c.text.find((m) => m.type === "msg" && m.body?.kind === "launch");
  await g.until(() => got(g)); await w1.until(() => got(w1));
  check(got(g)?.body.np_3ds?.password === "s3cret", "3ds password: a seated member gets np_3ds intact");
  check(got(w1) && got(w1).body.np_3ds === undefined && !JSON.stringify(got(w1)).includes("s3cret"), "3ds password: a live watcher gets the launch without it");
  await sleep(300);
  const w2 = seat(L3, "watch");
  await w2.until(() => got(w2));
  check(got(w2) && got(w2).body.watch === true && !JSON.stringify(got(w2)).includes("s3cret"), "3ds password: a late watcher's replay has it stripped");
  [h, g, w1, w2].forEach((s) => { try { s.ws.close(); } catch { /* closed */ } });
}

// a lobby blip: B's LOBBY socket drops, then B rejoins the game room: still a member; a stranger still is not
lb.ws.close();
await sleep(500);
const G5 = L + "-5";
const gh5 = seat(G5, "host", { who: A });
await gh5.until(() => gh5.welcomed());
const gb5 = seat(G5, "join", { who: B, slot: 1, caps: "reasons,gameauth" });
await gb5.until(() => gb5.welcomed());
await sleep(1800);
check(!gb5.closed && !gb5.err(), "lobby blip: B (lobby socket gone) rejoins the game room and stays");
const gc5 = seat(G5, "join", { who: C, slot: 2 });
await gc5.until(() => gc5.welcomed());
check(await gc5.until(() => gc5.closed) && gc5.err() === "slot-not-yours", "lobby blip: a stranger still cannot take a member's slot");

[lh, lb, ld, lo, gh, gb, gh2, gd2, gh3, old, f3, gh4, gh5, gb5, l2h, g2h].forEach((s) => { try { s.ws.close(); } catch { /* closed */ } });
await sleep(200);
process.exit(st.fails ? 1 : 0);
