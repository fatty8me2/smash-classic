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
#   .\scripts\netplay_lobbytest.ps1 -Players 3 -Seconds 90 -Kill "2@40"          # kill game slot 2, 40 s after the launch
#   .\scripts\netplay_lobbytest.ps1 -Players 4 -Seconds 120 -Kill "3@40,1@60"    # two drop-outs (slot 0 is the host)
#
# With -Kill the survivors' traces are compared with each other tick for tick, a killed
# peer's trace against the first survivor's up to where it stopped, and every survivor
# must have agreed on the same drop tick for each killed player.
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
    [string]$Kill = "",         # "slot@seconds,..." kill that peer's process this long after the last launch (drop-out test)
    [switch]$Suspend,           # with -Kill: freeze the process instead (its lobby socket stays open: only the silence detects it)
    [int]$ResumeAfter = 0,      # with -Suspend: resume the frozen peer this many seconds later (it must leave the match itself)
    [int]$MinPostDrop = 0,      # with -Kill: every survivor must trace at least this many ticks past the last drop tick
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
$killPlan = @()
foreach ($item in ($Kill -split ',' | Where-Object { $_ })) {
    $parts = $item -split '@'
    $killPlan += [pscustomobject]@{ Slot = [int]$parts[0]; At = [int]$parts[1]; Done = $false }
}
$killed = @{}
$resumePlan = @()
if ($killPlan.Count -gt 0) {
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    while ($clock.Elapsed.TotalSeconds -lt $Seconds) {
        foreach ($k in $killPlan) {
            if (-not $k.Done -and $clock.Elapsed.TotalSeconds -ge $k.At) {
                $k.Done = $true
                $victim = $procs[$k.Slot]
                if (-not $victim.HasExited) {
                    Write-Output ("killing {0} (pid {1}) at {2:N0}s" -f $names[$k.Slot], $victim.Id, $clock.Elapsed.TotalSeconds)
                    if ($Suspend) {
                        Add-Type -Namespace Win32 -Name Nt -MemberDefinition '[DllImport("ntdll.dll")] public static extern int NtSuspendProcess(System.IntPtr h);' -ErrorAction SilentlyContinue
                        [Win32.Nt]::NtSuspendProcess($victim.Handle) | Out-Null
                        if ($ResumeAfter -gt 0) { $resumePlan += [pscustomobject]@{ Proc = $victim; At = $clock.Elapsed.TotalSeconds + $ResumeAfter } }
                    } else {
                        Stop-Process -Id $victim.Id -Force
                    }
                }
                $killed[$names[$k.Slot]] = $true
            }
        }
        foreach ($r in @($resumePlan)) {
            if ($clock.Elapsed.TotalSeconds -ge $r.At) {
                Add-Type -Namespace Win32 -Name Nr -MemberDefinition '[DllImport("ntdll.dll")] public static extern int NtResumeProcess(System.IntPtr h);' -ErrorAction SilentlyContinue
                [Win32.Nr]::NtResumeProcess($r.Proc.Handle) | Out-Null
                Write-Output ("resumed pid {0}" -f $r.Proc.Id)
                $resumePlan = @($resumePlan | Where-Object { $_ -ne $r })
            }
        }
        Start-Sleep -Milliseconds 250
    }
} elseif ($RestartLast -and $Players -ge 3) {
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
    Select-String -Path "$out\$f.log" -Pattern 'SSB64 Lobby:|SSB64 WS:|SSB64 Drop:|online match|netplay tick|DESYNC|rollback FAILED' |
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
# A "N missing" line carries no hashes: comparing two of them proves nothing. Never count them as in sync.
foreach ($f in $used) {
    $missing = @($traces[$f] | Where-Object { $_ -match ' missing$' }).Count
    if ($missing -gt 0) {
        Write-Output "$f has $missing 'missing' trace lines (no hashes were recorded for those ticks): not a valid comparison"
        exit 2
    }
}
$survivors = @($used | Where-Object { -not $killed.ContainsKey($_) })
$gone = @($used | Where-Object { $killed.ContainsKey($_) })
if ($survivors.Count -eq 0) { Write-Output "no survivors"; exit 2 }
$refName = $survivors[0]
$ref_lines = $traces[$refName]
# survivors: the whole traced length; a killed peer: as far as it got
$n = ($survivors | ForEach-Object { $traces[$_].Count } | Measure-Object -Minimum).Minimum
for ($i = 0; $i -lt $n; $i++) {
    $ref = Gated $ref_lines[$i]
    foreach ($f in $survivors[1..($survivors.Count)]) {
        if ($f -and (Gated $traces[$f][$i]) -ne $ref) {
            Write-Output "DESYNC at line $i ($f vs $refName)`n  ${refName}: $($ref_lines[$i])`n  ${f}: $($traces[$f][$i])"
            exit 1
        }
    }
}
foreach ($f in $gone) {
    $m = [Math]::Min($traces[$f].Count, $ref_lines.Count)
    # A frozen peer that wakes up keeps simulating without knowing it was dropped: only the ticks before its drop tick count.
    $mine = Select-String -Path "$out\$f.log" -Pattern 'online match local=(\d+)' | Select-Object -First 1
    if ($mine) {
        $leave = Select-String -Path "$out\$refName.log" -Pattern ("SSB64 Drop: player {0} leaves the match at tick=(\d+)" -f $mine.Matches[0].Groups[1].Value) | Select-Object -First 1
        if ($leave) { $m = [Math]::Min($m, [int]$leave.Matches[0].Groups[1].Value) }
    }
    for ($i = 0; $i -lt $m; $i++) {
        if ((Gated $traces[$f][$i]) -ne (Gated $ref_lines[$i])) {
            Write-Output "DESYNC at line $i (killed $f vs $refName)`n  ${refName}: $($ref_lines[$i])`n  ${f}: $($traces[$f][$i])"
            exit 1
        }
    }
    Write-Output "killed $f matched $refName for $m ticks"
}
if ($n -eq 0) { Write-Output "no ticks traced"; exit 2 }
if ($MinTicks -gt 0 -and $n -lt $MinTicks) { Write-Output "only $n ticks compared (< $MinTicks)"; exit 2 }
$bad = Select-String -Path ($used | ForEach-Object { "$out\$_.log" }) -Pattern 'DESYNC detected|rollback FAILED|SSB64 Drop: CONFLICT' -ErrorAction SilentlyContinue
if ($bad) { Write-Output "in-band desync/rollback failure logged:"; $bad | Select-Object -First 4 | ForEach-Object { $_.Line }; exit 1 }

# Drop-outs: every survivor must have agreed on the same tick for each dropped player.
if ($killPlan.Count -gt 0) {
    $dropTicks = @{}
    foreach ($f in $survivors) {
        $mine = @{}
        foreach ($l in (Select-String -Path "$out\$f.log" -Pattern 'SSB64 Drop: player (\d+) leaves the match at tick=(\d+)')) {
            $mine[$l.Matches[0].Groups[1].Value] = [int]$l.Matches[0].Groups[2].Value
        }
        $dropTicks[$f] = $mine
        Write-Output ("{0} drops: {1}" -f $f, (($mine.Keys | Sort-Object | ForEach-Object { "player $_ at tick $($mine[$_])" }) -join ", "))
    }
    $lastDrop = 0
    foreach ($k in $killPlan) {
        # The process index is not the game slot (the lobby hands out slots in join order): read it from its log.
        $key = "$($k.Slot)"
        $m = Select-String -Path "$out\$($names[$k.Slot]).log" -Pattern 'online match local=(\d+)' | Select-Object -First 1
        if ($m) { $key = $m.Matches[0].Groups[1].Value }
        foreach ($f in $survivors) {
            if (-not $dropTicks[$f].ContainsKey($key)) { Write-Output "$f never agreed to drop player $key"; exit 1 }
            if ($dropTicks[$f][$key] -ne $dropTicks[$refName][$key]) { Write-Output "drop tick of player $key differs: $f=$($dropTicks[$f][$key]) $refName=$($dropTicks[$refName][$key])"; exit 1 }
        }
        if ($dropTicks[$refName][$key] -gt $lastDrop) { $lastDrop = $dropTicks[$refName][$key] }
    }
    $after = $n - $lastDrop
    Write-Output "survivors traced $after ticks past the last drop tick ($lastDrop)"
    if ($after -lt $MinPostDrop) { Write-Output "fewer than $MinPostDrop ticks after the drop"; exit 2 }
}
Write-Output "IN SYNC for $n ticks ($($survivors.Count) survivors of $Players players)"
exit 0
