# End-to-end online test against the Cloudflare lobby (server/cloudflare):
# a host creates a room and 1-3 clients join it by code. They hole-punch (a
# full mesh), pick fighters, start a rollback match with fuzzed inputs, and
# every peer's confirmed-state trace is compared with the host's.
# -LatencyMs/-LossPct simulate a bad network on the game traffic (the lobby
# handshake uses the same socket).
#
#   .\scripts\netplay_lobbytest.ps1 -Seconds 60                  # 2 players
#   .\scripts\netplay_lobbytest.ps1 -Players 4 -Seconds 90       # host + 3 clients
#   .\scripts\netplay_lobbytest.ps1 -Players 3 -LatencyMs 60 -LossPct 3
#   .\scripts\netplay_lobbytest.ps1 -Server wss://smash-netplay.jumpcircuit.workers.dev
#
# Without -Server it uses `wrangler dev` on ws://127.0.0.1:8799, starting it
# if nothing answers there. Every instance runs with SSB64_HIDDEN_WINDOW=1
# (rendering, but no window is ever shown) and muted.
#
# Exit code: 0 in sync, 1 desync, 2 no match / no trace.
param(
    [int]$Seconds = 60,
    [int]$Players = 2,          # 2-4 (host included)
    [int]$LatencyMs = 0,
    [int]$JitterMs = 0,
    [int]$LossPct = 0,
    [string]$Server = "",
    [int]$HostFighter = 0,
    [int]$ClientFighter = 1,    # first client; further clients use the next fighter ids
    [int]$Stage = 0,
    [switch]$ForceRelay,
    [int]$RelayPeer = -1,       # lobby slot whose paths all go through the relay (others stay direct)
    [string]$BuildDir = "$PSScriptRoot\..\build\us\Release",
    [int]$Rematches = 0,        # host starts this many rematches after the first match
    [int]$RematchDelayMs = 4000, # delay before each host rematch (SSB64_LOBBY_REMATCH_DELAY_MS)
    [string]$ClientShots = "",  # first client SSB64_SCREENSHOT_FRAMES list (saved under the out dir)
    [int]$PreRand = 0,          # last client burns this many RNG calls before the battle loads
    [switch]$NoReseed,          # disable the stage-load reseed (to reproduce the bug)
    [int]$ExtraHold = 0,        # last client holds this many extra frames at match start
    [switch]$NoRandRestore,     # disable the hold RNG fix (to reproduce the bug)
    [int]$ArenaPoison = 0,      # last client fills each scene arena with this byte (uninitialized-read probe)
    [int]$AddrJitter = 0,      # last client shifts its heap layout like a different PC would
    [string]$HostDir = "",      # run the host from another install (its own cfg + save)
    [int]$MinTicks = 0,         # fail (exit 2) when fewer ticks than this were compared
    [int]$StartDelayMs = 0,     # host waits this long after everyone is connected (SSB64_LOBBY_START_DELAY_MS)
    [switch]$RestartLast,       # kill the last client once everyone is connected and start it again (leave + rejoin before the match)
    [int]$MatchMinutes = 0,     # timed match of this many minutes (SSB64_NETPLAY_TEST_MINUTES) so it ends by itself
    [string]$OutDir = "$PSScriptRoot\..\build\us\lobby-test"
)

if ($Players -lt 2 -or $Players -gt 4) { Write-Output "-Players must be 2-4"; exit 2 }
$build = Resolve-Path $BuildDir
New-Item -ItemType Directory -Force $OutDir | Out-Null
$out = Resolve-Path $OutDir
Remove-Item "$out\*" -Recurse -ErrorAction SilentlyContinue

