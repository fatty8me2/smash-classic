# End-to-end online test against the Cloudflare lobby (server/cloudflare):
# a host creates a room and a client joins it by code. They hole-punch, pick
# fighters, start a rollback match with fuzzed inputs, and their
# confirmed-state traces are compared. -LatencyMs/-LossPct simulate a bad
# network on the game traffic (the lobby handshake uses the same socket).
#
#   .\scripts\netplay_lobbytest.ps1 -Seconds 60
#   .\scripts\netplay_lobbytest.ps1 -Server wss://smash-netplay.jumpcircuit.workers.dev
#
# Without -Server it uses `wrangler dev` on ws://127.0.0.1:8799, starting it
# if nothing answers there.
#
# Exit code: 0 in sync, 1 desync, 2 no match / no trace.
param(
    [int]$Seconds = 60,
    [int]$LatencyMs = 0,
    [int]$JitterMs = 0,
    [int]$LossPct = 0,
    [string]$Server = "",
    [int]$HostFighter = 0,
    [int]$ClientFighter = 1,
    [int]$Stage = 0,
    [switch]$ForceRelay,
    [string]$BuildDir = "$PSScriptRoot\..\build\us\Release",
    [int]$ExtraHold = 0,        # client holds this many extra frames at match start
    [switch]$NoRandRestore,     # disable the hold RNG fix (to reproduce the bug)
    [int]$ArenaPoison = 0,      # client fills each scene arena with this byte (uninitialized-read probe)
    [int]$AddrJitter = 0,      # client shifts its heap layout like a different PC would
    [string]$HostDir = "",      # run the host from another install (its own cfg + save)
    [string]$OutDir = "$PSScriptRoot\..\build\us\lobby-test"
)

$build = Resolve-Path $BuildDir
New-Item -ItemType Directory -Force $OutDir | Out-Null
$out = Resolve-Path $OutDir
Remove-Item "$out\*" -ErrorAction SilentlyContinue

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
Write-Output "lobby server: $Server"

function Start-Peer([string]$role, [int]$fighter, [int]$fuzz) {
    $vars = @{
        SSB64_LOBBY_CODE_FILE = "$out\code.txt"; SSB64_LOBBY_FKIND = "$fighter"; SSB64_LOBBY_STAGE = "$Stage"
        SSB64_NETPLAY_FUZZ = "$fuzz"; SSB64_MUTE = '1'; SSB64_NO_UPDATE_CHECK = '1'
        SSB64_NETPLAY_SIM_LATENCY_MS = "$LatencyMs"; SSB64_NETPLAY_SIM_JITTER_MS = "$JitterMs"
        SSB64_NETPLAY_SIM_LOSS_PCT = "$LossPct"; SSB64_NETPLAY_SIM_SEED = "$fuzz"
        SSB64_NETPLAY_CONFIRMED_TRACE = "$out\$role.trace"; SSB64_LOG_PATH = "$out\$role.log"
        SSB64_LOBBY_FORCE_RELAY = $(if ($ForceRelay) { "1" } else { "" })
    }
    if ($role -eq 'host') {
        $vars['SSB64_LOBBY_HOST'] = $Server; $vars['SSB64_LOBBY_AUTOSTART'] = '1'
    } else {
        $vars['SSB64_LOBBY_JOIN'] = $Server
        if ($AddrJitter) { $vars['SSB64_ADDR_JITTER'] = "$AddrJitter" }
        if ($ExtraHold) { $vars['SSB64_NETPLAY_EXTRA_HOLD'] = "$ExtraHold" }
        if ($NoRandRestore) { $vars['SSB64_NETPLAY_NO_RAND_RESTORE'] = "1" }
        if ($ArenaPoison) { $vars['SSB64_ARENA_POISON'] = "$ArenaPoison" }
    }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $own = ($role -eq 'host' -and $HostDir)
    $dir = $(if ($own) { $HostDir } else { $build })
    if (-not $own) { $vars['SSB64_SAVE_PATH'] = "$out\$role.sav" }
    $psi.FileName = Join-Path $dir 'BattleShip.exe'
    $psi.WorkingDirectory = $dir
    $psi.UseShellExecute = $false
    foreach ($k in $vars.Keys) { $psi.EnvironmentVariables[$k] = $vars[$k] }
    return [System.Diagnostics.Process]::Start($psi)
}

$a = Start-Peer 'host' $HostFighter 111
Start-Sleep -Seconds 2
$b = Start-Peer 'client' $ClientFighter 222
Start-Sleep -Seconds $Seconds
foreach ($p in @($a, $b)) { if (-not $p.HasExited) { $p.CloseMainWindow() | Out-Null } }
Start-Sleep -Seconds 3
foreach ($p in @($a, $b)) { if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force } }
if ($wrangler) { & taskkill /PID $wrangler.Id /T /F | Out-Null }
foreach ($f in @('host', 'client')) {
    Write-Output "--- $f"
    Select-String -Path "$out\$f.log" -Pattern 'SSB64 Lobby:|SSB64 WS:|online match|netplay tick|DESYNC|rollback FAILED' |
        Select-Object -Last 8 | ForEach-Object { $_.Line }
}
$ta = "$out\host.trace"; $tb = "$out\client.trace"
if (-not (Test-Path $ta) -or -not (Test-Path $tb)) { Write-Output "no trace (match did not start)"; exit 2 }
$la = Get-Content $ta; $lb = Get-Content $tb
$n = [Math]::Min($la.Count, $lb.Count)
Write-Output "host traced=$($la.Count) client traced=$($lb.Count)"
for ($i = 0; $i -lt $n; $i++) {
    if ($la[$i] -ne $lb[$i]) {
        Write-Output "DESYNC at line $i`n  host:   $($la[$i])`n  client: $($lb[$i])"
        exit 1
    }
}
if ($n -eq 0) { Write-Output "no ticks traced"; exit 2 }
Write-Output "IN SYNC for $n ticks"
exit 0
