// RetroHub lobby: GET /hub?room=CODE[-N]&role=host|join&name=NAME[&slot=K]
//
// One Durable Object (HubRoom) per room code, up to 4 members, slot 0 = host.
// See Hub/docs/ARCHITECTURE.md ("Lobby server: /hub endpoint").
//
// S->C JSON: welcome{room,slot}, members{members:[{slot,name}]},
//            msg{from,body}, peers{peers:[{slot,public,local}]},
//            error{reason} then close 4000 (room-in-use|no-such-room|room-full)
// C->S JSON: msg{body}, endpoint{public,local}, keepalive (auto-answered)
// Binary: byte0 = destination slot (0xFF = all others), rewritten to the
//         sender's slot on delivery. Max 1200 bytes.
// Relay budget (additive; older clients ignore the message): a frame that is NOT relayed is answered with
//         relay_denied{reason,detail} to its sender (at most once per RELAY_NOTICE_MS per socket), reason "server-busy" (daily
//         budget: >= 50% for a room's first relayed frame = a new relay session, >= 90% for any) or "rate-limited" (the room
//         exceeded RELAY_ROOM_MSGS_PER_SEC frames/s or the socket RELAY_BYTES_PER_SEC bytes/s). A socket over its byte budget
//         for RELAY_ABUSE_MS without pause is closed with 1008 "relay-over-budget". Direct UDP is unaffected.
// Every socket: text frames are limited to TEXT_MSGS_PER_SEC/s (burst TEXT_BURST); a socket over budget for TEXT_ABUSE_MS is
//         closed with 1008 "rate-limited". ident: at most IDENT_TRIES_PER_SOCKET tries per seat, and only registered accounts.
// Host migration (lobby rooms only, i.e. no "-N" game-room suffix):
//   A client opts in with &caps=hostmig. When the host (slot 0) leaves, the
//   lowest remaining slot among opted-in members is renumbered to slot 0 (the
//   "host is slot 0" invariant the game session / port plan rely on stays true),
//   everyone opted-in gets host_changed{from_slot,slot:0,name} then members, and
//   the room stays open under the same code. Members that did not opt in (old
//   RetroHub) are closed with 4001 as before. Game rooms keep the old behaviour:
//   host leaving closes every member with 4001. State lives only in the socket
//   attachments, so it is hibernation-safe; the DO is single-threaded so there
//   is never more than one slot 0.
// S->C extra: host_changed{from_slot,slot,name}
// Distinct failure reasons (&caps=reasons; older clients keep the legacy reasons so their retry logic is unchanged):
//   bad-slot         join asked for slot 0 or a slot that is already taken (legacy: room-full)
//   host-reconnecting game room (-N) with guests but no host right now (legacy: no-such-room); clients retry
//   no-such-game     drop-in watch on a lobby with no stored host launch (or older than 6 h)
//   host-too-old     drop-in watch but the stored launch has no integer body.dropin (host RetroHub cannot serve drop-in)
//   no-free-port     drop-in watch but the host's launch announced body.dropin <= 0 (no spare port in its own plan)
//   host-left-game   sent as error{reason} just before the 4001 close when the host of a game room leaves: game over
// Drop-in (additive; a friend takes an empty controller port of a running rollback game):
//   LOBBY `&role=watch&dropin=1`: a normal lobby spectator seat (same rules/budget/limits, spec:true, not a member) plus checks
//     against the stored launch {body,at}: none/stale -> "no-such-game"; body.dropin not an integer -> "host-too-old";
//     body.dropin <= 0 -> "no-free-port" (static: the launch plan had no spare port). The server does NOT count live ports: the host RUNNER is
//     the only authority (it admits, or refuses a knock with an explicit no-free-port / busy / old-peer packet). Drop-in seats use their
//     own lobby slots 6/7 and cap of 2 and never take a spectator seat. welcome{room,slot,spec:true,dropin:true}; the
//     launch is replayed as msg{from:0,body:{...body,watch:true,dropin_join:true}}. dropin=1 with role=host/join on a lobby: ignored.
//   GAME room `&role=join&dropin=1&slot=K`: a normal member join (real slot, not spec) but refused "spectate-busy" when
//     gate().spectate is false. All other join rules unchanged.
// Spectators (&role=watch, additive; old clients never send it; any `slot` param is ignored):
//   Accept rules: host present (else same refusal as join), at most 2 spectator seats ("spectators-full"), daily budget
//   below 50% (gate().spectate, else "spectate-busy"), game rooms also need a free slot 1..3 ("room-full").
//   Attachment/member field `spec:true`. welcome{room,slot,spec:true}.
//   LOBBY room: slot 4 or 5 (lowest free), NOT a member: excluded from members/peers/pairAll/migration/binary relay (both ways),
//     receives every msg broadcast. The host's latest msg with body.kind==="launch" is kept in memory and stored (key "launch";
//     written only when the body changed, at most LAUNCH_WRITES_PER_HOUR times an hour, never at >= 90% of the daily budget)
//     and replayed to a new watcher as msg{from:0,body:{...body,watch:true}} when younger than 6 h. Host leaving closes
//     spectators with 4001 (no migration, never "keep" candidates). Spectator leave does not call syncSmash.
//   GAME room: takes a real slot 1..3, listed in members as {slot,name,spec:true} (only spec members carry the field)
//     and in peers once it sent an endpoint. Binary: a spectator may only send to dest slot 0; dest 0xFF is never delivered to
//     spectator seats; a frame addressed to a spectator slot is delivered only when it comes from slot 0. Spectators'
//     msg/ident are ignored. Host leaving closes them like other members (4001, host-left-game for reasons clients).

