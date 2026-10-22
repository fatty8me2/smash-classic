// BattleShip netplay lobby on Cloudflare Workers.
//
// Each room is a Durable Object keyed by its 6-character code. Players
// connect over WebSocket:
//
//   GET /ws?room=CODE&role=host|join[&v=2]      (WebSocket upgrade)
//   GET /health
//
// Protocol v2 (up to 4 players: the host is slot 0, joiners take slots 1-3)
// Control messages are JSON text frames:
//   C->S {type:"endpoint", public:"ip:port", local:"ip:port"}
//          the client's UDP addresses (public from STUN, LAN from the OS)
//   S->C {type:"welcome", room, role, slot, max}
//   S->C {type:"peers", peers:[{slot, public, local}, ...]}
//          every member of the room (including the receiver); sent again
//          whenever someone joins, leaves or reports an endpoint. public and
//          local are "-" until that member has reported its endpoint.
//   C->S {type:"relay"}          direct UDP failed for some pair; allow relaying
//   S->C {type:"relaying"}       to everyone; binary frames are now forwarded
//   C->S {type:"keepalive"}  ->  S->C {type:"keepalive_ack"}
//   S->C {type:"peer_left", slot}
//   S->C {type:"error", reason}  then close 4000
//
// Binary frames carry relayed game packets. The first byte is the DESTINATION
// MASK when sent (bit n = slot n, so one frame can reach several players) and
// is rewritten to the SOURCE slot on delivery; the rest of the frame is
// forwarded verbatim. Frames are only forwarded once relaying is on. Game
// traffic normally goes peer-to-peer over UDP (a full mesh) and never touches
// the Worker.
//
// Legacy (protocol v1, no `v` parameter; older game builds): two players, the
// "peer" message carries the single opponent's endpoints, and binary frames
// are forwarded verbatim to the other player. A room is either v1 or v2,
// decided by its host; the other kind is refused with a readable reason.

import { DurableObject } from "cloudflare:workers";
import { hubFetch, HubRoom } from "./hub.js";

import { friendsFetch, UserHub, Directory } from "./friends.js";

export { HubRoom, UserHub, Directory };

const CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;
const MAX_TEXT_BYTES = 2048;
const MAX_BINARY_BYTES = 1024;
const MAX_PLAYERS = 4;

function send(ws, data) {
  try {
    ws.send(data);
  } catch {
    // the socket is closing
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "smash-netplay", netplay: 2, maxPlayers: MAX_PLAYERS });
    }
    if (url.pathname === "/hub") {
      return hubFetch(request, env);
    }
    if (url.pathname === "/friends") {
      return friendsFetch(request, env);
    }
    if (url.pathname !== "/ws") {
      return new Response("not found", { status: 404 });
    }
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const room = (url.searchParams.get("room") || "").toUpperCase();
    const role = url.searchParams.get("role");
    if (!CODE_RE.test(room) || (role !== "host" && role !== "join")) {
      return new Response("bad room or role", { status: 400 });
    }
    const stub = env.ROOMS.get(env.ROOMS.idFromName(room));
    return stub.fetch(request);
  },
};

