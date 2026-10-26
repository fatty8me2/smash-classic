# Builds BattleShip as a self-contained Windows release zip.
#
# Output: <repo-root>\dist\BattleShip-windows.zip
#
# Layout produced (extracted):
#   BattleShip\
#     BattleShip.exe             — main executable
#     torch.exe                  — sidecar for first-run extraction
#     f3d.o2r                    — Fast3D shader archive (ROM-independent)
#     config.yml                 — Torch extraction config
#     yamls\us\*.yml             — Torch extraction recipes
#     gamecontrollerdb.txt       — SDL controller mappings
#     SDL2.dll                   — runtime dependency (vcpkg-bundled)
#     <other vcpkg DLLs>         — picked up by Get-ChildItem from build dir
#
# The default US Windows package includes TCC scripting support. It statically
# links libtcc into BattleShip.exe and stages only TinyCC headers plus libtcc1.a
# under .tcc, avoiding the tcc.dll false-positive signature while ScriptLoader
# relocates mod code in memory.
#
# Portable: drop the extracted folder anywhere and run BattleShip.exe.
# Save data and config (ssb64_save.bin, BattleShip.cfg.json, logs/) land
# next to the .exe in the extraction directory — move the folder, the
# saves move with it. BattleShip.o2r is NOT bundled; the first-run wizard
# extracts it from the user's ROM into the same directory as BattleShip.exe.
#
# We intentionally do NOT pass -DNON_PORTABLE=ON. NON_PORTABLE bakes
# CMAKE_INSTALL_PREFIX into libultraship's install_config.h at configure
# time, and CMake resolves any relative prefix against the configure cwd —
# so on the GitHub Actions runner that bakes the runner workspace path
# (e.g. "D:/a/BattleShip/BattleShip/BattleShip"), which v0.7.2 shipped
# and which crashed user machines whose D: drive returned ERROR_NOT_READY
# when libultraship probed it. Building portable side-steps the entire
# class of bug: the runtime resolves resource paths via GetModuleFileNameW
# (LUS Context::GetAppBundlePath, _WIN32 branch) and saves via the same
# mechanism, so the only paths the binary ever touches are exe-relative.

param(
    # Scratch output dir (zip, installer, SHA256SUMS, stage tree). Default: <root>\dist. Same as $env:SSB64_DIST_DIR.
    [string]$OutDir = "",
    # RetroHub checkout (default: sibling ..\RetroHub). Same as $env:RETROHUB_DIR.
    [string]$RetroHubDir = "",
    # Ignore the "BattleShip sources unchanged" cache and rebuild BattleShip/torch/f3d.o2r anyway.
    [switch]$ForceBattleShip,
    # Build every RetroHub target (all tests included) like the old behaviour, instead of only the shipped ones.
    [switch]$BuildAllHub
)
$ErrorActionPreference = "Stop"
$script:PkgClock = [System.Diagnostics.Stopwatch]::StartNew()

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
# ROM version: us (default) or jp. The JP build is a SEPARATE
# application — own .exe name, zip, app-data dir — so a user can keep
# both and they never touch each other's ROM/o2r/saves. $AppName
# mirrors CMake SSB64_APP_NAME / OUTPUT_NAME. US keeps the historical
# "BattleShip" identity so existing links / the in-app updater are
# unaffected.
$Ver = if ($env:SSB64_VERSION) { $env:SSB64_VERSION } else { "us" }
if ($Ver -ne "us" -and $Ver -ne "jp") { Write-Error "SSB64_VERSION must be us|jp"; exit 1 }
if ($env:SSB64_ENABLE_SCRIPTING) {
    $EnableScripting = $env:SSB64_ENABLE_SCRIPTING -in @("1", "ON", "TRUE", "YES", "on", "true", "yes")
} else {
    $EnableScripting = $Ver -eq "us"
}
if ($EnableScripting -and $Ver -eq "jp") {
    Write-Error "JP source modding is not release-supported yet; the TCC mod API still compiles mods with US region defines."
    exit 1
}
$DisableScripting = if ($EnableScripting) { "OFF" } else { "ON" }
$PackageFlavor = if ($EnableScripting) { "scripting" } else { "standard" }
$ZipSuffix = "-windows"
$BuildDir = if ($env:SSB64_BUILD_DIR) { $env:SSB64_BUILD_DIR } else { Join-Path $Root "build-bundle-win-$Ver-$PackageFlavor" }
# Dry-run knobs (QA): SSB64_DIST_DIR = scratch output dir instead of <root>\dist,
# SSB64_SKIP_BUILD=1 = reuse existing build outputs (no codegen/cmake/RetroHub rebuild),
# RETROHUB_DIR = RetroHub checkout (default: sibling ..\RetroHub), RETROHUB_BUILD_DIR = its build dir.
$SkipBuild = $env:SSB64_SKIP_BUILD -eq "1"
$DistDir = if ($OutDir) { $OutDir } elseif ($env:SSB64_DIST_DIR) { $env:SSB64_DIST_DIR } else { Join-Path $Root "dist" }
New-Item -ItemType Directory -Path $DistDir -Force | Out-Null
$AppName = if ($Ver -eq "jp") { "BattleShip-JP" } else { "BattleShip" }
$StageName = $AppName
$StageDir = Join-Path $DistDir $StageName
$ZipPath = Join-Path $DistDir "$AppName$ZipSuffix.zip"
# Zip deflate level (Fastest|Optimal|NoCompression) and Inno Setup compression (lzma2/fast|lzma2/normal|lzma2/max...).
$ZipLevel = if ($env:PKG_ZIP_LEVEL) { $env:PKG_ZIP_LEVEL } else { "Fastest" }
$SetupCompression = if ($env:PKG_SETUP_COMPRESSION) { $env:PKG_SETUP_COMPRESSION } else { "lzma2/fast" }
$Jobs = if ($env:NUMBER_OF_PROCESSORS) { [int]$env:NUMBER_OF_PROCESSORS } else { 4 }