import { DurableObject } from "cloudflare:workers";
import { meter, gate, noteRows, RELAY_ROOM_MSGS_PER_SEC } from "./reqbudget.js";
import {
  FixedWindow, ByteBucket, SocketLimiter, RELAY_BYTES_PER_SEC, RELAY_BURST_BYTES, RELAY_ABUSE_MS, RELAY_NOTICE_MS,
  TEXT_MSGS_PER_SEC, TEXT_BURST, TEXT_ABUSE_MS, IDENT_TRIES_PER_SOCKET, IDENT_PER_ROOM_PER_HOUR, LAUNCH_WRITES_PER_HOUR,
} from "./limits.js";

const ROOM_RE = /^[A-HJ-NP-Z2-9]{6}(-[0-9]{1,6})?$/;
const ENDPOINT_RE = /^(-|[0-9]{1,3}(\.[0-9]{1,3}){3}:[0-9]{1,5})$/;
const UID_RE = /^[a-z2-7]{26}$/;
const MAX_MEMBERS = 4;
const MAX_SPECTATORS = 2;
const LOBBY_SPEC_SLOTS = [4, 5];
const LOBBY_DROPIN_SLOTS = [6, 7];   // drop-in seats: their own pool and cap, they never use a spectator seat
const MAX_NAME = 24;
const MAX_TEXT_BYTES = 4096;
const MAX_BINARY_BYTES = 1200;
const SMASH_LINK_TTL_MS = 6 * 3600 * 1000;
const isGameRoom = (room) => room.includes("-");

// Strict rooms (owner switch, default OFF; registry flag strict_rooms): EVERY seat (lobby and "-N" game rooms, spectators too) must prove a registered, approved
// account with an ident within IDENT_WAIT_MS of its welcome, or it is closed (error ident-required, 4013). Spectators prove it too (they may
// send ident). Off by default because shipped clients send ident only while "auto-friend" is on; see adminreg.js.
const IDENT_WAIT_MS = 15000;
const identWaitMs = (env) => { const v = Number(env && env.STRICT_IDENT_MS); return Number.isFinite(v) && v > 0 ? v : IDENT_WAIT_MS; };
const strictCache = { v: false, at: -1e12, p: null };   // per isolate: the flag is asked of the registry at most once a minute (STRICT_CACHE_MS overrides, tests)
export async function strictRooms(env) {
  if (!env.ADMIN_REG) return false;
  const ttl = env.STRICT_CACHE_MS !== undefined && env.STRICT_CACHE_MS !== "" && Number(env.STRICT_CACHE_MS) >= 0 ? Number(env.STRICT_CACHE_MS) : 60000;
  const t = Date.now();
  if (strictCache.p) return strictCache.p;   // a lookup is in flight: every join waits for the same answer (a cold isolate must not wave seats through)
  if (t - strictCache.at < ttl) return strictCache.v;
  strictCache.at = t;   // set first: an unreachable registry is not asked again on every join
  strictCache.p = (async () => {
    try {
      const r = await env.ADMIN_REG.get(env.ADMIN_REG.idFromName("registry")).fetch("https://registry/flags", {
        method: "POST", headers: { "x-rh-internal": "1", "content-type": "application/json" }, body: "{}",
      });
      strictCache.v = r.ok && (await r.json()).strict === true;
    } catch { strictCache.v = false; }   // never lock anybody out on an error
    finally { strictCache.p = null; }
    return strictCache.v;
  })();
  return strictCache.p;
}

