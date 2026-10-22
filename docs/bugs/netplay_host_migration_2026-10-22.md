# Online room closed when the host left (2026-10-22)

## Symptom

After the mid-match drop fix (`netplay_mid_match_drop_2026-10-22.md`) the survivors of a match could finish it when the host (lobby slot 0) dropped, but the room was gone: the Worker closed every socket with `4001 host-left` when slot 0's socket closed. Nobody could start a rematch, change the stage or let a new player join, and survivors that only reached each other through the relay lost that path (the relay is the WebSocket).

## Design

The host is a property of the room, not of slot 0.

**Server (`server/cloudflare/src/index.js`).**
- The room stores `hostSlot` (Durable Object storage key `host`, loaded in the constructor, so it survives hibernation). It is 0 for a fresh room.
- Slots stay stable, so relay masks, UDP peer indexes and game slots keep their meaning. A joiner takes the lowest free slot, slot 0 included.
- When the host's socket closes (v2 rooms): if the room is empty it is gone; otherwise the lowest remaining slot becomes host. All in-memory state changes happen before the first `await`, so a second close or a join arriving meanwhile sees exactly one host. The Worker sends `peer_left` (old host), `{type:"host", slot, prev}`, then the roster; `welcome` and every `peers` roster also carry `host`, so a late joiner or a missed message cannot disagree.
- Compatibility: clients say `hm=1` in the WebSocket URL (stored as a socket tag). The Worker migrates only when every remaining member said so; with an older game in the room it closes the room with its host as before (nothing changes for old games), and a game without `hm=1` cannot join a room that already changed hosts. v1 (legacy) rooms are untouched.
- `/health` reports `hostMigration: 1`.

**Client lobby (`port/net/netlobby.cpp`).**
- `is_host` is now `host_slot == my_slot` (`want_host` is only the connection role). Everything that addressed "slot 0" uses `host_slot`: START/BEGIN/ABORT are accepted from the host slot, GO goes to it, the link-lost failures apply to it.
- `peer_left` for the host starts an *election* (`host_slot = -1`); the server's `host` message ends it (a 10 s timeout fails with "The host left the room", and an old server that closes the socket gives "The host closed the room").
- Becoming host: the new host starts from the last settings every peer holds. Each client adopts stage / stocks / items / delay from the START it accepted; a host that never saw a START uses its own menu choices (`gNetplay.*`). A start the previous host had begun is void (clients that accepted START already dropped back to the lobby when the host's `peer_left` arrived), and `p.go` flags are cleared. A GO now only counts when its seed equals the current START's seed. The player who finds itself alone in the room goes back to "waiting for players to join".
- A `host_notice` ("Player N is now the host" / "You are now the host") is shown for 10 s in the Online window and the Esc menu status. The Esc menu lets the player who leads the room edit stage, stocks, items and delay before pressing Start (`port_netlobby_set_options`).
- Mid-match nothing changes in the lobby but the host slot; the drop mechanism handles the match and, at the results, the new host runs the rematch (the old "The host left the room" failure after a match is gone).

**Game (`decomp/src/sys/netpeer.c`).** The battle start barrier is run by the match host. If the host's leave notice arrives before the barrier is released, the lowest remaining player takes over as barrier master (`syNetPeerIsBarrierMaster`), and a START from any player is accepted as the release signal once the host is gone; otherwise everyone would wait forever for a START that never comes. A stand-in master that has waited 900 frames for a player's READY (that player missed the host's BEGIN and sits in the lobby) treats it as gone and starts without it.

## Why this shape

- Promoting the lowest slot needs no election messages: the Worker is the only authority, and it already serialises joins and leaves.
- Keeping slot numbers stable avoids re-addressing the mesh; the alternative (renumbering so the host is always slot 0) would break the relay masks, UDP peer indexes and the drop agreement mid-match.
- The migration is announced inside the existing roster messages, so a client that misses the dedicated `host` message still converges.
- Gating on `hm=1` means old games are never put in a room where "slot 0" is not the host.

## Verification

All runs hidden and muted against a local `wrangler dev`; "compared" = confirmed-state trace lines (tick + 8 gated hashes) identical across the survivors, plus the killed player's trace up to where it stopped; every survivor logged the same drop ticks.

| Run | Compared | Drop tick(s) | Desyncs |
|---|---|---|---|
| (a) 3 players, kill host mid-match (30 s); survivors rematch under the new host (2 matches each) | 4941 | 1347 | 0 |
| (b) 4 players, kill host in the lobby; new host starts | 2705 (3 players) | none | 0 |
| (c) 3 players, host dies right after its first START; clean abort, new host starts | 2488 | none | 0 |
| (c) 3 players, host dies right after sending BEGIN (stand-in barrier master) | 2767 | host dropped at tick 2 | 0 |
| (c) 3 players, host dies after BEGIN reached only one player | no hang: the stand-in gave up on the missing player after 901 frames, the match ended, the room reopened | 2 | n/a |
| (d) 4 players, host leaves (30 s), then the new host leaves (50 s), 40 ms / 15 / 3% loss, then a rematch | 7806 | 1181, 2367 | 0 |
| (e) 3 players, relay forced for every path, kill host, rematch | 4941 | 1574 | 0 |
| 4 players, host leaves in the lobby, a new player joins with the code (takes slot 0) and plays | 4348 (3 players) | none | 0 |
| 2 players, kill host (lone survivor ends cleanly, room waits for players) | 1772 | 1677 | 0 |
| 4 players, no kill, 50 ms / 20 / 5% | 3304 | none | 0 |
| 3 players, kill host against the old Worker (no migration) | 2453 | 1664 | 0 (survivors fail with "host-left" after the match, as before) |

Server: `node test_hostmig.mjs` (promotion order, roster/host messages, relay between survivors, joiner takes slot 0, second migration, migration after a 15 s idle, empty room, old-game and v1 rooms still close, five rounds of simultaneous closes with a joiner arriving) and the existing `test_room4.mjs` / `test_relay.mjs` all pass. `rollback_synctest.ps1 -Stage 5 -Fighters "9,10,11,0" -Distance 7`: 3481 ticks, failed=0. `netplay_localtest.ps1` (60 ms / 20 / 5%): in sync for 3001 ticks.

Test knobs: `SSB64_LOBBY_TEST_DIE=start|begin|begin1` (the room creator kills itself right after its first START / after BEGIN / after BEGIN to the first player only), `SSB64_LOBBY_MIGRATE_PLAYERS`; script switches `-Migrate -MigratePlayers -HostDie -LateLast -ExpectMatches`.

## Deployment

The Worker must be deployed **before** (or together with) the client release: a new client talking to the old Worker works exactly as v1.11.1 did (no `host` field means slot 0 leads; the host leaving closes the room). Old clients with the new Worker also keep working: they do not say `hm=1`, so rooms they are in close with their host as before; they cannot join a room that has already changed hosts.

## Open

- A host that dies while its BEGIN reached only some players: the others start without the missing one (after ~15 s), and the player who missed BEGIN leaves with "Lost connection to the host" (it can rejoin with the same code).
- A player who joins during a running match into a slot freed by a dropped player (slot 0 after a host drop included) is not part of that match; the lobby already handled this for non-host slots.
- The new host's gameplay rules (auto Z-cancel, comp ruleset, neutral spawns, hazards) come from its own settings, like any host's.
- RetroHub's own lobby (the hub room that starts the game) is separate and unchanged; it passes `SSB64_LOBBY_HOST` / `SSB64_LOBBY_JOIN` and the code, which still work.
