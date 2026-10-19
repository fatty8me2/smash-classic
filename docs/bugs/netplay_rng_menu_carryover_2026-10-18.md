# Netplay: online matches out of sync from frame 0 (RNG advanced by menus)

**Status:** FIXED (decomp `netpeer.c`, `taskman.c`, `ftparam.c`, `wplinkboomerang.c`; port `netrules`, `FailedZCancelFlash.cpp`). Released in v1.6.0.

## Symptom

Every online match between two real PCs (Intel and AMD) showed "Out of sync" at tick 0, before any input. Two instances on one PC never desynced, including with different settings, different saves and shifted heap layouts.

## Diagnosis

v1.4 added a per-column sync exchange and a readable state dump at early ticks. Both players' dumps at tick 0 were identical except for the RNG seed (`rng=184235233` vs `1830433351`). The `items` column also differed, because `itManagerInitItems` draws from the RNG during scene setup. Every other column matched: fighters, stage, objman and battle.

So the RNG had already diverged before the battle scene's `func_start` ran.

## Root cause

`syNetPeerStartOnline` applied the agreed seed (`syNetPeerApplyBootstrapMetadata`) when the lobby started the match. It then requested the scene change with `portSCManagerRequestScene`, which takes effect at a frame boundary. Until that boundary, each player's current menu kept running, and menus draw from the game RNG through their animations. The two players sat on different screens, so the RNG advanced a different amount on each PC.

Local tests never caught it: both instances auto-start from the same screen, on the same frame.

## Fix

1. **Re-seed at battle-scene start.** `syNetPeerStartVSSession` runs first thing in `scVSBattleStartBattle`, before any setup that uses the RNG. It now re-applies the agreed seed and resets the seed pointer.
2. **Draws get a private RNG online.** In `syTaskmanRunTask` and `syTaskmanShadowDraw`, the scene draw runs with `sSYUtilsRandomSeedPtr` pointed at a scratch seed, reset to a constant before every draw. Purely visual settings can change what a draw does (HUD off, hitbox view, widescreen). With the game RNG, they would also change how far it advances.
3. **Hold frames restore the RNG.** On frames where the barrier or pacing holds a tick, the RNG is saved and then restored before the next tick. This is redundant with (2) and kept as a guard.
4. **Per-player settings that reach gameplay:**
   - **Widescreen projection in Link's boomerang off-screen check.** `func_ovl2_800EB924` scales the projected X by the window aspect. The boomerang now calls `ftParamProjectWorldToScreenGameplay`, which skips that scale during online matches.
   - **Failed-Z-cancel flash.** It starts a colanim from gameplay code (`ftCommonAttackAirProcMap`), so it is forced off in online matches (`port_netrules_active`).
   - **Audited and safe:**
     - Input remaps (analog remap, C-stick smash, D-pad jump) are baked into the local input before it is sent (`netinput.c` copies `gSYControllerDevices` after `syControllerUpdateGlobalData`).
     - HUD off and hitbox view only touch `*ProcDisplay` code.
     - Music shuffle and selection use the C library `rand()`, not the game RNG.
     - The clock-based `syUtilsRandTime*` is used only by menus.
     - Frame interpolation replays recorded DLs and never re-runs scene draws.
     - The camera aspect comes from the internal 320x240 viewport.

## Verification (`scripts/netplay_lobbytest.ps1`, live Cloudflare lobby)

| Run | Setup | Result |
|-----|-------|--------|
| 1 | `-PreRand 37 -NoReseed` (client burns 37 RNG calls before the battle loads, fix disabled) | DESYNC at tick 0, `rng` column. Reproduces the field bug. |
| 2 | `-PreRand 37` | In sync for 1298 ticks |
| 3 | `-PreRand 37 -HostDir <install with widescreen off, HUD off, hitbox view, flash, shuffle>`, Link vs Pikachu | In sync for 2798 ticks |
| 4 | Run 3 plus `-LatencyMs 70 -JitterMs 20 -LossPct 3` | 107 rollbacks, 389 resimulated ticks, in-band `desync=0`, 0 gameplay-column mismatches in 2078 ticks |

The test script now compares only the gated columns. The `input` column folds in predicted frames, so it legitimately differs once a rollback corrects a misprediction.

## Audit hook

Anything that runs between "seed agreed" and "first simulated tick" must either leave the RNG alone or happen after a re-seed. Two-instance tests on one machine start from identical menu state, so they cannot catch this class of bug. Use `SSB64_NETPLAY_PRE_RAND` to simulate it.
