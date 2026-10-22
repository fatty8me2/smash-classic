# Runs two BattleShip instances against each other over localhost UDP with
# rollback netplay, seeded random inputs on both sides and (optionally) a
# simulated bad network, then diffs the two peers' confirmed-state traces.
# Identical traces = the peers never desynced. See docs/rollback_design.md.
#
#   .\scripts\netplay_localtest.ps1 -Seconds 60 -LatencyMs 50 -JitterMs 20 -LossPct 5
#
# Exit code: 0 in sync, 1 desync, 2 a peer produced no trace.
param(
    [int]$Seconds = 60,
    [int]$Delay = 2,
    [int]$LatencyMs = 0,
    [int]$JitterMs = 0,
    [int]$LossPct = 0,
    [int]$Seed = 4242,
    [int]$BasePort = 7801,
    [int]$InjectDesync = -1,
    [string]$BuildDir = "$PSScriptRoot\..\build\us\Release",
    [string]$OutDir = "$PSScriptRoot\..\build\us\netplay-test"
)

$build = Resolve-Path $BuildDir
New-Item -ItemType Directory -Force $OutDir | Out-Null
$out = Resolve-Path $OutDir

function Start-Peer([int]$local, [int]$remote, [int]$bindPort, [int]$peerPort, [int]$isHost, [int]$fuzz, [string]$name) {
    $vars = @{
        SSB64_NETPLAY = '1'; SSB64_NETPLAY_BOOTSTRAP = '1'; SSB64_NETPLAY_HOST = "$isHost"; SSB64_MUTE = '1'; SSB64_NO_UPDATE_CHECK = '1'; SSB64_HIDDEN_WINDOW = '1'
        SSB64_NETPLAY_LOCAL_PLAYER = "$local"; SSB64_NETPLAY_REMOTE_PLAYER = "$remote"
        SSB64_NETPLAY_BIND = "127.0.0.1:$bindPort"; SSB64_NETPLAY_PEER = "127.0.0.1:$peerPort"
        SSB64_NETPLAY_DELAY = "$Delay"; SSB64_NETPLAY_SEED = "$Seed"; SSB64_NETPLAY_FUZZ = "$fuzz"
        SSB64_NETPLAY_SIM_LATENCY_MS = "$LatencyMs"; SSB64_NETPLAY_SIM_JITTER_MS = "$JitterMs"
        SSB64_NETPLAY_SIM_LOSS_PCT = "$LossPct"; SSB64_NETPLAY_SIM_SEED = "$fuzz"
        SSB64_NETPLAY_CONFIRMED_TRACE = "$out\$name.trace"; SSB64_LOG_PATH = "$out\$name.log"
        SSB64_SAVE_PATH = "$out\$name.sav"
        SSB64_NETPLAY_TEST_DESYNC = $(if ($isHost -eq 1) { "$InjectDesync" } else { "-1" })
    }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = Join-Path $build 'BattleShip.exe'
    $psi.WorkingDirectory = $build
    $psi.UseShellExecute = $false
    foreach ($k in $vars.Keys) { $psi.EnvironmentVariables[$k] = $vars[$k] }
    return [System.Diagnostics.Process]::Start($psi)
}

Remove-Item "$out\*.trace", "$out\*.log" -ErrorAction SilentlyContinue
$a = Start-Peer 0 1 $BasePort ($BasePort + 1) 1 111 'host'
$b = Start-Peer 1 0 ($BasePort + 1) $BasePort 0 222 'client'
Start-Sleep -Seconds $Seconds
foreach ($p in @($a, $b)) { if (-not $p.HasExited) { $p.CloseMainWindow() | Out-Null } }
Start-Sleep -Seconds 3
foreach ($p in @($a, $b)) { if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force } }

$ta = "$out\host.trace"; $tb = "$out\client.trace"
if (-not (Test-Path $ta) -or -not (Test-Path $tb)) { Write-Output "missing trace"; exit 2 }
$la = Get-Content $ta; $lb = Get-Content $tb
$n = [Math]::Min($la.Count, $lb.Count)
Write-Output "host traced=$($la.Count) client traced=$($lb.Count) compared=$n"
foreach ($f in @('host', 'client')) {
    Select-String -Path "$out\$f.log" -Pattern 'netplay session|netplay tick|session stop|rollback FAILED|DESYNC|TEST injecting' | Select-Object -Last 3 | ForEach-Object { "$f> $($_.Line)" }
}
# Compare tick + the gated gameplay columns (full rng battle fighters items
# weapons stage objman); the trailing input/joints/camera/vars columns are
# diagnostic and legitimately differ between peers once a rollback corrected a misprediction.
function Gated([string]$line) { ($line -split ' ')[0..8] -join ' ' }
for ($i = 0; $i -lt $n; $i++) {
    if ((Gated $la[$i]) -ne (Gated $lb[$i])) {
        Write-Output "DESYNC at line $i"
        Write-Output "  host:   $($la[$i])"
        Write-Output "  client: $($lb[$i])"
        exit 1
    }
}
if ($n -eq 0) { Write-Output "no ticks traced"; exit 2 }
Write-Output "IN SYNC for $n ticks"
exit 0