/* Verifies {uid, secret} against the account's own hub (registered accounts only: a made-up uid never wakes/creates a hub).
 * -> {ok, gated:""|"pending"|"banned"|"denied"|"held", unreachable}. Shared by /hub seats and the Smash /ws lobby (index.js). */
export async function checkIdent(env, uid, secret) {
  let ok = false, gated = "", unreachable = false;
  try {
    const dir = env.DIRECTORY.get(env.DIRECTORY.idFromName("directory"));
    const known = await (await dir.fetch("https://directory/lookup?prefix=" + uid.slice(0, 8), { headers: { "x-rh-internal": "1" } })).json();
    if (known.uid === uid) {
      const stub = env.USER_HUBS.get(env.USER_HUBS.idFromName(uid));
      const res = await stub.fetch("https://userhub/i/link_auth", {
        method: "POST", headers: { "x-rh-internal": "1", "content-type": "application/json" },
        body: JSON.stringify({ uid, secret }),
      });
      const rr = await res.json();
      ok = rr.r === "ok";
      if (rr.gate) gated = rr.gate;   // a banned / waiting account is not allowed in rooms either
    }
  } catch { unreachable = true; /* no auto friending; in strict rooms an outage must not evict anybody */ }
  return { ok, gated, unreachable };
}

function cleanName(raw) {
  let s = String(raw || "").replace(/[^\x20-\x7E]/g, "").trim();
  if (s.length > MAX_NAME) s = s.slice(0, MAX_NAME);
  return s || "player";
}

export function hubFetch(request, env) {
  const url = new URL(request.url);
  if (request.headers.get("Upgrade") !== "websocket") {
    return new Response("expected websocket", { status: 426 });
  }
  const room = (url.searchParams.get("room") || "").toUpperCase();
  const role = url.searchParams.get("role");
  if (!ROOM_RE.test(room) || (role !== "host" && role !== "join" && role !== "watch")) {
    return new Response("bad room or role", { status: 400 });
  }
  const slotParam = url.searchParams.get("slot");
  if (role !== "watch" && slotParam !== null && !/^[0-3]$/.test(slotParam)) {
    return new Response("bad slot", { status: 400 });
  }
  const stub = env.HUB_ROOMS.get(env.HUB_ROOMS.idFromName(room));
  return stub.fetch(request);
}

// Host grace: an ABNORMAL drop (1006/1011: Wi-Fi blip, Worker restart) of slot 0 with members present does not migrate / close the room
// for HOST_GRACE_MS (env var of the same name overrides, 0 = off). The same host (same name) reconnecting with role=host inside the
// window reclaims slot 0; the others never saw it go (members keeps a placeholder, no 4001). After it: the normal teardown.
const HOST_GRACE_MS = 10000;
export const graceMs = (env) => { const v = Number(env && env.HOST_GRACE_MS); return Number.isFinite(v) && v >= 0 && env.HOST_GRACE_MS !== undefined && env.HOST_GRACE_MS !== "" ? v : HOST_GRACE_MS; };

