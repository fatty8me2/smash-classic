# Runs unattended 4-CPU VS matches with rollback SyncTest enabled and prints
# the verdict plus the first divergences. See docs/rollback_design.md.
#
#   .\scripts\rollback_synctest.ps1 -Stage 0 -Fighters "0,1,2,3" -Seed 12345
#   .\scripts\rollback_synctest.ps1 -AllStages          # QA matrix, see below
#
# The game ALWAYS runs on a private hidden Windows desktop (CreateDesktop +
# STARTUPINFO.lpDesktop), so no window can ever appear on, or take focus from,
# the interactive desktop. Network: none (SyncTest is offline).
#
# -AllStages: every VS stage (0-8, incl. Mushroom Kingdom) plus the extra id
# the netplay stage picker accepts (9), each with 2 and 4 fighters, items on,
# distance 7, 1 minute (~3600 ticks). -Players picks the active fighter count.
#
# Exit code: 0 PASS, 1 FAIL, 2 timeout/crash.
param(
    [int]$Stage = -1,
    [string]$Fighters = "",
    [int]$Players = 4,
    [int]$Seed = 12345,
    [int]$Minutes = 1,
    [int]$Distance = 1,
    [int]$TimeoutSeconds = 400,
    [string]$BuildDir = "$PSScriptRoot\..\build\us\Release",
    [int]$ShowLines = 40,
    [string]$OutDir = "$PSScriptRoot\..\build\us\synctest",
    [switch]$AllStages
)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class HiddenDesk {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    public struct STARTUPINFO { public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern IntPtr CreateDesktop(string name, IntPtr dev, IntPtr dm, int flags, uint access, IntPtr sa);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern bool CreateProcess(string app, string cmd, IntPtr pa, IntPtr ta, bool inh, uint flags,
        IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll")] public static extern bool GetExitCodeProcess(IntPtr h, out uint code);
    [DllImport("kernel32.dll")] public static extern bool TerminateProcess(IntPtr h, uint code);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    public static IntPtr Desk(string n) { return CreateDesktop(n, IntPtr.Zero, IntPtr.Zero, 0, 0x10000000u, IntPtr.Zero); }
    // Returns exit code, or -1 on timeout (own process killed), -2 on spawn failure. pid out.
    public static int Run(string desk, string exe, string cwd, int timeoutMs, out int pid) {
        STARTUPINFO si = new STARTUPINFO(); si.cb = Marshal.SizeOf(si); si.lpDesktop = desk;
        PROCESS_INFORMATION pi; pid = 0;
        if (!CreateProcess(null, "\"" + exe + "\"", IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, cwd, ref si, out pi)) return -2;
        pid = pi.dwProcessId;
        int rc;
        if (WaitForSingleObject(pi.hProcess, (uint)timeoutMs) != 0) { TerminateProcess(pi.hProcess, 99); rc = -1; }
        else { uint c; GetExitCodeProcess(pi.hProcess, out c); rc = (int)c; }
        CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
        return rc;
    }
}
"@

$exe = Join-Path (Resolve-Path $BuildDir) 'BattleShip.exe'
$cwd = (Resolve-Path $BuildDir).Path
$null = [HiddenDesk]::Desk('ssb64_synctest_hidden')

function Invoke-SyncTest([int]$Stage, [string]$Fighters, [int]$Players, [int]$Distance, [string]$Tag) {
    New-Item -ItemType Directory -Force $OutDir | Out-Null
    $out = (Resolve-Path $OutDir).Path
    $log = "$out\synctest_$Tag.log"
    Remove-Item $log -ErrorAction SilentlyContinue
    $env:SSB64_ROLLBACK_SYNCTEST = "$Distance"
    $env:SSB64_MUTE = '1'
    $env:SSB64_HIDDEN_WINDOW = '1'
    $env:SSB64_LOG_PATH = $log
    $env:SSB64_SAVE_PATH = "$out\synctest_$Tag.sav"
    $env:SSB64_NO_UPDATE_CHECK = '1'
    $env:SSB64_ROLLBACK_AUTOVS = '1'
    $env:SSB64_RIG_EXIT = '1'
    $env:SSB64_ROLLBACK_SEED = "$Seed"
    $env:SSB64_ROLLBACK_MINUTES = "$Minutes"
    $env:SSB64_ROLLBACK_PLAYERS = "$Players"
    if ($Stage -ge 0) { $env:SSB64_ROLLBACK_STAGE = "$Stage" } else { Remove-Item Env:SSB64_ROLLBACK_STAGE -ErrorAction SilentlyContinue }
    if ($Fighters) { $env:SSB64_ROLLBACK_FIGHTERS = $Fighters } else { Remove-Item Env:SSB64_ROLLBACK_FIGHTERS -ErrorAction SilentlyContinue }
    $pid_ = 0
    $rc = [HiddenDesk]::Run('ssb64_synctest_hidden', $exe, $cwd, $TimeoutSeconds * 1000, [ref]$pid_)
    $code = if ($rc -eq -1 -or $rc -eq -2) { 2 } else { $rc }
    $tested = ''; $failed = ''
    if (Test-Path $log) {
        $m = Select-String -Path $log -Pattern 'SyncTest (PASS|FAIL).*' | Select-Object -Last 1
        if ($m) { $tested = $m.Line }
    }
    [pscustomobject]@{ Tag = $Tag; Stage = $Stage; Fighters = $Fighters; Players = $Players; Exit = $code; Rc = $rc; Verdict = $tested; Log = $log }
}

if ($AllStages) {
    # Fighter sets: kinds 0 Mario 1 Fox 2 DK 3 Samus 4 Luigi 5 Link 6 Yoshi 7 Captain
    # 8 Kirby 9 Pikachu 10 Purin 11 Ness. Rotated per stage so every fighter and
    # projectile user (Samus, Kirby, Pikachu, Ness, Link, Fox, Mario) is exercised.
    $sets = @("3,8,9,11", "1,5,0,10", "2,6,7,4", "11,3,8,9", "9,11,5,1", "8,10,3,0", "4,7,11,9", "6,2,1,8", "5,9,3,11", "0,8,11,3")
    $results = @()
    foreach ($s in 0..9) {
        foreach ($n in 2, 4) {
            $f = $sets[$s]
            $tag = "s${s}_p$n"
            $r = Invoke-SyncTest $s $f $n 7 $tag
            $results += $r
            Write-Output ("stage={0} players={1} fighters={2} exit={3} {4}" -f $s, $n, $f, $r.Exit, $r.Verdict)
        }
    }
    $bad = @($results | Where-Object { $_.Exit -ne 0 })
    Write-Output ("MATRIX: {0} runs, {1} failed" -f $results.Count, $bad.Count)
    $bad | ForEach-Object { Write-Output ("  FAILED {0} log={1}" -f $_.Tag, $_.Log) }
    exit ([int]($bad.Count -gt 0))
}

$r = Invoke-SyncTest $Stage $Fighters $Players $Distance 'single'
Select-String -Path $r.Log -Pattern 'SSB64 Rollback' | Select-Object -First $ShowLines | ForEach-Object { $_.Line }
Select-String -Path $r.Log -Pattern 'SyncTest (PASS|FAIL)' | ForEach-Object { $_.Line }
if ($r.Exit -ne 0 -and $r.Exit -ne 1) {
    Select-String -Path $r.Log -Pattern 'crash|Exception|SIGSEGV|abort' | Select-Object -Last 10 | ForEach-Object { $_.Line }
}
if ($r.Rc -eq -1) { Write-Output "TIMEOUT after $TimeoutSeconds s" }
Write-Output "exit=$($r.Exit)"
exit $r.Exit
