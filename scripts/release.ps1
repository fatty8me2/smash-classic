# One command for a whole Smash Classic / RetroHub release.
#
#   .\scripts\release.ps1 -Version 1.27.3                 # bump, package (fast path), commit, push, publish both GitHub releases
#   .\scripts\release.ps1 -Version 1.27.3 -DryRun         # everything except commit/push/release/deploy (scratch output dir)
#   .\scripts\release.ps1 -Version 1.27.3 -DeployWorker   # also `wrangler deploy` the netplay Worker before the releases
#   .\scripts\release.ps1 -Version 1.27.3 -Notes notes.md # custom release notes (file path or literal text)
#
# Steps:
#   1. Preflight: version format, changelog entry exists, gh authenticated, repos on the expected branches
#      and clean (apart from VERSION), local branches fast-forward of their remotes.
#   2. Bump BattleShip\VERSION and RetroHub\VERSION to vX.Y.Z.
#   3. scripts\package-windows.ps1 (fast path: unchanged BattleShip is not rebuilt, only shipped RetroHub
#      targets are built, fast zip/installer compression) -> BattleShip-windows.zip, RetroHub-Setup.exe, SHA256SUMS.txt.
#   4. Commit VERSION in both repos ("vX.Y.Z").
#   5. Push: decomp  fatty HEAD:smash-classic ; BattleShip  fatty rollback-synctest:main ; RetroHub  origin main.
#   6. (-DeployWorker) deploy the Cloudflare Worker.
#   7. gh release create vX.Y.Z on fatty8me2/smash-classic and fatty8me2/retrohub (--latest) with the same three
#      assets and the notes from RetroHub\scripts\release_notes.ps1 (newest data\changelog.json entry for that version).
#
# -DryRun never commits, pushes, deploys or creates releases; it restores both VERSION files afterwards and writes the
# assets to a scratch directory so the real dist\ folder is left alone.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Version,
    [string]$Notes = "",                 # release notes: path to a .md file, or literal Markdown. Default: changelog.json entry.
    [switch]$DryRun,
    [switch]$DeployWorker,
    [string]$OutDir = "",                # asset output dir (default: <BattleShip>\dist, or a scratch dir for -DryRun)
    [string]$RetroHubDir = "",           # default: sibling ..\RetroHub
    [string]$BattleShipBranch = "rollback-synctest",
    [string]$RetroHubBranch = "main",    # branch pushed to RetroHub origin
    [switch]$AllowDirty,                 # permit uncommitted changes other than VERSION (they are packaged but NOT committed)
    [switch]$ForceBattleShip,            # passed to package-windows.ps1
    [switch]$SkipPackage                 # reuse assets already in OutDir (e.g. after a failed push); still bumps/commits/pushes
)
$ErrorActionPreference = "Continue"   # native tools write progress to stderr; every call checks $LASTEXITCODE explicitly
$sw = [System.Diagnostics.Stopwatch]::StartNew()

$Root = Split-Path -Parent $PSScriptRoot
$Hub = if ($RetroHubDir) { $RetroHubDir } else { Join-Path (Split-Path $Root -Parent) "RetroHub" }
$Decomp = Join-Path $Root "decomp"
$Tag = "v" + $Version.TrimStart('v', 'V')
$Bare = $Tag.Substring(1)
$BsRepo = "fatty8me2/smash-classic"
$HubRepo = "fatty8me2/retrohub"

function Step($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }
function Die($m) { Write-Host "ERROR: $m" -ForegroundColor Red; exit 1 }
function Run([string]$what, [scriptblock]$b) {
    if ($DryRun) { Write-Host "[dry-run] would: $what" -ForegroundColor Yellow } else { Write-Host "> $what"; & $b; if ($LASTEXITCODE -ne 0) { Die "$what failed (exit $LASTEXITCODE)" } }
}
function GitC($repo) { $a = @($args); $ErrorActionPreference = "Continue"; $o = & git -C $repo @a 2>&1; if ($LASTEXITCODE -ne 0) { Die "git -C $repo $($a -join ' ') failed: $o" }; return ($o | Out-String).Trim() }

if ($Bare -notmatch '^\d+\.\d+\.\d+$') { Die "-Version must look like 1.27.3 (got '$Version')" }
if (-not (Test-Path (Join-Path $Hub "CMakeLists.txt"))) { Die "RetroHub checkout not found at $Hub" }

# ── 1. Preflight ──
Step "Preflight ($Tag$(if ($DryRun) { ', DRY RUN' }))"
& gh auth status *> $null
if ($LASTEXITCODE -ne 0) { Die "gh is not authenticated (run: gh auth login)" }