export class NetplayRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"type":"keepalive"}', '{"type":"keepalive_ack"}'));
    // In-memory copies of the room flags (null = not loaded yet, e.g. after hibernation).
    this.relay = null;
    this.legacy = null;
    this.ctx.blockConcurrencyWhile(async () => {
      this.relay = (await this.ctx.storage.get("relay")) === true;
      this.legacy = (await this.ctx.storage.get("legacy")) === true;
    });
  }

  // ---- membership: sockets are tagged ["host"|"join", "s<slot>"] ----

  // Slot lookups sit on the per-packet relay path, so they come from memory;
  // the cache is rebuilt from the runtime's socket list after a hibernation.
  loadSockets() {
    if (this.slots) return;
    this.slots = [null, null, null, null];
    this.slotIndex = new Map();
    for (const ws of this.ctx.getWebSockets()) {
      const tag = this.ctx.getTags(ws).find((t) => /^s\d$/.test(t));
      if (!tag) continue;
      const slot = Number(tag.slice(1));
      this.slots[slot] = ws;
      this.slotIndex.set(ws, slot);
    }
  }

  socketAt(slot) {
    this.loadSockets();
    return this.slots[slot] || null;
  }

  slotOf(ws) {
    this.loadSockets();
    const slot = this.slotIndex.get(ws);
    return slot === undefined ? -1 : slot;
  }

  addSocket(ws, slot) {
    this.loadSockets();
    this.slots[slot] = ws;
    this.slotIndex.set(ws, slot);
  }

  removeSocket(ws) {
    this.loadSockets();
    const slot = this.slotIndex.get(ws);
    if (slot !== undefined && this.slots[slot] === ws) this.slots[slot] = null;
    this.slotIndex.delete(ws);
  }

  members() {
    const list = [];
    for (let slot = 0; slot < MAX_PLAYERS; slot++) {
      const ws = this.socketAt(slot);
      if (ws) list.push({ slot, ws });
    }
    return list;
  }

  reject(reason) {
    const pair = new WebSocketPair();
    pair[1].accept();
    pair[1].send(JSON.stringify({ type: "error", reason }));
    pair[1].close(4000, reason);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async fetch(request) {
    const url = new URL(request.url);
    const room = url.searchParams.get("room").toUpperCase();
    const role = url.searchParams.get("role");
    const legacy = Number(url.searchParams.get("v") || 1) < 2;

    if (role === "host" && this.socketAt(0)) return this.reject("room-in-use");
    if (role === "join" && !this.socketAt(0)) return this.reject("no-such-room");

    let slot = 0;
    if (role === "host") {
      // A new host starts a fresh room (relay off).
      await this.ctx.storage.deleteAll();
      this.relay = false;
      this.legacy = legacy;
      await this.ctx.storage.put("legacy", legacy);
    } else {
      if (this.legacy !== legacy) {
        return this.reject(legacy
          ? "This room needs a newer version of the game (it supports up to 4 players). Update the game and join again."
          : "This room was hosted with an older version of the game. Ask the host to update, or host the room again.");
      }
      slot = -1;
      for (let s = 1; s < (legacy ? 2 : MAX_PLAYERS); s++) {
        if (!this.socketAt(s)) { slot = s; break; }
      }
      if (slot < 0) return this.reject("room-full");
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [role, `s${slot}`]);
    this.addSocket(pair[1], slot);
    pair[1].serializeAttachment({ endpoint: null });
    pair[1].send(JSON.stringify(legacy
      ? { type: "welcome", room, role }
      : { type: "welcome", room, role, slot, max: MAX_PLAYERS }));
    this.announce();

    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // Tell everyone who is in the room and where to reach them.
  announce() {
    if (this.legacy) {
      this.introduceLegacy();
      return;
    }
    const peers = this.members().map(({ slot, ws }) => {
      const endpoint = ws.deserializeAttachment()?.endpoint;
      return { slot, public: endpoint?.public || "-", local: endpoint?.local || "-" };
    });
    const text = JSON.stringify({ type: "peers", peers });
    for (const { ws } of this.members()) send(ws, text);
  }

  // Legacy: both players known with endpoints: tell each about the other.
  introduceLegacy() {
    const host = this.socketAt(0);
    const join = this.socketAt(1);
    if (!host || !join) return;
    const he = host.deserializeAttachment()?.endpoint;
    const je = join.deserializeAttachment()?.endpoint;
    if (!he || !je) return;
    host.send(JSON.stringify({ type: "peer", role: "join", public: je.public, local: je.local }));
    join.send(JSON.stringify({ type: "peer", role: "host", public: he.public, local: he.local }));
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== "string") {
      // Relayed game packet.
      if (message.byteLength > MAX_BINARY_BYTES) return;
      if (this.relay === null) this.relay = (await this.ctx.storage.get("relay")) === true;
      if (this.legacy === null) this.legacy = (await this.ctx.storage.get("legacy")) === true;
      if (!this.relay) return;

      const from = this.slotOf(ws);
      if (this.legacy) {
        const other = this.socketAt(from === 0 ? 1 : 0);
        if (other) other.send(message);
        return;
      }
      if (message.byteLength < 2) return;
      // [destination mask][payload]: one frame can fan out to several players
      // (bit n = slot n); each gets [source slot][payload].
      const bytes = new Uint8Array(message);
      const mask = bytes[0] & ((1 << MAX_PLAYERS) - 1);
      bytes[0] = from;
      for (let dest = 0; dest < MAX_PLAYERS; dest++) {
        if (!(mask & (1 << dest)) || dest === from) continue;
        const target = this.socketAt(dest);
        if (target) send(target, bytes);
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
    switch (msg.type) {
      case "endpoint":
        ws.serializeAttachment({
          endpoint: { public: String(msg.public || "-").slice(0, 64), local: String(msg.local || "-").slice(0, 64) },
        });
        this.announce();
        break;
      case "relay": {
        await this.ctx.storage.put("relay", true);
        this.relay = true;
        const text = JSON.stringify({ type: "relaying" });
        for (const s of this.ctx.getWebSockets()) send(s, text);
        break;
      }
      default:
        break;
    }
  }

  async webSocketClose(ws, code) {
    const slot = this.slotOf(ws);
    this.removeSocket(ws);
    try {
      ws.close(code === 1005 ? 1000 : code, "closed");
    } catch {
      // already closed
    }
    const text = JSON.stringify({ type: "peer_left", slot });
    for (const { slot: other, ws: socket } of this.members()) {
      if (other === slot) continue;
      send(socket, text);
      if (slot === 0) {
        try {
          socket.close(4001, "host-left");
        } catch {
          // already closed
        }
      }
    }
    if (slot !== 0) {
      // Joiner gone: its slot is free again and everyone learns the new roster.
      // (getWebSockets still lists the closing socket until the handler returns,
      // so the roster is rebuilt without it.)
      this.announceWithout(ws);
    }
  }

  announceWithout(gone) {
    if (this.legacy) return;
    const peers = [];
    const live = [];
    for (const { slot, ws } of this.members()) {
      if (ws === gone) continue;
      const endpoint = ws.deserializeAttachment()?.endpoint;
      peers.push({ slot, public: endpoint?.public || "-", local: endpoint?.local || "-" });
      live.push(ws);
    }
    const text = JSON.stringify({ type: "peers", peers });
    for (const ws of live) send(ws, text);
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws, 1011);
  }
}
