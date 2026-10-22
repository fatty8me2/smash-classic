# Online Play (Room Codes + Rollback)

Two to four players, free-for-all stock battle, rollback netcode.

## Playing

1. Everyone opens the **Esc** menu → **Online** → **Netplay**.
2. Choose a fighter. The lobby server is built in (`wss://smash-netplay.jumpcircuit.workers.dev`); it can be changed under **Advanced**.
3. **Hosting.** One player:
   - picks the stage, stocks, items and input delay;
   - presses **Host**;
   - shares the 6-character **room code** (the **Copy** button puts it on the clipboard).
4. **Joining.** The other players (up to three) type the code and press **Join**.
5. **Connecting.** The status line shows **Connected (direct)**, or **Connected (via relay)** when a router won't allow a direct path. Below it, every player is listed with their fighter pick, connection state and ping.
6. **Starting.** When everyone in the room is connected and has picked a fighter, the host presses **Start match**. All games jump straight into the VS battle with everyone who was connected at that moment.
7. **Rematch.** After the match, the room stays open; the host can press **Start rematch**. Players can change their fighter first; late joiners are included.

Online matches use rollback netcode. Your input applies after a short **input delay** (2 frames by default). The other players' inputs are predicted, and the game silently rewinds and replays (up to 6 frames) when a prediction was wrong. Raise the input delay on high-ping connections for fewer visible corrections.

If a player's data stops arriving mid-match (they quit, or lost their connection), everyone else's game waits for them and shows "Waiting for Player N...". There is no drop-out handling yet.

## The lobby server (Cloudflare)

The server is `server/cloudflare`: a Cloudflare Worker plus one Durable Object per room. It follows the same pattern as the Jump Circuit relay.

**What it does:**
- **Room codes and slots:** it hands out the codes. The host is slot 0; joiners take slots 1-3 in order. Slots are the players' identity everywhere (UDP peer index, relay address, lobby slot).
- **Endpoint exchange:** each game learns its public UDP address from Cloudflare's STUN server (`stun.cloudflare.com:3478`). The Worker sends everyone the roster (`peers`: slot, public and LAN address of every member) whenever someone joins, leaves or reports an address.
- **Direct connections:** every pair of players hole-punches a direct UDP path, so the match is a full mesh. Gameplay doesn't touch Cloudflare.
- **Relay fallback, per pair:** if punching to one player fails (symmetric or carrier-grade NAT), only the paths to that player go through the Worker, over the same WebSocket.
- **No player setup:** no accounts, no secrets, no port forwarding.

**Protocol versions.** Games send `v=2` in the WebSocket URL. A room is either v2 (up to 4 players) or v1 (older games, 2 players, `peer` message and verbatim relay), decided by its host. Mixed rooms are refused with a readable message ("This room needs a newer version of the game..." / "...hosted with an older version..."); a v2 game talking to an old server says the server is out of date. v1 and v2 games therefore keep working side by side in separate rooms, but only same-version games can start a match together (the game version is checked at Start).

**Relay framing.** A relayed game packet is a binary frame `[destination mask][payload]` (bit n = slot n, so one frame can fan out to several players); the Worker delivers `[source slot][payload]` to each. Relayed peers only get input every other frame, and their copies share one frame, to keep the per-message cost down (each message is a Durable Object event).

To deploy from `server/cloudflare`:

```bash
npm install
npx wrangler login
npm run deploy:dry-run
npm run deploy
```

| Command | Purpose |
|---|---|
| `npm run dev` | Local Worker on `ws://127.0.0.1:8799`. `scripts/netplay_lobbytest.ps1` starts it automatically. |
| `node test_room4.mjs` | Room protocol test (4 players, slots, roster, relay masks, v1 compatibility) against `npm run dev`. |
| `GET /health` | Returns `{"ok":true,"service":"smash-netplay","netplay":2,"maxPlayers":4}`. |

Release builds default to the deployed Worker. Override it at configure time with `-DSSB64_NETPLAY_SERVER="wss://..."`, or set it in the menu.

## How it works

