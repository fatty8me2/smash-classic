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

If a player drops out mid-match (they quit, crash or lose their connection), the others keep playing. The lobby telling the room that they left, or 3 seconds without any data from them, starts a short agreement between the remaining players on the tick the player leaves (they wait for each other's reports, so this takes a fraction of a second on a good connection). From that tick the player's fighter is knocked out as if it had lost its last stock, the match goes on without them, and if only one player is left the match ends normally. The Online window says "Player N left". After the match the others can start a rematch, also when the host was the one who dropped (see Host migration).

## Host migration

The room belongs to the players, not to whoever created it. When the host leaves (quits, crashes, loses the connection) the Worker keeps the room open, promotes the **lowest remaining slot** to host, and tells everybody. Slot numbers never change, so relay addressing, UDP peer indexes and game slots keep working, and the room code stays valid.

- **Lobby / after a match.** The new host gets the Start match / Start rematch button and the stage and rules controls. It starts from the settings every peer already holds: the stage, stocks, items and input delay of the last match the room agreed on (each player adopts them from START), or its own menu choices if no match was started yet. Fighter picks are sent by every player to every player, so nothing is lost. The Online window and the Esc menu say "Player N is now the host" (or "You are now the host") for a few seconds; the player list marks the host.
- **Mid-match.** The match itself is handled by the drop mechanism (the host is knocked out like anyone else). The server's `host` message arrives in the middle of the match; when it ends, the new host runs the rematch.
- **During the start sequence (START / GO / BEGIN).** If the host leaves before BEGIN, every client that had accepted START drops back to the lobby ("A player left - waiting for the host") and the new host can start again. A GO only counts for the START that it answers (the seed is checked), so a stale GO cannot start a new match early. If the host leaves after BEGIN (everyone is loading the battle), the battle's start barrier, which the host normally runs, is taken over by the lowest remaining player, so nobody waits for a START that never comes; the host is then dropped at tick 0 (if some player never reaches the battle, the stand-in waits 15 s and then starts without it).
- **Joining.** Anyone can join with the same code; joiners take the lowest free slot, which can be slot 0 while the host is slot 1. A player who joins during a running match waits for the next one.
- **Last player.** One player alone in the room is its host and waits for others ("Room CODE - waiting for players to join"). The room is closed when it is empty.
- **Old games.** Games that predate migration treat slot 0 as the host. Games say `hm=1` in the WebSocket URL; the Worker only migrates when **every** member said so. Otherwise the room closes with its host as before (and survivors of an old game see "host-left"). An old game cannot join a room that has changed hosts ("This room changed hosts...").

## The lobby server (Cloudflare)

The server is `server/cloudflare`: a Cloudflare Worker plus one Durable Object per room. It follows the same pattern as the Jump Circuit relay.

**What it does:**
- **Room codes and slots:** it hands out the codes. The creator is slot 0 and the host; joiners take the lowest free slot. Slots are the players' identity everywhere (UDP peer index, relay address, lobby slot).
- **Endpoint exchange:** each game learns its public UDP address from Cloudflare's STUN server (`stun.cloudflare.com:3478`). The Worker sends everyone the roster (`peers`: slot, public and LAN address of every member) whenever someone joins, leaves or reports an address.
- **Direct connections:** every pair of players hole-punches a direct UDP path, so the match is a full mesh. Gameplay doesn't touch Cloudflare.
- **Relay fallback, per pair:** if punching to one player fails (symmetric or carrier-grade NAT), only the paths to that player go through the Worker, over the same WebSocket.
- **No player setup:** no accounts, no secrets, no port forwarding.

**Protocol versions.** Games send `v=2` in the WebSocket URL. A room is either v2 (up to 4 players) or v1 (older games, 2 players, `peer` message and verbatim relay), decided by its host. Mixed rooms are refused with a readable message ("This room needs a newer version of the game..." / "...hosted with an older version..."); a v2 game talking to an old server says the server is out of date. v1 and v2 games therefore keep working side by side in separate rooms, but only same-version games can start a match together (the game version is checked at Start).

**Host migration messages.** `welcome` and every `peers` roster carry `host` (the leading slot); on a change the Worker sends `peer_left` for the old host, then `{type:"host", slot, prev}`, then the roster. The host slot is stored in the Durable Object, so it survives hibernation. Joins and closes are handled synchronously, so two near-simultaneous closes or a join during a promotion still end with exactly one host. v1 (legacy) rooms are unchanged: they close with their host.

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
| `node test_hostmig.mjs [ws://...]` | Host migration: promotion order, roster/host messages, relay and joins after a migration, second migration, hibernation, empty room, non-migrating rooms (old games, v1), races. `--no-hibernate` skips the 15 s idle wait. |
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
2. It connects to `wss://.../ws?room=CODE&role=host|join&v=2&hm=1` and gets `welcome {slot, host}`, then posts `{type:"endpoint", public, local}`.
3. Every `peers` roster update gives each game the addresses of the others. For every other player it sends `SSBL HELLO <slot>` to that player's public and LAN addresses. The first datagram heard from an address makes it that peer's direct path; a HELLO from an unknown address (a NAT that remapped the port) is accepted by its slot number.
4. After 3 seconds without a reply from one player, that pair sends `{type:"relay"}` and uses the WebSocket for that player only.
5. Everyone sends their fighter pick, game version and tap-jump setting to everyone (`SSBL PICK`, 4 times a second; the reply is a ping probe).
6. The host (`host_slot`; see Host migration) sends **START** (stage, rules, seed, delay, and each player's slot, fighter and costume in game-slot order) to the players that are connected and have picked. Each player answers **GO** once it can reach every other player in the match. When all GOs are in, the host sends **BEGIN** and everyone calls `syNetPeerStartOnlineMatch`. If a GO doesn't arrive within 10 seconds the host cancels the start (**ABORT**) and nobody has left the lobby.
7. In the battle, a host-driven start barrier aligns tick 0: everyone announces `BATTLE_READY` to everyone; once the host has all of them it sends `BATTLE_START`; players release on the host's START and acknowledge; the host releases when every player has acknowledged. A released player answers any READY it still hears with START, so a lost packet can't deadlock the barrier.

**Game slots.** The host plays slot 0, the others follow in lobby-slot order. Unused slots read neutral input. Players with the same fighter get different costumes. Each player's tap-jump setting (and the host's other rules) is carried in START.

**During the match:**
- Each player sends every other player one input packet per frame (the same bytes for everyone): its last 16 scheduled inputs, how many frames it runs ahead of each remote's confirmed input (the others' time sync), and the full-state hash of a recently confirmed tick.
- A tick is **confirmed** once every remote's input for it has arrived; rollback happens when any remote's real input differs from the prediction. A peer may run at most 6 ticks past the confirmed tick of its slowest remote, and time sync slows it down when it leads the peer it is furthest ahead of.
- A player who dropped out is removed from all of this from the agreed tick: their input is neutral and confirmed, and they no longer take part in pacing, time sync or the hash check. The agreement uses a separate control packet (`SSNP` type 6: report, decide, ack, request, forward), sent to the remaining players only.
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
.\scripts\netplay_lobbytest.ps1 -Players 4 -Seconds 90 -Kill "2@40"                 # kill one peer mid-match (use "0@40" for the host, "3@35,1@55" for two)
.\scripts\netplay_lobbytest.ps1 -Players 3 -Seconds 80 -Kill "2@35" -Suspend         # freeze it instead (only the silence detects it)
.\scripts\netplay_lobbytest.ps1 -Players 3 -Seconds 130 -Kill "0@30" -Migrate -MigratePlayers 2 -Rematches 1 -ExpectMatches 2   # host leaves mid-match, survivors rematch under the new host
.\scripts\netplay_lobbytest.ps1 -Players 4 -Seconds 90 -Kill "0@8" -StartDelayMs 15000 -Migrate -MigratePlayers 3         # host leaves in the lobby, the new host starts
.\scripts\netplay_lobbytest.ps1 -Players 3 -Seconds 70 -HostDie start -Migrate -MigratePlayers 2                          # host dies right after START (-HostDie begin: right after BEGIN; begin1 / begin2: BEGIN reaches only the first / all but the first player)
.\scripts\netplay_lobbytest.ps1 -Players 4 -Seconds 110 -Kill "0@8" -LateLast 14 -StartDelayMs 20000 -Migrate -MigratePlayers 3   # a new player joins the migrated room (takes slot 0)
.\scripts\netplay_lobbytest.ps1 -Server wss://smash-netplay.jumpcircuit.workers.dev   # (needs a v2 Worker)