# Per-step wall-clock timing: every Write-Step closes the previous step and prints its elapsed time;
# Show-Timings prints the table (also written to <DistDir>\package-timings.txt) at the end or on failure.
$script:StepLog = New-Object System.Collections.ArrayList
$script:StepName = $null
$script:StepStart = 0.0
function Close-Step {
    if ($script:StepName) {
        $e = $script:PkgClock.Elapsed.TotalSeconds - $script:StepStart
        [void]$script:StepLog.Add([pscustomobject]@{ Step = $script:StepName; Seconds = [math]::Round($e, 1) })
        Write-Host ("    [{0}] {1:N1}s" -f $script:StepName, $e) -ForegroundColor DarkGray
        $script:StepName = $null
    }
}
function Write-Step($msg) {
    Close-Step
    $script:StepName = $msg
    $script:StepStart = $script:PkgClock.Elapsed.TotalSeconds
    Write-Host "`n=== $msg ===" -ForegroundColor Cyan
}
function Show-Timings {
    Close-Step
    $lines = @("Package timings:") + ($script:StepLog | ForEach-Object { "{0,8:N1}s  {1}" -f $_.Seconds, $_.Step }) +
             ("{0,8:N1}s  TOTAL" -f $script:PkgClock.Elapsed.TotalSeconds)
    $lines | ForEach-Object { Write-Host $_ -ForegroundColor Yellow }
    try { Set-Content -Path (Join-Path $DistDir "package-timings.txt") -Value $lines -Encoding ascii } catch {}
}
function Fail($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; Show-Timings; exit 1 }