$wrangler = $null
if (-not $Server) {
    $Server = "ws://127.0.0.1:8799"
    $up = $false
    try { $up = (Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:8799/health" -TimeoutSec 3).StatusCode -eq 200 } catch {}
    if (-not $up) {
        $wrangler = Start-Process -FilePath "cmd.exe" -ArgumentList "/c npx wrangler dev --port 8799 --ip 127.0.0.1" `
            -WorkingDirectory "$PSScriptRoot\..\server\cloudflare" -RedirectStandardOutput "$out\server.log" `
            -RedirectStandardError "$out\server.err" -PassThru -WindowStyle Hidden
        for ($i = 0; $i -lt 30 -and -not $up; $i++) {
            Start-Sleep -Seconds 1
            try { $up = (Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:8799/health" -TimeoutSec 2).StatusCode -eq 200 } catch {}
        }
        if (-not $up) { Write-Output "wrangler dev did not start"; exit 2 }
    }
}
Write-Output "lobby server: $Server  players: $Players"

$names = @('host', 'client', 'client2', 'client3')
$fighters = @($HostFighter)
for ($i = 1; $i -lt $Players; $i++) { $fighters += (($ClientFighter + $i - 1) % 12) }

function Start-Peer([int]$index) {
    $role = $names[$index]
    $isLast = ($index -eq ($Players - 1))
    $vars = @{
        SSB64_LOBBY_CODE_FILE = "$out\code.txt"; SSB64_LOBBY_FKIND = "$($fighters[$index])"; SSB64_LOBBY_STAGE = "$Stage"
        SSB64_LOBBY_PLAYERS = "$Players"
        SSB64_LOBBY_START_DELAY_MS = $(if ($RestartLast -and -not $StartDelayMs) { "22000" } elseif ($StartDelayMs) { "$StartDelayMs" } else { "" })
        SSB64_NETPLAY_FUZZ = "$(111 * ($index + 1))"; SSB64_MUTE = '1'; SSB64_NO_UPDATE_CHECK = '1'; SSB64_HIDDEN_WINDOW = '1'
        SSB64_NETPLAY_TEST_MINUTES = $(if ($MatchMinutes) { "$MatchMinutes" } else { "" })
        SSB64_NETPLAY_SIM_LATENCY_MS = "$LatencyMs"; SSB64_NETPLAY_SIM_JITTER_MS = "$JitterMs"
        SSB64_NETPLAY_SIM_LOSS_PCT = "$LossPct"; SSB64_NETPLAY_SIM_SEED = "$(111 * ($index + 1))"
        SSB64_NETPLAY_CONFIRMED_TRACE = "$out\$role.trace"; SSB64_LOG_PATH = "$out\$role.log"
        SSB64_LOBBY_FORCE_RELAY = $(if ($ForceRelay) { "1" } else { "" })
        SSB64_LOBBY_RELAY_PEER = $(if ($RelayPeer -ge 0 -and $index -ne $RelayPeer) { "$RelayPeer" } else { "" })
    }
    if ($RelayPeer -ge 0 -and $index -eq $RelayPeer) { $vars['SSB64_LOBBY_FORCE_RELAY'] = "1" }
    if ($index -eq 0) {
        $vars['SSB64_LOBBY_HOST'] = $Server; $vars['SSB64_LOBBY_AUTOSTART'] = '1'
        if ($Rematches) { $vars['SSB64_LOBBY_AUTOREMATCH'] = "$Rematches"; $vars['SSB64_LOBBY_REMATCH_DELAY_MS'] = "$RematchDelayMs" }
    } else {
        $vars['SSB64_LOBBY_JOIN'] = $Server
        if ($index -eq 1 -and $ClientShots) { $vars['SSB64_SCREENSHOT_FRAMES'] = $ClientShots; $vars['SSB64_SCREENSHOT_DIR'] = "$out\client_shots" }
    }
    if ($isLast -and $index -ne 0) {
        if ($AddrJitter) { $vars['SSB64_ADDR_JITTER'] = "$AddrJitter" }
        if ($PreRand) { $vars['SSB64_NETPLAY_PRE_RAND'] = "$PreRand" }
        if ($NoReseed) { $vars['SSB64_NETPLAY_NO_RESEED'] = "1" }
        if ($ExtraHold) { $vars['SSB64_NETPLAY_EXTRA_HOLD'] = "$ExtraHold" }
        if ($NoRandRestore) { $vars['SSB64_NETPLAY_NO_RAND_RESTORE'] = "1" }
        if ($ArenaPoison) { $vars['SSB64_ARENA_POISON'] = "$ArenaPoison" }
    }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $own = ($index -eq 0 -and $HostDir)
    $dir = $(if ($own) { $HostDir } else { $build })
    if (-not $own) { $vars['SSB64_SAVE_PATH'] = "$out\$role.sav" }
    $psi.FileName = Join-Path $dir 'BattleShip.exe'
    $psi.WorkingDirectory = $dir
    $psi.UseShellExecute = $false
    foreach ($k in $vars.Keys) { $psi.EnvironmentVariables[$k] = $vars[$k] }
    return [System.Diagnostics.Process]::Start($psi)
}

$procs = @()
$procs += Start-Peer 0
Start-Sleep -Seconds 2
for ($i = 1; $i -lt $Players; $i++) {
    $procs += Start-Peer $i
    Start-Sleep -Seconds 1
}
if ($RestartLast -and $Players -ge 3) {
    Start-Sleep -Seconds 12
    $last = $procs[$Players - 1]
    Write-Output "restarting client $($Players - 1) (pid $($last.Id))"
    Stop-Process -Id $last.Id -Force
    Start-Sleep -Seconds 3
    $procs[$Players - 1] = Start-Peer ($Players - 1)
    Start-Sleep -Seconds ($Seconds - 15)
} else {
    Start-Sleep -Seconds $Seconds
}
foreach ($p in $procs) { if (-not $p.HasExited) { $p.CloseMainWindow() | Out-Null } }
Start-Sleep -Seconds 3
foreach ($p in $procs) { if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force } }
if ($wrangler) { & taskkill /PID $wrangler.Id /T /F | Out-Null }

$used = $names[0..($Players - 1)]
foreach ($f in $used) {
    Write-Output "--- $f"
    Select-String -Path "$out\$f.log" -Pattern 'SSB64 Lobby:|SSB64 WS:|online match|netplay tick|DESYNC|rollback FAILED' |
        Select-Object -Last 8 | ForEach-Object { $_.Line }
}
$traces = @{}
foreach ($f in $used) {
    $t = "$out\$f.trace"
    if (-not (Test-Path $t)) { Write-Output "no trace for $f (match did not start)"; exit 2 }
    $lines = @(Get-Content $t)
    # The game is killed at the end of the run, so its last trace line can be torn
    # (partial write). Drop it when its field count differs from the line before.
    if ($lines.Count -ge 2 -and (($lines[-1] -split ' ').Count -ne ($lines[-2] -split ' ').Count)) {
        $lines = $lines[0..($lines.Count - 2)]
    }
    $traces[$f] = $lines
}
$n = ($used | ForEach-Object { $traces[$_].Count } | Measure-Object -Minimum).Minimum
Write-Output (($used | ForEach-Object { "$_ traced=$($traces[$_].Count)" }) -join "  ")
# Compare tick + the gated gameplay columns (full rng battle fighters items
# weapons stage objman). The trailing input/joints/camera/vars columns are
# diagnostic: `input` folds in predicted frames, so it legitimately differs
# between peers once a rollback has corrected a misprediction.
function Gated([string]$line) { ($line -split ' ')[0..8] -join ' ' }
$host_lines = $traces['host']
for ($i = 0; $i -lt $n; $i++) {
    $ref = Gated $host_lines[$i]
    foreach ($f in $used[1..($Players - 1)]) {
        if ((Gated $traces[$f][$i]) -ne $ref) {
            Write-Output "DESYNC at line $i ($f vs host)`n  host: $($host_lines[$i])`n  ${f}: $($traces[$f][$i])"
            exit 1
        }
    }
}
if ($n -eq 0) { Write-Output "no ticks traced"; exit 2 }
if ($MinTicks -gt 0 -and $n -lt $MinTicks) { Write-Output "only $n ticks compared (< $MinTicks)"; exit 2 }
$bad = Select-String -Path ($used | ForEach-Object { "$out\$_.log" }) -Pattern 'DESYNC detected|rollback FAILED' -ErrorAction SilentlyContinue
if ($bad) { Write-Output "in-band desync/rollback failure logged:"; $bad | Select-Object -First 4 | ForEach-Object { $_.Line }; exit 1 }
Write-Output "IN SYNC for $n ticks ($Players players)"
exit 0
