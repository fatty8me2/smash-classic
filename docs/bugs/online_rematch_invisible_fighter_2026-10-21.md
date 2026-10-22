# Netplay: client's fighter invisible after host starts a rematch

**Status:** PARKED. Not reproduced by the automated test yet. Gameplay is in sync, so the cause is on the render side.

## Symptom

Online, after the host starts a rematch from the results screen, the client's own fighter (Kirby in the failing case) renders invisible or distorted on the client only. The host sees its fighter correctly. Gameplay state matches on both sides: the confirmed-state hashes agree, so the simulation is not desynced. Only the client's drawing is wrong.

## Hypothesis

When START arrives, the client is still on the VS results screen (scene 24). It then jumps straight from results to `VSBattle` instead of going through the normal menu path. State that the results screen set up may leak into the new battle, for example:

- `sMNVSResultsFigatreeHeaps`, the results-screen figatree heaps.
- The Kirby copy-hat state.
- Relocation caches that were filled while the results scene was active.

The host does not show this because its results screen is already unloaded by the time it starts the next match. This is a guess, not yet confirmed.

## What was tried

- An automated rematch test with screenshots (`scripts/netplay_lobbytest.ps1 -Rematches`) did not reproduce the bug.
- In the runs that were captured, the START message arrived about 3 seconds into the results screen. The client's delay before leaving results was therefore not what the test exercised.

## How to reproduce next time

The host's auto-rematch delay is now configurable. `SSB64_LOBBY_REMATCH_DELAY_MS` sets it, defaulting to 4000 ms. `scripts/netplay_lobbytest.ps1` exposes it as `-RematchDelayMs`.

Sweep the delay so START arrives at different points in the results screen, and capture client screenshots each time:

```
.\scripts\netplay_lobbytest.ps1 -ClientFighter 8 -Rematches 2 -RematchDelayMs 0
.\scripts\netplay_lobbytest.ps1 -ClientFighter 8 -Rematches 2 -RematchDelayMs 500
.\scripts\netplay_lobbytest.ps1 -ClientFighter 8 -Rematches 2 -RematchDelayMs 1500
.\scripts\netplay_lobbytest.ps1 -ClientFighter 8 -Rematches 2 -RematchDelayMs 3000
```

`-ClientFighter 8` selects Kirby. Add `-ClientShots <frame list>` to capture the client's frames after each rematch, and check the screenshots for an invisible or distorted fighter. The output lands under `build\us\lobby-test`.

Run the sweep with the test muted (`SSB64_MUTE=1`) and headless, as usual.

## Next steps if it reproduces

1. Find the delay at which the fault appears.
2. Log whether the results scene is still loaded when the battle scene starts.
3. Check whether the listed results-screen state is reset before `VSBattle` loads.