# ── BattleShip change detection ──
# Fingerprint of everything that can change the BattleShip build outputs (BattleShip.exe, torch.exe,
# f3d.o2r): tracked file blob ids (submodules = their pinned commit), uncommitted edits, untracked
# files, and each submodule's own commit + dirty state. VERSION is deliberately NOT part of it (the
# release version is stamped into the staged exe, see Set-ExeVersion), neither are docs/server/installer/
# scripts/CI files, which never reach the game binaries. Stored next to the build dir after each
# successful build; if it matches and the artifacts exist, configure+build+o2r are skipped entirely.
function Get-BsInputHash {
    $ex = @(':(exclude)VERSION', ':(exclude)docs', ':(exclude)server', ':(exclude)installer', ':(exclude)scripts',
            ':(exclude).github', ':(exclude).claude', ':(exclude)ci', ':(exclude)*.md', ':(exclude)wt', ':(exclude)dist')
    $parts = New-Object System.Collections.ArrayList
    [void]$parts.Add("ver=$Ver;scripting=$EnableScripting;salt=1")
    [void]$parts.Add(((& git -C $Root ls-files -s -- . @ex) -join "`n"))
    [void]$parts.Add(((& git -C $Root diff HEAD --no-ext-diff -- . @ex) -join "`n"))
    foreach ($f in (& git -C $Root ls-files -o --exclude-standard -- . @ex)) {
        $fi = Get-Item -LiteralPath (Join-Path $Root $f) -ErrorAction SilentlyContinue
        if ($fi) { [void]$parts.Add("untracked:${f}:$($fi.Length):$($fi.LastWriteTimeUtc.Ticks)") }
    }
    foreach ($sm in @("libultraship", "torch", "decomp")) {
        $d = Join-Path $Root $sm
        if (Test-Path $d) {
            [void]$parts.Add("$sm=$(& git -C $d rev-parse HEAD)")
            [void]$parts.Add(((& git -C $d status --porcelain --ignore-submodules=none) -join "`n"))
        }
    }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes(($parts -join "`n--`n"))
    $sha = [System.Security.Cryptography.SHA256]::Create()
    return ([System.BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '').ToLower()
}

# The version string lives in a 64-byte slot behind a marker (port/build_version.h + generated
# build_version.cpp: "@@BSVERSLOT@@|<version>"). Overwrite the value in a staged copy of the exe so a
# VERSION bump needs no BattleShip recompile/relink.
function Set-ExeVersion($ExePath, $Version) {
    $marker = [System.Text.Encoding]::ASCII.GetBytes("@@BSVERSLOT@@|")
    $slotLen = 64
    $bytes = [System.IO.File]::ReadAllBytes($ExePath)
    $found = -1
    $first = $marker[0]
    $idx = [Array]::IndexOf($bytes, $first, 0)
    while ($idx -ge 0 -and $idx -le $bytes.Length - $marker.Length) {
        $ok = $true
        for ($k = 1; $k -lt $marker.Length; $k++) { if ($bytes[$idx + $k] -ne $marker[$k]) { $ok = $false; break } }
        if ($ok) { $found = $idx; break }
        $idx = [Array]::IndexOf($bytes, $first, $idx + 1)
    }
    if ($found -lt 0) { Fail "version slot marker not found in $ExePath - rebuild BattleShip (-ForceBattleShip)" }
    $val = [System.Text.Encoding]::ASCII.GetBytes($Version)
    $room = $slotLen - $marker.Length - 1
    if ($val.Length -gt $room) { Fail "version '$Version' too long for the exe slot ($room bytes)" }
    $off = $found + $marker.Length
    for ($k = 0; $k -lt $room + 1; $k++) { $bytes[$off + $k] = 0 }
    [Array]::Copy($val, 0, $bytes, $off, $val.Length)
    [System.IO.File]::WriteAllBytes($ExePath, $bytes)
    Write-Host "Stamped $Version into $(Split-Path -Leaf $ExePath)"
}

$BsStamp = Join-Path $BuildDir "pkg-input.sha256"
$BsArtifactsOk = ((Test-Path (Join-Path $BuildDir "Release\$AppName.exe")) -or (Test-Path (Join-Path $BuildDir "$AppName.exe"))) -and
                 (Test-Path (Join-Path $BuildDir "f3d.o2r")) -and
                 [bool](@("TorchExternal\src\TorchExternal-build\Release\torch.exe", "TorchExternal\src\TorchExternal-build\torch.exe", "torch-install\bin\torch.exe") |
                        Where-Object { Test-Path (Join-Path $BuildDir $_) })
$BsHash = $null
$BsReuse = $false
if (-not $SkipBuild -and -not $ForceBattleShip) {
    Write-Step "Checking whether BattleShip changed"
    $BsHash = Get-BsInputHash
    $BsOld = if (Test-Path $BsStamp) { (Get-Content $BsStamp -Raw).Trim() } else { "" }
    $BsReuse = $BsArtifactsOk -and ($BsOld -eq $BsHash)
    Write-Host ("BattleShip inputs: {0}" -f $(if ($BsReuse) { "UNCHANGED - reusing the previous BattleShip.exe/torch.exe/f3d.o2r (skipping credits, configure, build)" } else { "changed or no previous build - building" }))
}
# Everything BattleShip-side (credits, configure, build, o2r) is skipped when reusing.
$SkipBsBuild = $SkipBuild -or $BsReuse

# ── 0. Run codegen scripts that don't need the ROM ──
# Encoded credit files are gitignored (input text is in decomp/src/credits/),
# so a fresh checkout (CI or otherwise) must run the encoder before
# cmake builds scstaffroll.c. ROM-independent — same step CMake's
# GenerateCreditsAssets target runs.
Write-Step "Encoding credits text"
if (-not $SkipBsBuild) {
Push-Location (Join-Path $Root "decomp/src/credits")
foreach ($f in @("staff.credits.us.txt", "titles.credits.us.txt")) {
    & python "$Root/tools/creditsTextConverter.py" $f | Out-Null
    if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "credits encode failed: $f" }
}
foreach ($f in @("info.credits.us.txt", "companies.credits.us.txt")) {
    & python "$Root/tools/creditsTextConverter.py" -paragraphFont $f | Out-Null
    if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "credits encode failed: $f" }
}
Pop-Location
}