| Piece | File |
|---|---|
| Lobby server (room codes, slots, roster, relay) | `server/cloudflare/src/index.js` |
| Lobby state machine (STUN, create/join, mesh hole punch, picks, START/GO/BEGIN) | `port/net/netlobby.cpp` |
| WebSocket client (WinHTTP, wss://, async send queue) | `port/net/port_ws.cpp` |
| UDP endpoint (Winsock/BSD, per-peer paths, relay hooks, network simulator) | `port/net/port_udp.cpp` |
| Player list in the menu and the Online window | `port/gui/OnlineStatus.cpp`, `port/gui/PortMenu.cpp` |
| Match transport, pacing, time sync, start barrier, desync check | `decomp/src/sys/netpeer.c` |
| Input delay, prediction, misprediction detection | `decomp/src/sys/netinput.c` |
| Snapshots, resimulation, shadow draws | `decomp/src/sys/netrollback.c`, `docs/rollback_design.md` |

**Connection sequence:**
1. The game binds one UDP socket and sends a STUN request to Cloudflare from it, which returns the socket's public (NAT-mapped) address.
2. It connects to `wss://.../ws?room=CODE&role=host|join&v=2` and gets `welcome {slot}`, then posts `{type:"endpoint", public, local}`.
3. Every `peers` roster update gives each game the addresses of the others. For every other player it sends `SSBL HELLO <slot>` to that player's public and LAN addresses. The first datagram heard from an address makes it that peer's direct path; a HELLO from an unknown address (a NAT that remapped the port) is accepted by its slot number.
4. After 3 seconds without a reply from one player, that pair sends `{type:"relay"}` and uses the WebSocket for that player only.
5. Everyone sends their fighter pick, game version and tap-jump setting to everyone (`SSBL PICK`, 4 times a second; the reply is a ping probe).
6. The host sends **START** (stage, rules, seed, delay, and each player's slot, fighter and costume in game-slot order) to the players that are connected and have picked. Each player answers **GO** once it can reach every other player in the match. When all GOs are in, the host sends **BEGIN** and everyone calls `syNetPeerStartOnlineMatch`. If a GO doesn't arrive within 10 seconds the host cancels the start (**ABORT**) and nobody has left the lobby.
7. In the battle, a host-driven start barrier aligns tick 0: everyone announces `BATTLE_READY` to everyone; once the host has all of them it sends `BATTLE_START`; players release on the host's START and acknowledge; the host releases when every player has acknowledged. A released player answers any READY it still hears with START, so a lost packet can't deadlock the barrier.

**Game slots.** The host plays slot 0, the others follow in lobby-slot order. Unused slots read neutral input. Players with the same fighter get different costumes. Each player's tap-jump setting (and the host's other rules) is carried in START.

**During the match:**
- Each player sends every other player one input packet per frame (the same bytes for everyone): its last 16 scheduled inputs, how many frames it runs ahead of each remote's confirmed input (the others' time sync), and the full-state hash of a recently confirmed tick.
- A tick is **confirmed** once every remote's input for it has arrived; rollback happens when any remote's real input differs from the prediction. A peer may run at most 6 ticks past the confirmed tick of its slowest remote, and time sync slows it down when it leads the peer it is furthest ahead of.
- A hash mismatch with any player is logged as `SSB64 Rollback: DESYNC detected ... (player N)` in `ssb64.log`.

## Testing

All test scripts launch the game with `SSB64_HIDDEN_WINDOW=1` (rendering, but no window is ever created visibly) and muted.

```powershell
# Two instances over localhost, env-configured (no lobby); fuzzed inputs, optional bad network.
.\scripts\netplay_localtest.ps1 -Seconds 60 -LatencyMs 60 -JitterMs 20 -LossPct 5

# Full flow: host + 1-3 clients joining by code, then a match (local wrangler dev, or the live Worker).
.\scripts\netplay_lobbytest.ps1 -Seconds 60 -LatencyMs 50 -LossPct 3                  # 2 players
.\scripts\netplay_lobbytest.ps1 -Players 4 -Seconds 90                                 # host + 3 clients
.\scripts\netplay_lobbytest.ps1 -Players 4 -LatencyMs 50 -JitterMs 20 -LossPct 5       # bad network
.\scripts\netplay_lobbytest.ps1 -Players 4 -ForceRelay                                 # everyone through the relay
.\scripts\netplay_lobbytest.ps1 -Players 4 -RelayPeer 2                                # only lobby slot 2's paths relayed
.\scripts\netplay_lobbytest.ps1 -Players 3 -MatchMinutes 1 -Rematches 1 -Seconds 190   # timed match + rematch
.\scripts\netplay_lobbytest.ps1 -Players 3 -RestartLast                                # a client leaves and rejoins before the start
.\scripts\netplay_lobbytest.ps1 -Server wss://smash-netplay.jumpcircuit.workers.dev   # (needs a v2 Worker)

# Rollback determinism without networking (7-frame rollback every tick).
.\scripts\rollback_synctest.ps1 -Stage 5 -Fighters "9,10,11,0" -Distance 7
```

Each script compares every peer's confirmed-state trace tick by tick. Exit code 0 means in sync. `wrangler dev` handles roughly 160 Durable Object messages per second on a typical dev machine, which is enough for the relay at 4 players only because relayed input is halved and multicast; the production Worker has far more headroom.

## Limitations

- **Players.** Two to four humans, free-for-all. There are no CPUs and no team battle online.
- **Drop-outs.** A player who disappears mid-match stalls everyone else (the Online window says who). Agreeing on a tick to drop them deterministically is not implemented.
- **Peer identity.** `SSBL HELLO` is not authenticated: a peer that guesses a slot number and room address can claim to be that slot's path. Players are expected to be friends who share a room code. A real fix needs per-slot tokens issued by the lobby server.
- **Lockstep moments.** The countdown, announcer and sudden-death intros run in lockstep: they wait for every other player's confirmed input instead of predicting. See "Not rollback-able yet" in `docs/rollback_design.md`.
- **Rematches.** The fighter and rules carry over; the host changes them by leaving and hosting again.
- **Audio.** Sounds started by a frame that later gets corrected still play once; rewound frames are silent.
- **Platforms.** The lobby's WebSocket client is Windows-only for now (WinHTTP); other platforms can still use env-configured direct netplay.
