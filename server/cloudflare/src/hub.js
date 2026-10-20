// Classic Hub lobby: GET /hub?room=CODE[-N]&role=host|join&name=NAME[&slot=K]
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
// Host leaving closes every member with 4001.

import { DurableObject } from "cloudflare:workers";

const ROOM_RE = /^[A-HJ-NP-Z2-9]{6}(-[0-9]{1,6})?$/;
const ENDPOINT_RE = /^(-|[0-9]{1,3}(\.[0-9]{1,3}){3}:[0-9]{1,5})$/;
const MAX_MEMBERS = 4;
const MAX_NAME = 24;
const MAX_TEXT_BYTES = 4096;
const MAX_BINARY_BYTES = 1200;

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
  if (!ROOM_RE.test(room) || (role !== "host" && role !== "join")) {
    return new Response("bad room or role", { status: 400 });
  }
  const slotParam = url.searchParams.get("slot");
  if (slotParam !== null && !/^[0-3]$/.test(slotParam)) {
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
      if (!a || typeof a.slot !== "number") continue;
      out.push({ ws, slot: a.slot, name: a.name, endpoint: a.endpoint || null });
    }
    return out;
  }

  reject(reason) {
    const pair = new WebSocketPair();
    pair[1].accept();
    pair[1].send(JSON.stringify({ type: "error", reason }));
    pair[1].close(4000, reason);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  broadcast(obj, except) {
    const text = JSON.stringify(obj);
    for (const m of this.members(except)) {
      try { m.ws.send(text); } catch { /* closing */ }
    }
  }

  sendMembers(except) {
    const list = this.members(except).map((m) => ({ slot: m.slot, name: m.name }));
    list.sort((a, b) => a.slot - b.slot);
    this.broadcast({ type: "members", members: list }, except);
  }

  sendPeers() {
    const peers = this.members()
      .filter((m) => m.endpoint)
      .map((m) => ({ slot: m.slot, public: m.endpoint.public, local: m.endpoint.local }));
    peers.sort((a, b) => a.slot - b.slot);
    this.broadcast({ type: "peers", peers });
  }

  async fetch(request) {
    const url = new URL(request.url);
    const room = (url.searchParams.get("room") || "").toUpperCase();
    const role = url.searchParams.get("role");
    const name = cleanName(url.searchParams.get("name"));
    const slotParam = url.searchParams.get("slot");

    const members = this.members();
    const taken = new Set(members.map((m) => m.slot));
    let slot;
    if (role === "host") {
      if (taken.has(0)) return this.reject("room-in-use");
      slot = 0;
    } else {
      if (!taken.has(0)) return this.reject("no-such-room");
      if (slotParam !== null) {
        slot = Number(slotParam);
        if (slot === 0 || taken.has(slot)) return this.reject("room-full");
      } else {
        for (let s = 1; s < MAX_MEMBERS; s++) {
          if (!taken.has(s)) { slot = s; break; }
        }
        if (slot === undefined) return this.reject("room-full");
      }
    }

    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ slot, name, endpoint: null });
    pair[1].send(JSON.stringify({ type: "welcome", room, slot }));
    this.sendMembers();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws, message) {
    const me = ws.deserializeAttachment();
    if (!me || typeof me.slot !== "number") return;

    if (typeof message !== "string") {
      // Relayed game packet: byte0 = destination slot.
      if (message.byteLength < 1 || message.byteLength > MAX_BINARY_BYTES) return;
      const src = new Uint8Array(message);
      const dest = src[0];
      const out = new Uint8Array(src.length);
      out.set(src);
      out[0] = me.slot;
      for (const m of this.members()) {
        if (m.ws === ws) continue;
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
    switch (msg.type) {
      case "msg": {
        if (msg.body === null || typeof msg.body !== "object") return;
        this.broadcast({ type: "msg", from: me.slot, body: msg.body }, ws);
        break;
      }
      case "endpoint": {
        const clean = (v) => (typeof v === "string" && v.length <= 64 && ENDPOINT_RE.test(v) ? v : "-");
        ws.serializeAttachment({
          slot: me.slot,
          name: me.name,
          endpoint: { public: clean(msg.public), local: clean(msg.local) },
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
    if (!me || typeof me.slot !== "number") return;
    if (me.slot === 0) {
      for (const m of this.members(ws)) {
        try { m.ws.close(4001, "host-left"); } catch { /* closed */ }
      }
    } else {
      this.sendMembers(ws);
    }
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws, 1011);
  }
}