# ── 1. Configure + build (Release, portable) ──
Write-Step "Configuring release build (portable, scripting=$EnableScripting)"
# No NON_PORTABLE, no CMAKE_INSTALL_PREFIX. LUS resolves the bundle path
# via GetModuleFileNameW at runtime, and the port's port_save.cpp +
# Ship::Context::GetAppDirectoryPath() route saves/config to the cwd
# (= BattleShip.exe's directory when launched normally). See the file
# header for the v0.7.2 crash this avoids.
#
# Pin Python3_EXECUTABLE to the same `python` the workflow's
# `pip install Pillow` step ran under. On Windows GHA runners the image
# ships several Python installs (hostedtoolcache, Strawberry Perl, vcpkg,
# Windows Store stub); without a hint, CMake's find_package(Python3) can
# resolve to a different interpreter than the one pip targeted, and the
# CSS-arrow asset rules then fail with "Pillow is required" mid-build.
if (-not $SkipBsBuild) {
$PythonExe = (Get-Command python).Source
Write-Host "Using Python: $PythonExe"
# An existing configured build dir is NOT reconfigured here: `cmake --build` re-runs the configure step
# by itself when any CMakeLists/cmake file or VERSION changed.
if (-not (Test-Path (Join-Path $BuildDir "CMakeCache.txt"))) {
    cmake -B $BuildDir $Root `
        -DCMAKE_BUILD_TYPE=Release `
        "-DDISABLE_SCRIPTING=$DisableScripting" `
        "-DSSB64_VERSION=$Ver" `
        "-DPython3_EXECUTABLE=$PythonExe" `
        | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "cmake configure failed" }
} else {
    Write-Host "Build dir already configured - not reconfiguring"
}

Write-Step "Building BattleShip + torch"
cmake --build $BuildDir --config Release -j $Jobs
if ($LASTEXITCODE -ne 0) { Fail "build failed" }
if (-not $BsHash) { $BsHash = Get-BsInputHash }
Set-Content -Path $BsStamp -Value $BsHash -Encoding ascii
}

# ── 2. Build f3d.o2r (zip of LUS shaders, ROM-independent) ──
Write-Step "Packaging Fast3D shader archive"
$F3DO2R = Join-Path $BuildDir "f3d.o2r"
$ShaderSrc = Join-Path $Root "libultraship\src\fast\shaders"
$F3DStale = (-not (Test-Path $F3DO2R)) -or
    ((Get-ChildItem -Path $ShaderSrc -Recurse -File | Where-Object { $_.LastWriteTimeUtc -gt (Get-Item $F3DO2R).LastWriteTimeUtc } | Select-Object -First 1) -ne $null)
if (-not $SkipBsBuild -and $F3DStale -or -not (Test-Path $F3DO2R)) {
if (Test-Path $F3DO2R) { Remove-Item $F3DO2R -Force }
# Entry names must use forward slashes ("shaders/directx/..."): libultraship
# looks shaders up by those names. Windows PowerShell 5.1's Compress-Archive
# writes backslashes (and rejects a .o2r destination), which ships a release
# whose renderer can't find a single shader.
& (Join-Path $PSScriptRoot "zip-portable.ps1") -Source $ShaderSrc -Destination $F3DO2R -Prefix "shaders/"
}
if (-not (Test-Path $F3DO2R)) { Fail "f3d.o2r was not created" }

# ── 3. Locate built artifacts ──
# CMake OUTPUT_NAME == SSB64_APP_NAME == $AppName, so the exe is
# BattleShip.exe (US) or BattleShip-JP.exe (JP).
$GameExe = Join-Path $BuildDir "Release\$AppName.exe"
if (-not (Test-Path $GameExe)) {
    # Fall back to non-multi-config layout (Ninja).
    $GameExe = Join-Path $BuildDir "$AppName.exe"
}
$TorchExe = $null
foreach ($cand in @(
    "TorchExternal\src\TorchExternal-build\Release\torch.exe",
    "TorchExternal\src\TorchExternal-build\torch.exe",
    "torch-install\bin\torch.exe"
)) {
    $p = Join-Path $BuildDir $cand
    if (Test-Path $p) { $TorchExe = $p; break }
}
if (-not (Test-Path $GameExe))   { Fail "$AppName.exe not found at $GameExe" }
if (-not $TorchExe)              { Fail "torch.exe not found in $BuildDir" }

# ── 4. Stage the release tree ──
Write-Step "Staging $StageDir"
if (Test-Path $StageDir) { Remove-Item -Recurse -Force $StageDir }
New-Item -ItemType Directory -Path $StageDir | Out-Null
New-Item -ItemType Directory -Path (Join-Path $StageDir "yamls\$Ver") | Out-Null

Copy-Item $GameExe        (Join-Path $StageDir "$AppName.exe")
Set-ExeVersion (Join-Path $StageDir "$AppName.exe") ((Get-Content (Join-Path $Root "VERSION") -Raw).Trim())
Copy-Item $TorchExe      (Join-Path $StageDir "torch.exe")
Copy-Item $F3DO2R        (Join-Path $StageDir "f3d.o2r")
Copy-Item (Join-Path $Root "gamecontrollerdb.txt") $StageDir
Copy-Item (Join-Path $Root "config.yml") $StageDir
Copy-Item (Join-Path $Root "yamls\$Ver\*.yml") (Join-Path $StageDir "yamls\$Ver")
# Standalone .ico for shortcut/installer use — the icon is also embedded
# directly in BattleShip.exe via port/ssb64.rc, so Explorer picks it up
# without this file. Keep it bundled for future installer work.
# Region-aware: JP picks assets\icon-jp.ico, US keeps assets\icon.ico.
# (Note: ssb64.rc still embeds assets\icon.ico unconditionally, so the
# .exe's own Explorer-icon is US-art for both regions until that .rc
# is taught to pick per-region — leave for follow-up if needed.)
$IcoSrc = if ($Ver -eq "jp") { Join-Path $Root "assets\icon-jp.ico" }
          else                { Join-Path $Root "assets\icon.ico"   }
Copy-Item $IcoSrc (Join-Path $StageDir "$AppName.ico")

# Bundle the ESC menu fonts. Menu.cpp::FindMenuAssetPath walks up from
# RealAppBundlePath() and from current_path(); placing the TTFs at
# <staging>\assets\custom\fonts\ next to the .exe matches the first
# iteration of the walker rooted at the .exe's directory. Without this
# the menu falls back to ImGui's default font silently.
#
# OFL 1.1 §1 requires the license text to accompany each redistributed
# font file, so the *-OFL.txt files ship alongside the .ttf they govern.
$FontsDir = Join-Path $StageDir "assets\custom\fonts"
New-Item -ItemType Directory -Path $FontsDir -Force | Out-Null
Copy-Item (Join-Path $Root "assets\custom\fonts\Montserrat-Regular.ttf")  $FontsDir
Copy-Item (Join-Path $Root "assets\custom\fonts\Montserrat-OFL.txt")      $FontsDir
Copy-Item (Join-Path $Root "assets\custom\fonts\Inconsolata-Regular.ttf") $FontsDir
Copy-Item (Join-Path $Root "assets\custom\fonts\Inconsolata-OFL.txt")     $FontsDir

# Project LICENSE + verbatim upstream LICENSE files for the submodules
# whose compiled code is in this distribution. MIT requires the upstream
# copyright + permission notice to ride along with redistributed copies.
# .txt suffix follows Windows convention so users can double-click open.
Copy-Item (Join-Path $Root "LICENSE") (Join-Path $StageDir "LICENSE.txt")
$LicensesDir = Join-Path $StageDir "licenses"
New-Item -ItemType Directory -Path $LicensesDir -Force | Out-Null
$LusLicense = Join-Path $Root "libultraship\LICENSE"
$TorchLicense = Join-Path $Root "torch\LICENSE"
if (-not (Test-Path $LusLicense))   { Fail "libultraship\LICENSE not found - submodules not initialized?" }
if (-not (Test-Path $TorchLicense)) { Fail "torch\LICENSE not found - submodules not initialized?" }
Copy-Item $LusLicense   (Join-Path $LicensesDir "libultraship-LICENSE.txt")
Copy-Item $TorchLicense (Join-Path $LicensesDir "torch-LICENSE.txt")
@'
This directory contains license texts for third-party components whose
compiled code is included in this BattleShip distribution:

  - libultraship-LICENSE.txt  (MIT, Copyright (c) 2022 kenix3)
  - torch-LICENSE.txt         (MIT, Copyright (c) 2023 Lywx)

Bundled font licenses (SIL Open Font License 1.1) live alongside the
font files at assets\custom\fonts\.

The BattleShip project's own MIT license is in ..\LICENSE.txt.

Additional libraries dynamically linked at runtime (SDL2, GLEW, libzip,
nlohmann_json, tinyxml2, spdlog, fmt, hidapi-via-libultraship) are
distributed under their respective upstream licenses (zlib, modified
BSD, BSD-3-Clause, MIT). Refer to those upstream packages for full
license texts.
'@ | Set-Content -Path (Join-Path $LicensesDir "README.txt") -Encoding UTF8

# Bundle DLLs that landed next to BattleShip.exe (vcpkg drops SDL2.dll, etc.).
$ExeBuildDir = Split-Path $GameExe -Parent
Get-ChildItem -Path $ExeBuildDir -Filter "*.dll" | ForEach-Object {
    Copy-Item $_.FullName $StageDir
}

# RetroHub (the launcher BattleShip.exe hands off to) + n64run + the
# mupen64plus emulator files for the non-native games. Built from the sibling
# ..\RetroHub checkout; skipped with a warning if it isn't there.
$HubRoot = if ($RetroHubDir) { $RetroHubDir } elseif ($env:RETROHUB_DIR) { $env:RETROHUB_DIR } else { Join-Path (Split-Path $Root -Parent) "RetroHub" }
if (Test-Path (Join-Path $HubRoot "CMakeLists.txt")) {
    Write-Step "Building RetroHub"
    $HubBuild = if ($env:RETROHUB_BUILD_DIR) { $env:RETROHUB_BUILD_DIR } else { Join-Path $HubRoot "build" }
    # RetroHub reports (and its updater compares) the release version, not its own dev number.
    if (-not $SkipBuild) {
    $RelVer = (Get-Content (Join-Path $Root "VERSION") -Raw).Trim()
    $HubVerFile = Join-Path $HubRoot "VERSION"
    # Only write when different (the version files are generated at build time from it; no reconfigure needed).
    if (-not (Test-Path $HubVerFile) -or ((Get-Content $HubVerFile -Raw).Trim() -ne $RelVer)) {
        Set-Content -Path $HubVerFile -Value $RelVer -NoNewline -Encoding ascii
    }
    if (-not (Test-Path (Join-Path $HubBuild "CMakeCache.txt"))) {
        cmake -S $HubRoot -B $HubBuild | Out-Null
        if ($LASTEXITCODE -ne 0) { Fail "RetroHub configure failed" }
    }
    # Only what ships (not the ~75 test executables); `cmake --build` reconfigures by itself if a CMakeLists changed.
    if ($BuildAllHub) {
        cmake --build $HubBuild --config Release -j $Jobs
    } else {
        cmake --build $HubBuild --config Release -j $Jobs --target RetroHub n64run retrorun streamrun mgba_link_libretro sameboy_rb_libretro beetle_psx_libretro
    }
    if ($LASTEXITCODE -ne 0) { Fail "RetroHub build failed" }
    }
    $HubBin = Join-Path $HubBuild "bin\Release"
    Copy-Item (Join-Path $HubBin "RetroHub.exe") $StageDir
    Copy-Item (Join-Path $HubBin "n64run.exe") $StageDir
    Copy-Item (Join-Path $HubBin "retrorun.exe") $StageDir
    # Remote play host/guest. Required: Wii U / stream features break without it.
    $StreamExe = Join-Path $HubBin "streamrun.exe"
    if (-not (Test-Path $StreamExe)) { Fail "streamrun.exe not built (expected $StreamExe)" }
    Copy-Item $StreamExe $StageDir
    # Cheat database + curated featured cheats (read from <exe dir>\data at run time).
    $DataDst = Join-Path $StageDir "data"
    New-Item -ItemType Directory -Path $DataDst -Force | Out-Null
    # Everything in RetroHub data\ ships (new data files are picked up automatically); these must exist.
    foreach ($d in "cheats_db.bin", "cheats_featured.json", "changelog.json", "gameinfo.tsv") {
        if (-not (Test-Path (Join-Path $HubRoot "data\$d"))) { Fail "missing RetroHub data file $d" }
    }
    Copy-Item (Join-Path $HubRoot "data\*") $DataDst -Recurse -Force
    # libretro cores for GBA / GB / GBC / DS / NES / SNES (Nestopia, Snes9x; mGBA MPL-2.0, SameBoy MIT, Gambatte GPL-2.0, melonDS DS GPL-3.0+)
    $CoreSrc = Join-Path $HubRoot "deps\cores"
    $NeedCores = "mgba", "melondsds", "nestopia", "snes9x" | Where-Object { -not (Test-Path (Join-Path $CoreSrc "$($_)_libretro.dll")) }
    if ($NeedCores) {
        # fetch-cores.ps1 verifies nestopia/snes9x against pinned SHA-256 (warns on drift).
        & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $HubRoot "scripts\fetch-cores.ps1")
        if ($LASTEXITCODE -ne 0) { Fail "fetch-cores.ps1 failed" }
    }
    $CoreDst = Join-Path $StageDir "cores"
    New-Item -ItemType Directory -Path (Join-Path $CoreDst "info") -Force | Out-Null
    Get-ChildItem -Path $CoreSrc -File -Filter "*_libretro.dll" | ForEach-Object { Copy-Item $_.FullName $CoreDst }
    # GBA link cable core (N mGBA cores in one libretro DLL, built from source by RetroHub; MPL-2.0).
    $LinkCore = Join-Path $HubBin "cores\mgba_link_libretro.dll"
    if (-not (Test-Path $LinkCore)) { Fail "mgba_link_libretro.dll not built (expected $LinkCore)" }
    Copy-Item $LinkCore $CoreDst -Force
    # GB/GBC rollback core (patched libretro SameBoy, MIT). Built by RetroHub with MinGW gcc (see RetroHub CLAUDE.md);
    # without it GB/GBC netplay silently falls back to lockstep, so fail the package instead.
    $SameBoyRb = Join-Path $HubBin "cores\sameboy_rb_libretro.dll"
    if (-not (Test-Path $SameBoyRb)) { Fail "sameboy_rb_libretro.dll not built (expected $SameBoyRb); build RetroHub with MinGW gcc (see RetroHub CLAUDE.md)" }
    Copy-Item $SameBoyRb $CoreDst -Force
    # Every other core RetroHub builds from source (e.g. beetle_psx_libretro.dll for PS1, MinGW).
    Get-ChildItem -Path (Join-Path $HubBin "cores") -File -Filter "*_libretro.dll" | ForEach-Object { Copy-Item $_.FullName $CoreDst -Force }
    if (-not (Test-Path (Join-Path $CoreDst "beetle_psx_libretro.dll"))) { Fail "beetle_psx_libretro.dll not built (PS1); build RetroHub with MinGW gcc" }
    foreach ($c in "nestopia_libretro.dll", "snes9x_libretro.dll") {
        if (-not (Test-Path (Join-Path $CoreDst $c))) { Fail "$c missing from cores (NES/SNES)" }
    }
    Get-ChildItem -Path (Join-Path $CoreSrc "info") -File -Filter "*.info" -ErrorAction SilentlyContinue | ForEach-Object { Copy-Item $_.FullName (Join-Path $CoreDst "info") }
    Copy-Item (Join-Path $HubBin "SDL2.dll") $StageDir -Force

    $EmuSrc = Join-Path $HubRoot "deps\emu"
    if (-not (Test-Path (Join-Path $EmuSrc "mupen64plus.dll"))) {
        & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $HubRoot "scripts\fetch-emu.ps1")
    }
    $EmuDst = Join-Path $StageDir "emu"
    New-Item -ItemType Directory -Path $EmuDst -Force | Out-Null
    # Files only (skip the _downloads/_m64p/_gliden64 extraction dirs). SDL2.dll
    # is shared with the copy next to n64run.exe, so it isn't duplicated here.
    Get-ChildItem -Path $EmuSrc -File | Where-Object { $_.Name -ne "SDL2.dll" } | ForEach-Object {
        Copy-Item $_.FullName $EmuDst
    }
    # The hub exes and the official mupen64plus DLLs use the shared MSVC
    # runtime; ship it app-local (redistributable) so no VC++ installer is needed.
    $CrtDir = Get-ChildItem "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Redist\MSVC" -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending | ForEach-Object { Get-ChildItem (Join-Path $_.FullName "x64") -Directory -Filter "Microsoft.VC*.CRT" -ErrorAction SilentlyContinue } |
        Select-Object -First 1
    if ($CrtDir) {
        foreach ($dll in @("msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll")) {
            Copy-Item (Join-Path $CrtDir.FullName $dll) $StageDir -Force
            Copy-Item (Join-Path $CrtDir.FullName $dll) $EmuDst -Force
        }
    } else {
        Write-Host "WARNING: MSVC redist CRT not found - players may need the VC++ runtime" -ForegroundColor Yellow
    }
    $M64pLicenses = Join-Path $HubBuild "_deps\m64p_core-src\LICENSES"
    if (Test-Path $M64pLicenses) { Copy-Item $M64pLicenses (Join-Path $LicensesDir "mupen64plus-LICENSES.txt") }
    @'
emu\ contains unmodified official binaries of:

  - mupen64plus 2.6.0 (core, rsp-hle, audio-sdl)  GPL-2.0-or-later
      source: https://github.com/mupen64plus  (tag 2.6.0)
  - GLideN64 (mupen64plus video plugin, build a04081a)  GPL-2.0-or-later
      source: https://github.com/gonetz/GLideN64

They are loaded at runtime by n64run.exe through the mupen64plus plugin API.
The full license text is in mupen64plus-LICENSES.txt.

cores\ contains unmodified libretro cores loaded by retrorun.exe:

  - mGBA (MPL-2.0), SameBoy (MIT), Gambatte (GPL-2.0)
  - Nestopia UE (GPL-2.0) NES  source: https://github.com/libretro/nestopia
  - Snes9x (non-commercial license) SNES  source: https://github.com/libretro/snes9x
  - mgba_link_libretro (mGBA 0.10.5 built from source, MPL-2.0)  source: https://github.com/mgba-emu/mgba
  - sameboy_rb_libretro (SameBoy MIT, libretro fork with a rollback determinism patch)  source: https://github.com/libretro/SameBoy
  - melonDS DS (GPL-3.0-or-later)  source: https://github.com/JesseTG/melonds-ds
'@ | Set-Content -Path (Join-Path $LicensesDir "emulator-README.txt") -Encoding UTF8
} else {
    Write-Host "WARNING: ..\RetroHub not found - packaging without RetroHub" -ForegroundColor Yellow
}

if ($EnableScripting) {
    Write-Step "Staging TCC scripting runtime"
    $TccDir = Join-Path $ExeBuildDir ".tcc"
    if (-not (Test-Path $TccDir)) { Fail ".tcc scripting runtime not found at $TccDir" }
    Copy-Item $TccDir (Join-Path $StageDir ".tcc") -Recurse -Force
    $TccPeFiles = Get-ChildItem -Path (Join-Path $StageDir ".tcc") -Recurse -File |
        Where-Object { $_.Extension -in @(".dll", ".exe") }
    if ($TccPeFiles) {
        $Names = ($TccPeFiles | ForEach-Object { $_.FullName }) -join "`n"
        Fail ".tcc scripting runtime contains PE executables:`n$Names"
    }
}

