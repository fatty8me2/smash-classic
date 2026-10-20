// BattleShip netplay lobby on Cloudflare Workers.
//
// Each room is a Durable Object keyed by its 6-character code. Players
// connect over WebSocket:
//
//   GET /ws?room=CODE&role=host|join      (WebSocket upgrade)
//   GET /health
//
// Control messages are JSON text frames:
//   C->S {type:"endpoint", public:"ip:port", local:"ip:port"}
//          the client's UDP addresses (public from STUN, LAN from the OS)
//   S->C {type:"welcome", room, role}
//   S->C {type:"peer", role, public, local}   once both endpoints are known
//   C->S {type:"relay"}          direct UDP failed; relay game traffic here
//   S->C {type:"relaying"}       to both; binary frames are now forwarded
//   C->S {type:"keepalive"}  ->  S->C {type:"keepalive_ack"}
//   S->C {type:"peer_left"}
//   S->C {type:"error", reason}  then close 4000
//
// Binary frames carry relayed game packets and are forwarded verbatim to
// the other player once relaying is on. Game traffic normally goes
// peer-to-peer over UDP and never touches the Worker.

import { DurableObject } from "cloudflare:workers";
import { hubFetch, HubRoom } from "./hub.js";

export { HubRoom };

const CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;
const MAX_TEXT_BYTES = 2048;
const MAX_BINARY_BYTES = 1024;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "smash-netplay" });
    }
    if (url.pathname === "/hub") {
      return hubFetch(request, env);
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
  }

  socket(role) {
    return this.ctx.getWebSockets(role)[0] || null;
  }

  other(ws) {
    const role = this.roleOf(ws);
    return this.socket(role === "host" ? "join" : "host");
  }

  roleOf(ws) {
    return this.ctx.getTags(ws)[0];
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

    if (role === "host" && this.socket("host")) return this.reject("room-in-use");
    if (role === "join" && !this.socket("host")) return this.reject("no-such-room");
    if (role === "join" && this.socket("join")) return this.reject("room-full");

    if (role === "host") {
      // A new host starts a fresh room (relay off).
      await this.ctx.storage.deleteAll();
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [role]);
    pair[1].serializeAttachment({ endpoint: null });
    pair[1].send(JSON.stringify({ type: "welcome", room, role }));
    this.introduce();

    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // Both players known with endpoints: tell each about the other.
  introduce() {
    const host = this.socket("host");
    const join = this.socket("join");
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
      if (await this.ctx.storage.get("relay")) {
        const other = this.other(ws);
        if (other) other.send(message);
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
        this.introduce();
        break;
      case "relay": {
        await this.ctx.storage.put("relay", true);
        const text = JSON.stringify({ type: "relaying" });
        for (const s of this.ctx.getWebSockets()) s.send(text);
        break;
      }
      default:
        break;
    }
  }

  async webSocketClose(ws, code) {
    const other = this.other(ws);
    if (other) {
      other.send(JSON.stringify({ type: "peer_left" }));
      if (this.roleOf(ws) === "host") other.close(4001, "host-left");
    }
    try {
      ws.close(code === 1005 ? 1000 : code, "closed");
    } catch {
      // already closed
    }
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws, 1011);
  }
}