# Rollback determinism without networking (7-frame rollback every tick).
.\scripts\rollback_synctest.ps1 -Stage 5 -Fighters "9,10,11,0" -Distance 7
```

Each script compares every peer's confirmed-state trace tick by tick. Exit code 0 means in sync. `wrangler dev` handles roughly 160 Durable Object messages per second on a typical dev machine, which is enough for the relay at 4 players only because relayed input is halved and multicast; the production Worker has far more headroom.

## Limitations

- **Players.** Two to four humans, free-for-all. There are no CPUs and no team battle online.
- **Drop-outs.** A player who leaves is knocked out and the others continue (`docs/bugs/netplay_mid_match_drop_2026-10-22.md`). If the host drops, the next player takes over (Host migration), so the room, the rematch and the relay path all survive. Open edges: a link failure that only one survivor sees drops that player for everyone (there is no vote). A returning player cannot rejoin a running match.
- **Peer identity.** `SSBL HELLO` is not authenticated: a peer that guesses a slot number and room address can claim to be that slot's path. Players are expected to be friends who share a room code. A real fix needs per-slot tokens issued by the lobby server.
- **Lockstep moments.** The countdown, announcer and sudden-death intros run in lockstep: they wait for every other player's confirmed input instead of predicting. See "Not rollback-able yet" in `docs/rollback_design.md`.
- **Rematches.** The fighter, stage and rules carry over; the host can change the stage and rules in the Online window or the Esc menu before pressing Start rematch.
- **Host migration.** Needs the updated Worker and the updated game on every player (`hm=1`); with an older game in the room the room still closes with its host. If the host dies while its BEGIN has reached only some players, those start the battle, the stand-in barrier waits 15 s for the others and then goes on without them, and a player who missed BEGIN stays in the lobby, hears nothing from the new host (who is in the battle) and leaves with "Lost connection to the host"; the room is still open, so it rejoins with the same code. The new host's gameplay rules (auto Z-cancel, comp ruleset, neutral spawns, hazards) come from its own settings.
- **Audio.** Sounds started by a frame that later gets corrected still play once; rewound frames are silent.
- **Platforms.** The lobby's WebSocket client is Windows-only for now (WinHTTP); other platforms can still use env-configured direct netplay.
