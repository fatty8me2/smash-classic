# Online match froze for everyone when one player dropped (2026-10-22)

## Symptom

In a 2-4 player online match, as soon as one player quit, crashed or lost their connection, every other game stopped at "Waiting for Player N..." and never resumed. Nothing in the lobby or the netcode removed the missing player: the lobby only cleared the transport (`peer_gone`), while the rollback core waited for that player's input forever.

## Root cause

A tick is simulated only while it is at most `SYNETPEER_MAX_PREDICTION` (6) ticks past the **confirmed tick**, the minimum over all remotes of their next unconfirmed input. A remote that goes silent holds the confirmed tick fixed, so every peer stalls within six ticks. `syNetPeerGetSilentPlayer` only fed the UI. There was no notion of a player leaving the match.

The fix is not as simple as "stop waiting for them": in a full mesh the survivors hold different amounts of the leaver's input (the last packets reach some peers and not others), and a peer may already have simulated or confirmed ticks that used it. All survivors must treat the leaver identically from one common tick, or they diverge.

## Design

Per dropped player ("subject"), the survivors agree on a **drop tick T**:

1. **Suspect.** A survivor suspects a player when the lobby reports it left the room (`peer_left`, fast), when nothing arrived from it for 3 s (`SYNETPEER_DROP_SILENCE_MS`, covers hangs and dead links), or when another survivor says so (suspicion spreads, so a player one peer lost is dropped for everybody). It freezes **R = how many of the subject's inputs it holds contiguously from tick 0** and sends `REPORT{subject, R}` to every survivor (repeated every 12 frames until the drop is decided).
2. **Decide.** The coordinator is the lowest slot that is still a survivor (so the host dropping is fine). When it has every survivor's report it picks `T = max(R)` and broadcasts `DECIDE{subject, T}`. A survivor that already knows a `T` includes it in its report, so a new coordinator after a dying one reuses it instead of choosing a second value. Every survivor repeats `DECIDE` to the survivors that have not acknowledged it (`ACK`), and answers a late `REPORT` with `DECIDE`; any one survivor knowing `T` is enough for the rest.
3. **Fill.** A survivor holding less than `T` of the subject's input asks (`REQUEST{subject, from, T}`) and any survivor that has those ticks answers with `FORWARD` (8 genuine inputs per packet). `max(R)` guarantees at least one survivor holds everything below `T`.
4. **Effect from T.**
   - `netinput.c`: from tick `T` the subject's input is neutral and always confirmed (`syNetInputSetDropTick`). Late inputs at or after `T` are ignored. Once its input below `T` is complete, its next-unconfirmed tick becomes infinite, so the confirmed tick = the minimum over the remaining remotes only.
   - `netpeer.c`: the subject no longer receives or sends traffic and no longer takes part in pacing, time sync or the hash exchange. If nobody is left, pacing stops capping.
   - `netrollback.c`: `syNetRollbackRunTick` (every simulated tick, first run or resimulated) calls `syNetPeerApplyDrops(tick)`. From `T`, once the match is in the Go state, the dropped fighter gets its stocks set to 0 and enters `ftCommonDeadDownSetStatus`, i.e. it dies for the last time: places, the announcer and the results screen are the stock-out path unchanged. If it was the last opponent, the match ends normally ("GAME!", results). For timed matches (test only) the fighter is put to sleep. The knock-out depends only on the tick and on game state, so a peer that learns `T` late rolls back to `T` and replays it identically.
5. **Why T is always reachable by rollback.** A survivor never simulates more than 6 ticks past the contiguous input it holds of any remote, so its newest tick is at most `R+5`, and `T >= R`: rolling back to `T` stays inside the 8-slot snapshot ring.

Two drops are two independent agreements (a suspect is not a survivor of the other). Messages are idempotent and survive loss.

UI: while the survivors are still agreeing, the Online window says `Player N left - the match continues without them...`, then `Player N left the match` for 8 s. A player who was dropped while still alive (a link problem only one survivor saw) gets `The other players dropped you from the match.`.

Lobby: after the match the dropped player is simply absent from the room, so the rest can start a rematch. If the **host** dropped, the room is gone: the server closes the room when slot 0 leaves, so the survivors finish the match but cannot rematch.

Not changed: `server/cloudflare` (`peer_left` already reaches everyone and is used as the fast signal; v1 rooms are untouched).

## Files

