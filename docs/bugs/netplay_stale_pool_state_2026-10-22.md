# Online sync hash read pool leftovers and per-PC counters (false desync)

Found while testing 3-player rooms in which one player leaves and rejoins before the start (`netplay_lobbytest.ps1 -RestartLast`): about every other run the host's `items` hash column differed from the others' at tick 0 and the in-band check logged `DESYNC detected`, with nothing else wrong in the match.

## Causes

1. **Pool slots keep their old bytes.** `itManagerGetNextStructAlloc` / `wpManagerGetNextStructAlloc` hand out an `ITStruct` / `WPStruct` from a free list without clearing it. The creation code only sets some fields (the ledge-catch box and last-frame masks of `coll_data`, the attack data of items that never attack, line ids, ...). The state hash reads all of them, so two PCs whose pool slots held different leftovers hashed differently. `SSB64_ARENA_POISON` on one peer reproduced it deterministically (`netplay_lobbytest.ps1 -ArenaPoison 90`): the first diverging fields were `coll_data.cliffcatch_coll`, then `mask_prev`/`mask_stat`, then the attack data.
2. **Hit-refresh counters from earlier scenes.** Stage items (the Peach's Castle bumper) are created before `ftManagerInitAll` sets `gFTManagerMotionCount` / `gFTManagerStatUpdateCount` to 1 and store the current value in their attack data (`motion_count`). Until then the counters hold whatever previous scenes on that PC left there, which differs between PCs with different histories (a long-lived host vs a freshly restarted client).

## Fix

- `itManagerGetNextStructAlloc` and `wpManagerGetNextStructAlloc` zero the struct they hand out (`#ifdef PORT`).
- `syNetPeerStartVSSession` resets both counters to their fresh-boot value (0) next to the existing item-manager resets, before the scene creates anything.

Offline play is unaffected: every field the game reads was already set by the creation code, and the counters are reinitialised before any fighter exists.

## Verification

`netplay_lobbytest.ps1 -Players 3 -RestartLast` failed roughly every other run before the fix and passed 4 of 4 after; `-ArenaPoison 90 -AddrJitter 4096` with 4 players is in sync; SyncTest still passes.
