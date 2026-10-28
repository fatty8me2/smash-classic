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
//   host-left-game   sent as error{reason} just before the 4001 close when the host of a game room leaves: game over
// Spectators (&role=watch, additive; old clients never send it; any `slot` param is ignored):
//   Accept rules: host present (else same refusal as join), at most 2 spectator seats ("spectators-full"), daily budget
//   below 50% (gate().spectate, else "spectate-busy"), game rooms also need a free slot 1..3 ("room-full").
//   Attachment/member field `spec:true`. welcome{room,slot,spec:true}.
//   LOBBY room: slot 4 or 5 (lowest free), NOT a member: excluded from members/peers/pairAll/migration/binary relay (both ways),
//     receives every msg broadcast. The host's latest msg with body.kind==="launch" is stored (one storage write, key "launch")
//     and replayed to a new watcher as msg{from:0,body:{...body,watch:true}} when younger than 6 h. Host leaving closes
//     spectators with 4001 (no migration, never "keep" candidates). Spectator leave does not call syncSmash.
//   GAME room: takes a real slot 1..3, listed in members as {slot,name,spec:true} (only spec members carry the field)
//     and in peers once it sent an endpoint. Binary: a spectator may only send to dest slot 0; dest 0xFF is never delivered to
//     spectator seats; a frame addressed to a spectator slot is delivered only when it comes from slot 0. Spectators'
//     msg/ident are ignored. Host leaving closes them like other members (4001, host-left-game for reasons clients).

import { DurableObject } from "cloudflare:workers";
import { meter, gate } from "./reqbudget.js";

const ROOM_RE = /^[A-HJ-NP-Z2-9]{6}(-[0-9]{1,6})?$/;
const ENDPOINT_RE = /^(-|[0-9]{1,3}(\.[0-9]{1,3}){3}:[0-9]{1,5})$/;
const UID_RE = /^[a-z2-7]{26}$/;
const MAX_MEMBERS = 4;
const MAX_SPECTATORS = 2;
const LOBBY_SPEC_SLOTS = [4, 5];
const MAX_NAME = 24;
const MAX_TEXT_BYTES = 4096;
const MAX_BINARY_BYTES = 1200;
const SMASH_LINK_TTL_MS = 6 * 3600 * 1000;
const isGameRoom = (room) => room.includes("-");

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