$NotesScript = Join-Path $Hub "scripts\release_notes.ps1"
$NotesFile = Join-Path ([System.IO.Path]::GetTempPath()) "release-notes-$Tag.md"
if ($Notes) {
    $text = if (Test-Path -LiteralPath $Notes) { Get-Content -Raw -Encoding UTF8 -LiteralPath $Notes } else { $Notes }
} else {
    # Throws (exit 1) when data\changelog.json has no entry for this version: write the changelog first.
    $text = (& powershell -NoProfile -ExecutionPolicy Bypass -File $NotesScript -Version $Bare) -join "`n"
    if ($LASTEXITCODE -ne 0 -or -not $text) { Die "no changelog entry for $Bare in $Hub\data\changelog.json (add it and commit, or pass -Notes)" }
}
[System.IO.File]::WriteAllText($NotesFile, $text.TrimEnd() + "`n", (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Release notes ($NotesFile):"; Get-Content $NotesFile | Select-Object -First 12 | ForEach-Object { Write-Host "   $_" }

$bsBranch = GitC $Root rev-parse --abbrev-ref HEAD
$hubBranch = GitC $Hub rev-parse --abbrev-ref HEAD
if ($bsBranch -ne $BattleShipBranch) { Die "BattleShip is on '$bsBranch', expected '$BattleShipBranch' (use -BattleShipBranch)" }
if ($hubBranch -ne $RetroHubBranch) { Die "RetroHub is on '$hubBranch', expected '$RetroHubBranch' (use -RetroHubBranch)" }
if (-not $AllowDirty) {
    foreach ($r in @($Root, $Hub)) {
        $dirty = (GitC $r status --porcelain --ignore-submodules=dirty) -split "`n" | Where-Object { $_ -and $_ -notmatch '^\s*M\s+VERSION$' -and $_ -notmatch '^\?\? (dist|build)' }
        if ($dirty) { Die "$r has uncommitted changes (commit them or pass -AllowDirty):`n$($dirty -join "`n")" }
    }
}
# The pushes must fast-forward: fetch and check before spending time on a build.
GitC $Root fetch fatty main | Out-Null
GitC $Hub fetch origin main | Out-Null
& git -C $Root merge-base --is-ancestor fatty/main HEAD
if ($LASTEXITCODE -ne 0) { if ($DryRun) { Write-Host "WARNING: fatty/main has commits that $BattleShipBranch lacks (a real run would stop here)" -ForegroundColor Yellow } else { Die "fatty/main has commits that $BattleShipBranch lacks (merge/rebase first)" } }
& git -C $Hub merge-base --is-ancestor origin/main HEAD
if ($LASTEXITCODE -ne 0) { if ($DryRun) { Write-Host "WARNING: origin/main has commits that RetroHub $RetroHubBranch lacks (a real run would stop here)" -ForegroundColor Yellow } else { Die "origin/main has commits that RetroHub $RetroHubBranch lacks (pull first)" } }
foreach ($pair in @(@($BsRepo, "BattleShip"), @($HubRepo, "RetroHub"))) {
    & gh release view $Tag -R $pair[0] *> $null
    if ($LASTEXITCODE -eq 0) { Die "release $Tag already exists on $($pair[0])" }
}

# ── 2. Bump VERSION in both repos ──
Step "Bumping VERSION to $Tag"
$verFiles = @((Join-Path $Root "VERSION"), (Join-Path $Hub "VERSION"))
foreach ($f in $verFiles) {
    $old = if (Test-Path $f) { [System.IO.File]::ReadAllText($f) } else { "" }
    $nl = if ($old.EndsWith("`n")) { "`n" } else { "" }
    [System.IO.File]::WriteAllText($f, $Tag + $nl, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "$f -> $Tag"
}
function Restore-Versions { foreach ($pair in @(@($Root, "VERSION"), @($Hub, "VERSION"))) { & git -C $pair[0] checkout -- $pair[1] 2>$null } }

# ── 3. Package (fast path) ──
$Dist = if ($OutDir) { $OutDir } elseif ($DryRun) { Join-Path ([System.IO.Path]::GetTempPath()) "release-dryrun-$Tag" } else { Join-Path $Root "dist" }
$assets = @("BattleShip-windows.zip", "RetroHub-Setup.exe", "SHA256SUMS.txt") | ForEach-Object { Join-Path $Dist $_ }
try {
    if (-not $SkipPackage) {
        Step "Packaging into $Dist"
        $pkgArgs = @{ OutDir = $Dist; RetroHubDir = $Hub }
        if ($ForceBattleShip) { $pkgArgs.ForceBattleShip = $true }
        & (Join-Path $PSScriptRoot "package-windows.ps1") @pkgArgs
        if ($LASTEXITCODE -ne 0) { throw "package-windows.ps1 failed (exit $LASTEXITCODE)" }
    }
    foreach ($a in $assets) { if (-not (Test-Path $a)) { throw "missing release asset $a" } }
    # Verify the checksums file against the files we are about to upload.
    foreach ($line in (Get-Content (Join-Path $Dist "SHA256SUMS.txt"))) {
        if ($line -match '^([0-9a-f]{64})  (.+)$') {
            $h = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $Dist $Matches[2])).Hash.ToLower()
            if ($h -ne $Matches[1]) { throw "SHA256SUMS mismatch for $($Matches[2])" }
        }
    }
} catch {
    Restore-Versions
    Die "$_ (VERSION files restored)"
}

if ($DryRun) {
    Step "Dry run: nothing is committed, pushed, deployed or published"
    $shaBs = GitC $Root rev-parse --short HEAD
    $shaHub = GitC $Hub rev-parse --short HEAD
    Run "git -C $Root commit VERSION -m $Tag" {}
    Run "git -C $Hub commit VERSION -m $Tag" {}
    Run "git -C $Decomp push fatty HEAD:smash-classic" {}
    Run "git -C $Root push fatty ${BattleShipBranch}:main" {}
    Run "git -C $Hub push origin ${RetroHubBranch}:main" {}
    if ($DeployWorker) {
        Push-Location (Join-Path $Root "server\cloudflare"); try { & npx wrangler deploy --dry-run; if ($LASTEXITCODE -ne 0) { Write-Host "wrangler dry-run failed" -ForegroundColor Yellow } } finally { Pop-Location }
    }
    Run "gh release create $Tag -R $BsRepo --target main --title $Tag -F $NotesFile <3 assets>" {}
    Run "gh release create $Tag -R $HubRepo --target main --title $Tag --latest -F $NotesFile <3 assets>" {}
    Restore-Versions
    Write-Host "VERSION files restored. Assets for inspection: $Dist" -ForegroundColor Green
    Write-Host ("Dry run complete in {0:N0}s" -f $sw.Elapsed.TotalSeconds) -ForegroundColor Green
    exit 0
}

# ── 4. Commit VERSION in both repos (only VERSION, whatever else is staged) ──
Step "Committing VERSION"
foreach ($r in @($Root, $Hub)) {
    GitC $r add VERSION | Out-Null
    GitC $r commit -m $Tag -- VERSION | Out-Null
    Write-Host "$r -> $(GitC $r rev-parse --short HEAD)"
}

# ── 5. Push ──
Step "Pushing"
Run "git -C $Decomp push fatty HEAD:smash-classic" { & git -C $Decomp push fatty HEAD:smash-classic }
Run "git -C $Root push fatty ${BattleShipBranch}:main" { & git -C $Root push fatty "${BattleShipBranch}:main" }
Run "git -C $Hub push origin ${RetroHubBranch}:main" { & git -C $Hub push origin "${RetroHubBranch}:main" }

# ── 6. Worker ──
if ($DeployWorker) {
    Step "Deploying the Cloudflare Worker"
    Push-Location (Join-Path $Root "server\cloudflare")
    try { & npx wrangler deploy; if ($LASTEXITCODE -ne 0) { Die "wrangler deploy failed (commits are already pushed; assets are in $Dist)" } } finally { Pop-Location }
}

# ── 7. GitHub releases (same three assets on both repos) ──
Step "Creating GitHub releases"
$title = $Tag
& gh release create $Tag @assets -R $BsRepo --target main --title $title -F $NotesFile
if ($LASTEXITCODE -ne 0) { Die "gh release create failed for $BsRepo (retry with: gh release create $Tag <assets> -R $BsRepo)" }
& gh release create $Tag @assets -R $HubRepo --target main --title $title --latest -F $NotesFile
if ($LASTEXITCODE -ne 0) { Die "gh release create failed for $HubRepo (retry with: gh release create $Tag <assets> -R $HubRepo --latest)" }

Write-Host ("`nReleased $Tag on both repos in {0:N0}s" -f $sw.Elapsed.TotalSeconds) -ForegroundColor Green
Write-Host "   https://github.com/$BsRepo/releases/tag/$Tag"
Write-Host "   https://github.com/$HubRepo/releases/tag/$Tag"