- `decomp/src/sys/netinput.{c,h}`: drop tick, neutral input, `syNetInputGetRemoteConfirmedFrame`.
- `decomp/src/sys/netpeer.{c,h}`: detection, agreement (new `SYNETPEER_PACKET_DROP`, 92 bytes), forwarding, knock-out, UI queries.
- `decomp/src/sys/netrollback.c`: `syNetRollbackRunTick`.
- `port/net/netlobby.cpp`: `peer_gone` mid-match tells the game; after a match without the host the client says so.
- `port/gui/OnlineStatus.cpp`: the notices.
- `scripts/netplay_lobbytest.ps1`: `-Kill "slot@seconds,..."`, `-Suspend`, `-MinPostDrop`.

## Verification

All runs hidden and muted, against a local `wrangler dev`. "Compared" = confirmed-state trace lines (tick + 8 gated hash columns) that were identical across the survivors; the killed player's trace is checked against the survivors' up to where it stopped, and every survivor must have logged the same drop tick.

| Run | Compared (survivors) | Drop tick(s) | Desyncs |
|---|---|---|---|
| 3 players, kill client 2 | 2453 | 1727 | 0 |
| 4 players, kill client 1, latency 60 / jitter 20 / loss 5% | 3304 | 1516 | 0 |
| 3 players, kill the host | 3364 | 1692 | 0 |
| 4 players, kill the host, 60/20/5% | 3749 | 1188 | 0 |
| 2 players, kill the client (survivor's match ends: GAME!, results, lobby) | 2061 | 1966 | 0 |
| 4 players, two drops (35 s, 55 s), 40/15/3% | 3263 | 1145, 2319 | 0 |
| 4 players, two drops at the same second, 40/10/3% | 3362 | 1554, 1554 | 0 |
| 3 players, frozen process (lobby socket open: silence detection only) | 2453 | 1987 | 0 |
| 3 players, timed match, kill, then rematch of the survivors | 8174 (two matches) | 1280 | 0 |

Regressions: `rollback_synctest.ps1 -Stage 5 -Fighters "9,10,11,0" -Distance 7` PASS (3481 ticks tested, failed=0); 4-player clean run with 50 ms / 20 / 5% in sync for 3304 ticks, no `SSB64 Drop` line (no false positives); `netplay_localtest.ps1` in sync for 2101 ticks.

## Open

- A survivor that is the only holder of the missing part of the subject's input and dies before forwarding it leaves another survivor waiting (rare double fault).
- An asymmetric link failure (A cannot hear B, everyone else can) drops B for all, by design; there is no vote.
- Relay-only survivors lose their path when the host drops (the server closes the room).
- No host migration: no rematch after the host dropped.

## Review hardening (same day)

- **Only the coordinator decides.** The coordinator is the lowest match slot that is not itself being dropped. DECIDE is believed from that slot or a lower one only; a REPORT can no longer decide (it only records, and carries the tick a survivor already knows so a new coordinator reuses it). Non-coordinators acknowledge (ACK to all) and, while someone has not, tell them the tick they know.
- **Plausibility.** A DECIDE tick older than the snapshot ring (`now - 7`), further ahead than 600 ticks, or below what we hold of the player is not usable: the match is ended cleanly (menu Reset path, note shown in the lobby: "Lost sync with the other players"). A second, different tick for the same player (CONFLICT) ends the match the same way. A failed rollback while a drop is in progress does too.
- **Frozen reports.** From the moment a player is suspected, its input at or beyond the frozen report is not taken (`syNetInputSetFreezeTick`), so how far we may simulate stays at report+5; T is the maximum over every REPORT received (also from peers we doubt). The freeze lifts when the tick is agreed, so FORWARDed input below T is accepted.
- **REQUEST** is served only for a decided drop with `to == drop tick`, and the scan is bounded.
- **Dropped but alive.** A player told by the coordinator that it was dropped (the notice is repeated for as long as the drop lasts) leaves the match: "You were disconnected from the match".
- **Lobby.** Mid-match, a roster that merely omits a peer no longer counts as it leaving; only the server's `peer_left` does.
- **FORWARD** is first-write-wins like normal input packets: a peer that can send a wrong forwarded input can equally send wrong normal input (same trust; peers are not authenticated, see Limitations). Accusations are trusted the same way.
- **Trace.** Sudden death restarts the rollback session in the middle of a match; the confirmed trace restarted at tick 0 and wrote `N missing` placeholder lines for ticks 0..T-1, which the comparator counted as in sync. The trace now continues at the current tick (`syNetRollbackContinueTraceAt`), and `netplay_lobbytest.ps1` exits 2 if any compared trace contains a `missing` line. (My earlier 8174-tick rematch figure was a match without sudden death and unaffected.)
- Test knobs: `SSB64_NETPLAY_TEST_FORGE=<slot>` (that peer sends a bogus DECIDE/REQUEST/FORWARD once), `SSB64_NETPLAY_TEST_SUSPECT_DELAY=<slot>:<ms>` (that peer notices drops late), script `-Suspend -ResumeAfter`.