# ── 5. Zip ──
Write-Step "Compressing $ZipPath"
if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }
& (Join-Path $PSScriptRoot "zip-portable.ps1") -Source $StageDir -Destination $ZipPath -Level $ZipLevel
if (-not (Test-Path $ZipPath)) { Fail "zip was not created" }

# ── 6. Setup exe (Inno Setup 6) from the same staged files ──
# US only: RetroHub-Setup.exe is the RetroHub installer. Requires Inno Setup 6:
#   winget install --id JRSoftware.InnoSetup -e --silent
# Set SKIP_INSTALLER=1 to skip.
$SetupPath = $null
$Iscc = $null
if ($Ver -eq "us" -and $env:SKIP_INSTALLER -ne "1") {
    Write-Step "Building RetroHub-Setup.exe"
    $Iscc = @(
        $env:ISCC,
        "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
        "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
        "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
    ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
    if (-not $Iscc) {
        Write-Host "WARNING: Inno Setup 6 not found - skipping RetroHub-Setup.exe (winget install --id JRSoftware.InnoSetup -e)" -ForegroundColor Yellow
    }
}
if ($Iscc) {
    $AppVer = (Get-Content (Join-Path $Root "VERSION") -Raw).Trim().TrimStart('v','V')
    & $Iscc "/Qp" "/DSourceDir=$StageDir" "/DAppVersion=$AppVer" "/DOutputDir=$DistDir" "/DSetupCompression=$SetupCompression" (Join-Path $Root "installer\RetroHub.iss")
    if ($LASTEXITCODE -ne 0) { Fail "ISCC failed" }
    $SetupPath = Join-Path $DistDir "RetroHub-Setup.exe"
    if (-not (Test-Path $SetupPath)) { Fail "RetroHub-Setup.exe was not created" }
    Write-Host "Setup ready: $SetupPath" -ForegroundColor Green
}

# ── 7. SHA256SUMS.txt: the in-app updater (RetroHub src/hub/updater.cpp) verifies the zip against this ──
# Upload it as a release asset next to the zip and the setup exe. Format: "<sha256>  <file name>" per line,
# lowercase hex, LF endings, no BOM (sha256sum -c compatible). JP gets its own file name so variants never collide.
Write-Step "Writing checksums"
$SumsPath = Join-Path $DistDir $(if ($Ver -eq "jp") { "SHA256SUMS-JP.txt" } else { "SHA256SUMS.txt" })
$SumLines = foreach ($f in @($ZipPath, $SetupPath)) {
    if ($f -and (Test-Path $f)) {
        $h = (Get-FileHash -Algorithm SHA256 -LiteralPath $f).Hash.ToLower()
        "$h  $(Split-Path -Leaf $f)"
    }
}
[System.IO.File]::WriteAllText($SumsPath, (($SumLines -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Checksums ready: $SumsPath" -ForegroundColor Green
$SumLines | ForEach-Object { Write-Host "   $_" }

$ZipKB = [int]((Get-Item $ZipPath).Length / 1024)
Show-Timings
Write-Host "`nRelease zip ready: $ZipPath ($ZipKB KB)" -ForegroundColor Green
Write-Host "   Portable: extract anywhere; save data lives next to BattleShip.exe."
if ($EnableScripting) {
    Write-Host "   Includes TCC scripting support for C mods."
} else {
    Write-Host "   TCC scripting disabled for this local/package variant."
}
Write-Host "   First launch will prompt for your ROM via the ImGui wizard."