export class HubRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"type":"keepalive"}', '{"type":"keepalive_ack"}'));
    // In-memory guards (a room that hibernates is idle, so losing them only resets counters).
    this.texts = new SocketLimiter(TEXT_MSGS_PER_SEC, TEXT_BURST, TEXT_ABUSE_MS);   // text frames per socket
    this.relayBytes = new SocketLimiter(RELAY_BYTES_PER_SEC, RELAY_BURST_BYTES, RELAY_ABUSE_MS);   // relayed bytes per socket
    this.roomRate = new ByteBucket(RELAY_ROOM_MSGS_PER_SEC, RELAY_ROOM_MSGS_PER_SEC * 2);   // relayed frames per room
    this.relaying = false;                 // this room has relayed a frame: its relay session already exists
    this.noticed = new WeakMap();          // socket -> when it was last told "relay_denied"
    this.identTries = new WeakMap();       // socket -> ident attempts
    this.identWin = new FixedWindow(IDENT_PER_ROOM_PER_HOUR, 3600 * 1000);
    this.launchWin = new FixedWindow(LAUNCH_WRITES_PER_HOUR, 3600 * 1000);
    this.launchMem = undefined;            // the host's latest launch {body, at} (undefined = not loaded from storage yet)
    this.launchSig = "";                   // JSON of the launch body last written to storage
  }

  /* The host's stored launch replay for late spectators / drop-ins: memory first (the write is rate limited), then storage. */
  async getLaunch() {
    if (this.launchMem === undefined) this.launchMem = (await this.ctx.storage.get("launch")) || null;
    return this.launchMem;
  }

  /* Remember the host's launch. Memory always; storage only when the body changed, at most LAUNCH_WRITES_PER_HOUR times an
   * hour, and not at all once the daily budget is nearly gone: a host that sends launch messages in a loop used to cost one
   * storage row each, from one anonymous socket. */
  async storeLaunch(body) {
    const rec = { body, at: Date.now() };
    this.launchMem = rec;
    const sig = JSON.stringify(body);
    if (sig === this.launchSig) return;
    if (!gate(this.env, (p) => this.ctx.waitUntil(p)).relayFrames) return;
    if (!this.launchWin.hit("w")) return;
    this.launchSig = sig;
    try {
      await this.ctx.storage.put("launch", rec);
      noteRows(1);
    } catch { /* rows exhausted: the replay stays in memory, the launch itself was already broadcast */ }
  }

  /* Tell a socket its relayed frames are not being forwarded (at most every RELAY_NOTICE_MS), then report "dropped". */
  denyRelay(ws, reason, detail) {
    const t = Date.now();
    if (t - (this.noticed.get(ws) || 0) >= RELAY_NOTICE_MS) {
      this.noticed.set(ws, t);
      try { ws.send(JSON.stringify({ type: "relay_denied", reason, detail })); } catch { /* closing */ }
    }
    return false;
  }

  /* May this relayed frame go out? Order: daily budget (>= 90%: nothing; >= 50%: not for a room that has not relayed yet),
   * then the room's frame rate, then the sender's byte rate (sustained abuse closes the socket). */
  relayAllowed(ws, bytes) {
    const g = gate(this.env, (p) => this.ctx.waitUntil(p));
    const busy = "Server busy, relay unavailable. Try a direct connection.";
    if (!g.relayFrames) return this.denyRelay(ws, "server-busy", busy);
    if (!this.relaying) {
      if (!g.relayNew) return this.denyRelay(ws, "server-busy", busy);
      this.relaying = true;
    }
    if (!this.roomRate.take(1)) return this.denyRelay(ws, "rate-limited", "This room is sending too much through the relay.");
    const v = this.relayBytes.check(ws, bytes);
    if (v === 2) {
      console.log("[hub] relay sustained abuse, closing a socket");
      try { ws.close(1008, "relay-over-budget"); } catch { /* already closed */ }
    }
    if (v) return this.denyRelay(ws, "rate-limited", "You are sending too much through the relay.");
    return true;
  }

  // Live members, optionally excluding one socket (the one that is closing).
  members(except) {
    const out = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      const a = ws.deserializeAttachment();
      if (!a || typeof a.slot !== "number" || a.slot < 0) continue;
      out.push({ ws, slot: a.slot, name: a.name, endpoint: a.endpoint || null, mig: !!a.mig, game: !!a.game, rs: !!a.rs, uid: a.uid || null, spec: !!a.spec, dr: !!a.dr, idw: a.idw || 0, idok: !!a.idok });
    }
    return out;
  }

  reject(reason) {
    const pair = new WebSocketPair();
    pair[1].accept();
    pair[1].send(JSON.stringify({ type: "error", reason }));
    pair[1].close(4000, reason.length <= 120 ? reason : reason.slice(0, 117) + "...");
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // Seats that count as room members: everyone except lobby-room spectators.
  players(except) { return this.members(except).filter((m) => !(m.spec && !m.game)); }

  broadcast(obj, except, list) {
    const text = JSON.stringify(obj);
    for (const m of list || this.members(except)) {
      try { m.ws.send(text); } catch { /* closing */ }
    }
  }

  sendMembers(except) {
    const ps = this.players(except);
    const list = ps.map((m) => (m.spec ? { slot: m.slot, name: m.name, spec: true } : { slot: m.slot, name: m.name }));
    if (this.grace && !ps.some((m) => m.slot === 0)) list.push({ slot: 0, name: this.grace.name });   // host held during its grace
    list.sort((a, b) => a.slot - b.slot);
    this.broadcast({ type: "members", members: list }, except, ps);
  }

  attach(ws, m) {
    ws.serializeAttachment({ slot: m.slot, name: m.name, endpoint: m.endpoint || null, mig: !!m.mig, game: !!m.game, rs: !!m.rs, uid: m.uid || null, spec: !!m.spec, dr: !!m.dr, idw: m.idw || 0, idok: !!m.idok });
  }

  sendPeers() {
    const ps = this.players();
    const peers = ps
      .filter((m) => m.endpoint)
      .map((m) => ({ slot: m.slot, public: m.endpoint.public, local: m.endpoint.local }));
    peers.sort((a, b) => a.slot - b.slot);
    this.broadcast({ type: "peers", peers }, undefined, ps);
  }

  /* Auto-friending. launch=false: `fresh` just identified; pair it with the host (host fresh: with every guest).
   * launch=true: every verified pair in the room (rate limited to once per 10 s). Each pair is one call to the
   * lower uid's UserHub, which checks blocks / caps / toggle / test flag on both sides. In-memory only. */
  async pairAll(launch, fresh) {
    if (launch) {
      const t = Date.now();
      if (this.lastLaunchPair && t - this.lastLaunchPair < 10000) return;
      this.lastLaunchPair = t;
    }
    const ids = this.players().filter((m) => m.uid && !m.spec);
    const pairs = [];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i], b = ids[j];
        if (launch || (a.uid === fresh || b.uid === fresh) && (a.slot === 0 || b.slot === 0)) pairs.push([a.uid, b.uid]);
      }
    }
    if (!this.paired) this.paired = new Set();
    for (const [x, y] of pairs) {
      const [lo, hi] = x < y ? [x, y] : [y, x];
      const key = lo + "|" + hi;
      if (this.paired.has(key)) continue;
      try {
        const stub = this.env.USER_HUBS.get(this.env.USER_HUBS.idFromName(lo));
        const res = await stub.fetch("https://userhub/i/room_pair", {
          method: "POST", headers: { "x-rh-internal": "1", "content-type": "application/json" },
          body: JSON.stringify({ uid: hi }),
        });
        const r = (await res.json()).r;
        if (r === "ok" || r === "already") this.paired.add(key);
      } catch { /* best effort */ }
    }
  }

  // Smash Classic's own lobby (/ws, NetplayRoom) with the same code announced itself (internal call): from now on a
  // member leaving this room (and a new host) is passed on to it, so the two rosters and their host stay in step.
  async smashLink(request) {
    const body = await request.json().catch(() => ({}));
    if (typeof body.room === "string" && ROOM_RE.test(body.room)) {
      await this.ctx.storage.put("smash", { room: body.room, at: Date.now() });
      noteRows(1);
    }
    return Response.json({ ok: true });
  }

  async syncSmash(gone, remap) {
    const link = await this.ctx.storage.get("smash");
    if (!link || Date.now() - link.at > SMASH_LINK_TTL_MS) return;
    try {
      await this.env.ROOMS.get(this.env.ROOMS.idFromName(link.room)).fetch("https://room/hubsync", {
        method: "POST", headers: { "x-rh-internal": "1", "content-type": "application/json" },
        body: JSON.stringify({ gone, remap }),
      });
    } catch { /* the game lobby is gone: nothing to keep in step */ }
  }

  async fetch(request) {
    meter(this.env, this.ctx, "do");
    const url = new URL(request.url);
    if (url.pathname === "/smashlink" && request.method === "POST" && request.headers.get("x-rh-internal") === "1") {
      return this.smashLink(request);
    }
    const room = (url.searchParams.get("room") || "").toUpperCase();
    const role = url.searchParams.get("role");
    const name = cleanName(url.searchParams.get("name"));
    const slotParam = role === "watch" ? null : url.searchParams.get("slot");
    const caps = (url.searchParams.get("caps") || "").split(",");
    const mig = caps.includes("hostmig");
    const rs = caps.includes("reasons");

    // The strict flag is read BEFORE the roster and the slot are chosen: awaiting it in between let two joiners pick the same slot.
    const strict = await strictRooms(this.env);
    const members = this.members();
    const taken = new Set(members.map((m) => m.slot));
    const grace = !taken.has(0) && members.length > 0 ? await this.getGrace() : null;
    let slot;
    const spec = role === "watch";
    const dropin = url.searchParams.get("dropin") === "1";
    let dropRec = null;
    if (spec) {
      if (!taken.has(0)) return this.reject(rs && (isGameRoom(room) || grace) && members.length > 0 ? "host-reconnecting" : "no-such-room");
      if (members.filter((m) => m.spec && (dropin ? m.dr : !m.dr)).length >= MAX_SPECTATORS) return this.reject("spectators-full");
      if (!gate(this.env, (p) => this.ctx.waitUntil(p)).spectate) return this.reject("spectate-busy");
      const pool = isGameRoom(room) ? [1, 2, 3] : dropin ? LOBBY_DROPIN_SLOTS : LOBBY_SPEC_SLOTS;
      slot = pool.find((s) => !taken.has(s));
      if (slot === undefined) return this.reject("room-full");
      if (dropin && !isGameRoom(room)) {
        const l = await this.getLaunch();
        if (!l || !l.body || !(Date.now() - l.at < SMASH_LINK_TTL_MS)) return this.reject("no-such-game");
        if (!Number.isInteger(l.body.dropin)) return this.reject("host-too-old");
        if (l.body.dropin <= 0) return this.reject("no-free-port");   // the host's own launch plan has no spare port (static; the host runner is the only authority on live ports and refuses a knock itself)
        dropRec = l;
      }
    } else if (role === "host") {
      if (taken.has(0)) return this.reject("room-in-use");
      if (grace) {
        if (grace.name !== name) return this.reject("room-in-use");   // somebody else asking for the held seat
        await this.clearGrace();   // the same host is back: it reclaims slot 0
      }
      slot = 0;
    } else {
      if (!taken.has(0)) return this.reject(rs && (isGameRoom(room) || grace) && members.length > 0 ? "host-reconnecting" : "no-such-room");
      if (dropin && role === "join" && isGameRoom(room) && !gate(this.env, (p) => this.ctx.waitUntil(p)).spectate) return this.reject("spectate-busy");
      if (slotParam !== null) {
        slot = Number(slotParam);
        if (slot === 0 || taken.has(slot)) return this.reject(rs ? "bad-slot" : "room-full");
      } else {
        for (let s = 1; s < MAX_MEMBERS; s++) {
          if (!taken.has(s)) { slot = s; break; }
        }
        if (slot === undefined) return this.reject("room-full");
      }
    }

    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    const idw = strict ? Date.now() + identWaitMs(this.env) : 0;   // lobby AND "-N" game rooms: a game-room name is no way around it
    pair[1].serializeAttachment({ slot, name, endpoint: null, mig, game: isGameRoom(room), rs, spec, dr: !!dropRec, idw, idok: false });
    pair[1].send(JSON.stringify(spec ? (dropRec ? { type: "welcome", room, slot, spec: true, dropin: true } : { type: "welcome", room, slot, spec: true }) : { type: "welcome", room, slot }));
    if (spec && !isGameRoom(room)) {
      const l = dropRec || await this.getLaunch();
      if (l && l.body && Date.now() - l.at < SMASH_LINK_TTL_MS) {
        try { pair[1].send(JSON.stringify({ type: "msg", from: 0, body: dropRec ? { ...l.body, watch: true, dropin_join: true } : { ...l.body, watch: true } })); } catch { /* closing */ }
      }
    }
    this.sendMembers();
    if (idw) await this.armAlarm(idw);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws, message) {
    meter(this.env, this.ctx, "ws");   // incoming messages bill 20:1 (keepalives are auto-answered and free)
    const me = ws.deserializeAttachment();
    if (!me || typeof me.slot !== "number" || me.slot < 0) return;   // departed / being closed

    if (typeof message !== "string") {
      // Relayed game packet: byte0 = destination slot.
      if (message.byteLength < 1 || message.byteLength > MAX_BINARY_BYTES) return;
      if (me.spec && !me.game) return;   // lobby spectators never send binary
      // Cost guard and caps (daily budget, room frame rate, socket byte rate); a refused frame is answered with relay_denied.
      if (!this.relayAllowed(ws, message.byteLength)) return;
      const src = new Uint8Array(message);
      const dest = src[0];
      const out = new Uint8Array(src.length);
      out.set(src);
      out[0] = me.slot;
      if (me.spec && dest !== 0) return;   // a game-room spectator may only talk to the host
      for (const m of this.members()) {
        if (m.ws === ws) continue;
        if (m.spec) {   // spectators never get broadcasts; lobby ones no binary at all; game ones only host-addressed frames
          if (!m.game || dest === 0xff || me.slot !== 0) continue;
        }
        if (dest === 0xff || dest === m.slot) {
          try { m.ws.send(out); } catch { /* closing */ }
        }
      }
      return;
    }
    // Text frames: a per-socket budget before any parsing (a flood is dropped, and the socket closed once it stays over).
    const tv = this.texts.check(ws);
    if (tv) {
      if (tv === 2) { try { ws.close(1008, "rate-limited"); } catch { /* already closed */ } }
      return;
    }
    if (message.length > MAX_TEXT_BYTES) return;

    let msg;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    if (me.spec && msg.type !== "ident" && (msg.type !== "endpoint" || !me.game)) return;   // spectators never send msg (they may prove their account with ident)
    switch (msg.type) {
      case "msg": {
        if (msg.body === null || typeof msg.body !== "object") return;
        this.broadcast({ type: "msg", from: me.slot, body: msg.body }, ws);
        // The host's launch is kept for late spectators / drop-ins: storage is written once per changed launch (storeLaunch).
        if (me.slot === 0 && msg.body.kind === "launch" && !me.game) await this.storeLaunch(msg.body);
        // The host starting a game: everyone present who proved their account becomes friends with each other.
        if (me.slot === 0 && msg.body.kind === "launch" && !me.game) await this.pairAll(true);
        break;
      }
      case "ident": {
        // {type:"ident",uid,secret}: proves which account this seat is (checked against the account's own hub).
        // Only used for automatic friending; never forwarded to other members. One DO call per seat.
        if (me.uid || me.idok || typeof msg.uid !== "string" || !UID_RE.test(msg.uid) || typeof msg.secret !== "string") return;
        // A seat sends one ident per welcome. Retries are capped per seat and per room, and only REGISTERED accounts are woken:
        // an ident with a made-up uid used to make the Worker create (and write the schema of) a brand-new account hub, each time.
        const tries = (this.identTries.get(ws) || 0) + 1;
        this.identTries.set(ws, tries);
        if (tries > IDENT_TRIES_PER_SOCKET || !this.identWin.hit("r")) return;
        const { ok, gated, unreachable } = await checkIdent(this.env, msg.uid, msg.secret);
        if (gated) {   // a banned / denied / waiting account: told why, then closed ("held" = new account while the registry is down)
          const reason = gated === "pending" ? "pending-approval" : gated === "held" ? "server-busy" : "account-unavailable";
          try { ws.send(JSON.stringify({ type: "error", reason })); } catch { /* closing */ }
          try { ws.close(gated === "pending" ? 4012 : gated === "held" ? 4014 : 4010, reason); } catch { /* closed */ }
          return;
        }
        const now = ws.deserializeAttachment();
        if (unreachable && now && typeof now.slot === "number" && now.slot >= 0 && !now.idok) { ws.serializeAttachment({ ...now, idok: true, idw: 0 }); return; }
        if (!ok || !now || typeof now.slot !== "number" || now.slot < 0 || now.uid || now.idok) return;
        // Proof only (no pairing) for spectators, game-room seats and {nopair:true} idents (a client whose auto-friend is off still proves its
        // account). A second seat of an account already in the room (a second PC) is proof only too: one pairing per account, any number of seats.
        if (me.spec || me.game || msg.nopair === true || this.members().some((m) => m.uid === msg.uid)) { ws.serializeAttachment({ ...now, idok: true, idw: 0 }); return; }
        ws.serializeAttachment({ ...now, uid: msg.uid, idok: true, idw: 0 });
        await this.pairAll(false, msg.uid);
        break;
      }
      case "endpoint": {
        const clean = (v) => (typeof v === "string" && v.length <= 64 && ENDPOINT_RE.test(v) ? v : "-");
        ws.serializeAttachment({
          slot: me.slot,
          name: me.name,
          endpoint: { public: clean(msg.public), local: clean(msg.local) },
          mig: !!me.mig,
          game: !!me.game,
          rs: !!me.rs,
          uid: me.uid || null,
          spec: !!me.spec,
          idw: me.idw || 0,
          idok: !!me.idok,
        });
        this.sendPeers();
        break;
      }
      default:
        break;
    }
  }

  async webSocketClose(ws, code) {
    const me = ws.deserializeAttachment();
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "closed");
    } catch {
      // already closed
    }
    if (!me || typeof me.slot !== "number" || me.slot < 0) return;
    const abnormal = code === 1006 || code === 1011;
    // Mark as departed so a second close/error event for this socket (or the
    // late close of a socket we closed ourselves) is a no-op.
    try { ws.serializeAttachment({ slot: -1 }); } catch { /* closed */ }
    if (me.slot === 0 && abnormal && graceMs(this.env) > 0 && !(await this.getGrace()) && this.members(ws).some((m) => !(m.spec && !m.game))) {
      await this.setGrace({ name: me.name, game: !!me.game, mig: !!me.mig, rs: !!me.rs });
      return;   // hold slot 0: guests keep their view of the room
    }
    if (me.slot !== 0) {
      if (this.members(ws).every((m) => m.slot !== 0)) await this.getGrace();   // loads the placeholder for sendMembers
      this.sendMembers(ws);
      if (!me.game && !me.spec) await this.syncSmash([me.slot], null);
      return;
    }
    await this.hostGone(me, ws);
  }

  async hostGone(me, ws) {
    const rest = this.members(ws);
    const keep = me.game ? [] : rest.filter((m) => m.mig && !m.spec);
    for (const m of rest) {
      if (keep.includes(m)) continue;
      if (me.game && m.rs) { try { m.ws.send(JSON.stringify({ type: "error", reason: "host-left-game" })); } catch { /* closed */ } }
      try { m.ws.close(4001, "host-left"); } catch { /* closed */ }
      try { m.ws.serializeAttachment({ slot: -1 }); } catch { /* closed */ }
    }
    if (!keep.length) {
      if (!me.game) await this.syncSmash([0], null);
      return;
    }
    keep.sort((a, b) => a.slot - b.slot);
    const nh = keep[0];
    const from = nh.slot;
    this.attach(nh.ws, { ...nh, slot: 0 });
    this.broadcast({ type: "host_changed", from_slot: from, slot: 0, name: nh.name });
    this.sendMembers();
    this.sendPeers();
    if (!me.game) await this.syncSmash([0], { from, to: 0 });
  }

  // ---- host grace (see HOST_GRACE_MS) ----
  async getGrace() {
    if (this.graceLoaded) return this.grace || null;
    this.grace = (await this.ctx.storage.get("hostgrace")) || null;
    this.graceLoaded = true;
    if (this.grace && Date.now() > this.grace.until + 2000) { await this.alarm(); return null; }
    return this.grace;
  }

  async setGrace(g) {
    this.grace = { ...g, until: Date.now() + graceMs(this.env) };
    this.graceLoaded = true;
    await this.ctx.storage.put("hostgrace", this.grace);
    await this.armAlarm(this.grace.until);
    noteRows(2);
    this.sendMembers();   // placeholder keeps the host listed
  }

  async clearGrace() {
    this.grace = null;
    this.graceLoaded = true;
    await this.ctx.storage.delete("hostgrace");
    try { await this.ctx.storage.deleteAlarm(); } catch { /* none */ }
    await this.armIdent();   // a pending ident deadline must survive the grace ending
  }

  /* One storage alarm per room serves the host grace and the strict-room ident deadlines: it is only ever moved EARLIER here, and
   * alarm() re-arms whatever is still pending. */
  async armAlarm(at) {
    try {
      const cur = await this.ctx.storage.getAlarm();
      if (cur && cur > Date.now() && cur <= at) return;
      await this.ctx.storage.setAlarm(at);
      noteRows(1);
    } catch { /* storage alarm unavailable */ }
  }

  async armIdent() {
    const due = this.members().filter((m) => m.idw > Date.now() && !m.idok && !m.uid).map((m) => m.idw);
    if (due.length) await this.armAlarm(Math.min(...due));
  }

  /* Strict rooms: close every seat whose ident deadline passed without a proven account. */
  async sweepIdent() {
    const t = Date.now();
    for (const m of this.members()) {
      if (!m.idw || m.idok || m.uid || t < m.idw) continue;
      try { m.ws.send(JSON.stringify({ type: "error", reason: "ident-required" })); } catch { /* closing */ }
      try { m.ws.close(4013, "ident-required"); } catch { /* closed */ }
    }
    await this.armIdent();
  }

  // Grace over and the host never came back: the teardown webSocketClose would have done at once.
  async alarm() {
    await this.sweepIdent();
    const g = this.grace && this.graceLoaded ? this.grace : await this.ctx.storage.get("hostgrace");
    if (g && Date.now() < g.until - 50) {   // woken by an ident deadline, the grace is still running
      this.grace = g; this.graceLoaded = true;
      await this.armAlarm(g.until);
      return;
    }
    this.grace = null;
    this.graceLoaded = true;
    if (!g) return;
    await this.ctx.storage.delete("hostgrace");
    if (this.members().some((m) => m.slot === 0)) return;   // reclaimed in the meantime
    await this.hostGone({ slot: 0, name: g.name, game: g.game, mig: g.mig, rs: g.rs }, undefined);
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws, 1011);
  }
}