export class HubRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"type":"keepalive"}', '{"type":"keepalive_ack"}'));
  }

  // Live members, optionally excluding one socket (the one that is closing).
  members(except) {
    const out = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      const a = ws.deserializeAttachment();
      if (!a || typeof a.slot !== "number" || a.slot < 0) continue;
      out.push({ ws, slot: a.slot, name: a.name, endpoint: a.endpoint || null, mig: !!a.mig, game: !!a.game, rs: !!a.rs, uid: a.uid || null, spec: !!a.spec });
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
    list.sort((a, b) => a.slot - b.slot);
    this.broadcast({ type: "members", members: list }, except, ps);
  }

  attach(ws, m) {
    ws.serializeAttachment({ slot: m.slot, name: m.name, endpoint: m.endpoint || null, mig: !!m.mig, game: !!m.game, rs: !!m.rs, uid: m.uid || null, spec: !!m.spec });
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

    const members = this.members();
    const taken = new Set(members.map((m) => m.slot));
    let slot;
    const spec = role === "watch";
    if (spec) {
      if (!taken.has(0)) return this.reject(rs && isGameRoom(room) && members.length > 0 ? "host-reconnecting" : "no-such-room");
      if (members.filter((m) => m.spec).length >= MAX_SPECTATORS) return this.reject("spectators-full");
      if (!gate(this.env, (p) => this.ctx.waitUntil(p)).spectate) return this.reject("spectate-busy");
      const pool = isGameRoom(room) ? [1, 2, 3] : LOBBY_SPEC_SLOTS;
      slot = pool.find((s) => !taken.has(s));
      if (slot === undefined) return this.reject("room-full");
    } else if (role === "host") {
      if (taken.has(0)) return this.reject("room-in-use");
      slot = 0;
    } else {
      if (!taken.has(0)) return this.reject(rs && isGameRoom(room) && members.length > 0 ? "host-reconnecting" : "no-such-room");
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
    pair[1].serializeAttachment({ slot, name, endpoint: null, mig, game: isGameRoom(room), rs, spec });
    pair[1].send(JSON.stringify(spec ? { type: "welcome", room, slot, spec: true } : { type: "welcome", room, slot }));
    if (spec && !isGameRoom(room)) {
      const l = await this.ctx.storage.get("launch");
      if (l && l.body && Date.now() - l.at < SMASH_LINK_TTL_MS) {
        try { pair[1].send(JSON.stringify({ type: "msg", from: 0, body: { ...l.body, watch: true } })); } catch { /* closing */ }
      }
    }
    this.sendMembers();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws, message) {
    meter(this.env, this.ctx, "ws");   // incoming messages bill 20:1 (keepalives are auto-answered and free)
    const me = ws.deserializeAttachment();
    if (!me || typeof me.slot !== "number" || me.slot < 0) return;   // departed / being closed

    if (typeof message !== "string") {
      // Relayed game packet: byte0 = destination slot.
      if (message.byteLength < 1 || message.byteLength > MAX_BINARY_BYTES) return;
      if (!gate(this.env).relayFrames) return;   // cost guard: >=90% of the daily budget, stop relaying game packets
      if (me.spec && !me.game) return;   // lobby spectators never send binary
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
    if (message.length > MAX_TEXT_BYTES) return;

    let msg;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    if (me.spec && (msg.type !== "endpoint" || !me.game)) return;   // spectators never send msg/ident
    switch (msg.type) {
      case "msg": {
        if (msg.body === null || typeof msg.body !== "object") return;
        this.broadcast({ type: "msg", from: me.slot, body: msg.body }, ws);
        if (me.slot === 0 && msg.body.kind === "launch" && !me.game) await this.ctx.storage.put("launch", { body: msg.body, at: Date.now() });
        // The host starting a game: everyone present who proved their account becomes friends with each other.
        if (me.slot === 0 && msg.body.kind === "launch" && !me.game) await this.pairAll(true);
        break;
      }
      case "ident": {
        // {type:"ident",uid,secret}: proves which account this seat is (checked against the account's own hub).
        // Only used for automatic friending; never forwarded to other members. One DO call per seat.
        if (me.uid || typeof msg.uid !== "string" || !UID_RE.test(msg.uid) || typeof msg.secret !== "string") return;
        if (me.game) return;
        let ok = false;
        try {
          const stub = this.env.USER_HUBS.get(this.env.USER_HUBS.idFromName(msg.uid));
          const res = await stub.fetch("https://userhub/i/link_auth", {
            method: "POST", headers: { "x-rh-internal": "1", "content-type": "application/json" },
            body: JSON.stringify({ uid: msg.uid, secret: msg.secret }),
          });
          ok = (await res.json()).r === "ok";
        } catch { /* unreachable: no auto friending */ }
        const now = ws.deserializeAttachment();
        if (!ok || !now || typeof now.slot !== "number" || now.slot < 0 || now.uid) return;
        if (this.members().some((m) => m.uid === msg.uid)) return;   // one seat per account
        ws.serializeAttachment({ ...now, uid: msg.uid });
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
    // Mark as departed so a second close/error event for this socket (or the
    // late close of a socket we closed ourselves) is a no-op.
    try { ws.serializeAttachment({ slot: -1 }); } catch { /* closed */ }
    if (me.slot !== 0) {
      this.sendMembers(ws);
      if (!me.game && !me.spec) await this.syncSmash([me.slot], null);
      return;
    }
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

  async webSocketError(ws) {
    await this.webSocketClose(ws, 1011);
  }
}
