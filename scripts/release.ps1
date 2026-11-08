# One command for a whole RetroHub release.
#
#   .\scripts\release.ps1 -Version 1.27.3                 # bump, build+test, package, DRAFT release, verify, push, publish
#   .\scripts\release.ps1 -Version 1.27.3 -DryRun         # everything except push/release/deploy (scratch output dir, simulated GitHub)
#   .\scripts\release.ps1 -Version 1.27.3 -DeployWorker   # also `wrangler deploy` the netplay Worker (just before publishing)
#   .\scripts\release.ps1 -Version 1.27.3 -Notes notes.md # custom release notes (file path or literal text)
#   .\scripts\release.ps1 -Version 1.27.3 -AlsoSmashClassic  # RARE: also publish to fatty8me2/smash-classic (Smash Classic's own releases)
#
# Releases go to fatty8me2/retrohub ONLY (the updater reads that repo since v1.27.3). smash-classic only gets
# Smash Classic's own releases, via -AlsoSmashClassic.
#
# Order (nothing public changes until the last step; every failure prints the exact state and the undo commands):
#   1. Preflight: version format, changelog entry, gh auth, branches clean and fast-forward, no existing release/draft.
#   2. Bump BattleShip\VERSION and RetroHub\VERSION to vX.Y.Z.
#   3. TEST GATE: build RetroHub, then `ctest -LE online` with RETROHUB_QA=1. Failure stops here (nothing packaged).
#   4. scripts\package-windows.ps1 -> assets + SHA256SUMS.txt. SHA256SUMS must be non-empty, well formed, list the required
#      assets, and match the files. Every file it names (plus SHA256SUMS.txt and its REQUIRED .sig, verified with openssl against the release public key) is uploaded.
#   5. Commit VERSION in both repos, tag the RetroHub commit locally.
#   6. Create the GitHub release as a DRAFT with all assets, then download every asset back and verify its SHA-256.
#   7. Push RetroHub main + the tag, then decomp, then the BattleShip VERSION commit.
#   8. (-DeployWorker) deploy the Worker.
#   9. Publish the draft (retrohub as --latest).
#
# -DryRun never commits, pushes, deploys or touches GitHub: those calls are simulated against a scratch folder (so the
# download-back verification still runs). It restores both VERSION files afterwards.
# Test hooks: -CmakeBin <dir with cmake/ctest>, env RELEASE_DRYRUN_FAULT = "corrupt:<asset>" | "drop:<asset>" (dry run only).
[CmdletBinding()]
param(
    [switch]$AlsoSmashClassic,       # RARE: also publish to fatty8me2/smash-classic (only for Smash Classic's own releases)
    [Parameter(Mandatory = $true)][string]$Version,
    [string]$Notes = "",                 # release notes: path to a .md file, or literal Markdown. Default: changelog.json entry.
    [switch]$DryRun,
    [switch]$DeployWorker,
    [string]$OutDir = "",                # asset output dir (default: <BattleShip>\dist, or a scratch dir for -DryRun)
    [string]$RetroHubDir = "",           # default: sibling ..\RetroHub
    [string]$BattleShipBranch = "rollback-synctest",
    [string]$RetroHubBranch = "main",    # branch pushed to RetroHub origin
    [string]$CmakeBin = "C:\Program Files\Microsoft Visual Studio\18\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin",
    [string]$OpenSsl = "C:\Program Files\Git\usr\bin\openssl.exe",
    [string]$SigPubKey = "C:\Users\fatty\.retrohub-release\release-signing-pub.pem",   # PUBLIC key only; this script never touches the private key
    [switch]$AllowDirty,              # permit uncommitted changes other than VERSION (they are packaged but NOT committed)
    [switch]$ForceBattleShip,            # passed to package-windows.ps1
    [switch]$SkipPackage                 # reuse assets already in OutDir; the test gate still runs
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
$RequiredAssets = @("RetroHub-Setup.exe", "BattleShip-windows.zip", "SHA256SUMS.txt", "SHA256SUMS.txt.sig")

$script:bumped = $false
$script:committed = $false
$script:done = New-Object System.Collections.ArrayList     # human-readable list of completed steps
$script:undo = New-Object System.Collections.ArrayList      # commands that undo them (in the order to run)
$script:remote = ""                                         # dry-run simulated GitHub store

function Step($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }
$script:origVersion = @{}   # path -> original bytes (or $null if the file did not exist), saved before the bump
function Restore-Versions {   # writes the saved bytes back, so an uncommitted VERSION edit survives
    foreach ($p in @($script:origVersion.Keys)) {
        if ($null -eq $script:origVersion[$p]) { Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue }
        else { [System.IO.File]::WriteAllBytes($p, [byte[]]$script:origVersion[$p]) }
    }
}
function Die($m) {
    Write-Host "ERROR: $m" -ForegroundColor Red
    if ($script:bumped -and -not $script:committed) { Restore-Versions; Write-Host "(VERSION files restored; nothing was committed)" -ForegroundColor Yellow }
    if ($script:done.Count -gt 0) {
        Write-Host "`nState at failure (completed steps):" -ForegroundColor Yellow
        $script:done | ForEach-Object { Write-Host "   - $_" }
        Write-Host "Nothing is published as Latest unless the last line above says 'published'." -ForegroundColor Yellow
    }
    if ($script:undo.Count -gt 0) {
        Write-Host "`nTo undo (run in this order), or fix the problem and finish by hand:" -ForegroundColor Yellow
        $script:undo | ForEach-Object { Write-Host "   $_" }
    }
    exit 1
}
function Run([string]$what, [scriptblock]$b) {
    if ($DryRun) { Write-Host "[dry-run] would: $what" -ForegroundColor Yellow } else { Write-Host "> $what"; & $b; if ($LASTEXITCODE -ne 0) { Die "$what failed (exit $LASTEXITCODE)" } }
}
function GitC($repo) { $a = @($args); $ErrorActionPreference = "Continue"; $o = & git -C $repo @a 2>&1; if ($LASTEXITCODE -ne 0) { Die "git -C $repo $($a -join ' ') failed: $o" }; return ($o | Out-String).Trim() }
function Sha($p) { return (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower() }

# ── SHA256SUMS: strict parse + verify. Returns ordered name->hash for every file to upload. ──
function Get-ExpectedAssets([string]$dist) {
    $f = Join-Path $dist "SHA256SUMS.txt"
    if (-not (Test-Path -LiteralPath $f)) { throw "SHA256SUMS.txt is missing from $dist" }
    $map = [ordered]@{}
    foreach ($line in (Get-Content -LiteralPath $f)) {
        if (-not $line.Trim()) { continue }
        if ($line.TrimStart().StartsWith('#')) { continue }   # signed marker comment (e.g. "# retrohub-only smash-sha256 <hash> smash-since vX.Y.Z"); covered by the .sig
        if ($line -notmatch '^([0-9a-fA-F]{64}) [ *](.+?)\s*$') { throw "SHA256SUMS.txt has a malformed line: '$line'" }
        $n = $Matches[2]
        if ($n -match '[\\/]' -or $n -like "SHA256SUMS.txt*") { throw "SHA256SUMS.txt names an unexpected file: '$n'" }
        $map[$n] = $Matches[1].ToLower()
    }
    if ($map.Count -eq 0) { throw "SHA256SUMS.txt is empty" }
    foreach ($req in $RequiredAssets) { if ($req -ne "SHA256SUMS.txt" -and $req -ne "SHA256SUMS.txt.sig" -and -not $map.Contains($req)) { throw "SHA256SUMS.txt does not list required asset $req" } }
    foreach ($n in @($map.Keys)) {
        $p = Join-Path $dist $n
        if (-not (Test-Path -LiteralPath $p)) { throw "SHA256SUMS.txt lists $n but the file is missing from $dist" }
        if ((Sha $p) -ne $map[$n]) { throw "SHA256SUMS mismatch for $n" }
    }
    # Signed releases: updated clients refuse unsigned updates, so the .sig is REQUIRED and must verify.
    $sig = Join-Path $dist "SHA256SUMS.txt.sig"
    if (-not (Test-Path -LiteralPath $sig)) { throw "SHA256SUMS.txt.sig is missing (releases must be signed; run package-windows.ps1 with the signing key available)" }
    if ((Get-Item -LiteralPath $sig).Length -eq 0) { throw "SHA256SUMS.txt.sig is empty" }
    if (-not (Test-Path -LiteralPath $OpenSsl)) { throw "openssl not found at $OpenSsl (needed to verify the signature)" }
    if (-not (Test-Path -LiteralPath $SigPubKey)) { throw "release signing public key not found at $SigPubKey" }
    $vo = & $OpenSsl dgst -sha256 -verify $SigPubKey -signature $sig $f 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0 -or $vo -notmatch 'Verified OK') { throw "SHA256SUMS.txt.sig does NOT verify against $SigPubKey : $($vo.Trim())" }
    Write-Host "SHA256SUMS.txt.sig verified OK"
    $map["SHA256SUMS.txt"] = Sha $f
    $map["SHA256SUMS.txt.sig"] = Sha $sig
    return $map
}

# ── GitHub helpers. Reads are real even in a dry run; every mutation is simulated there. ──
function Find-Release([string]$repo) {   # returns release id (drafts included) or $null
    # No double quotes inside --jq (Windows PowerShell 5.1 strips them from native args): filter by tag here instead.
    $o = & gh api "repos/$repo/releases?per_page=100" --paginate --jq '.[] | [.id, .tag_name] | @tsv' 2>&1
    if ($LASTEXITCODE -ne 0) { Die "could not list releases of $repo : $o" }
    foreach ($l in @($o)) { $p = "$l" -split "`t"; if ($p.Count -ge 2 -and $p[1] -eq $Tag) { return $p[0] } }
    return $null
}
function New-DraftRelease([string]$repo, [string[]]$files) {
    if ($DryRun) {
        $d = Join-Path $script:remote ($repo -replace '/', '_'); New-Item -ItemType Directory -Force $d | Out-Null
        $fault = [string]$env:RELEASE_DRYRUN_FAULT
        foreach ($f in $files) {
            $n = Split-Path $f -Leaf
            if ($fault -eq "drop:$n") { Write-Host "[dry-run] FAULT: dropping $n" -ForegroundColor Yellow; continue }
            Copy-Item -LiteralPath $f -Destination (Join-Path $d $n) -Force
            if ($fault -eq "corrupt:$n") { Add-Content -LiteralPath (Join-Path $d $n) -Value ([byte[]]@(120)) -Encoding Byte; Write-Host "[dry-run] FAULT: corrupting $n" -ForegroundColor Yellow }
        }
        Write-Host "[dry-run] would: gh release create $Tag -R $repo --draft --target main --title $Tag -F $NotesFile <$($files.Count) assets>" -ForegroundColor Yellow
        return "DRY-$($repo -replace '/', '_')"
    }
    & gh release create $Tag @files -R $repo --draft --target main --title $Tag -F $NotesFile
    if ($LASTEXITCODE -ne 0) { return $null }
    return (Find-Release $repo)
}
function Get-RemoteAssets([string]$repo, [string]$id) {   # -> @{ name = @{id=..; size=..} }
    $m = @{}
    if ($DryRun) {
        $d = Join-Path $script:remote ($repo -replace '/', '_')
        Get-ChildItem -LiteralPath $d -File | ForEach-Object { $m[$_.Name] = @{ id = $_.Name; size = $_.Length } }
        return $m
    }
    $o = & gh api "repos/$repo/releases/$id" --jq '.assets[] | [.id, .name, .size] | @tsv' 2>&1
    if ($LASTEXITCODE -ne 0) { throw "could not list assets of the draft on $repo : $o" }
    foreach ($l in @($o)) { $p = "$l" -split "`t"; if ($p.Count -ge 3) { $m[$p[1]] = @{ id = $p[0]; size = [int64]$p[2] } } }
    return $m
}
function Save-RemoteAsset([string]$repo, $asset, [string]$name, [string]$dest) {
    if ($DryRun) { Copy-Item -LiteralPath (Join-Path (Join-Path $script:remote ($repo -replace '/', '_')) $name) -Destination $dest -Force; return }
    $cmd = "gh api -H `"Accept: application/octet-stream`" repos/$repo/releases/assets/$($asset.id) > `"$dest`""
    & cmd /c $cmd
    if ($LASTEXITCODE -ne 0) { throw "download of $name from $repo failed" }
}
function Confirm-Remote([string]$repo, [string]$id, $expected) {
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("release-verify-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force $tmp | Out-Null
    try {
        $have = Get-RemoteAssets $repo $id
        foreach ($n in $expected.Keys) {
            if (-not $have.ContainsKey($n)) { throw "asset $n is missing from the draft on $repo" }
            $dest = Join-Path $tmp $n
            Save-RemoteAsset $repo $have[$n] $n $dest
            $h = Sha $dest
            if ($h -ne $expected[$n]) { throw "asset $n on $repo does not match: uploaded $h, expected $($expected[$n])" }
            Write-Host ("   verified {0}  {1}" -f $expected[$n].Substring(0, 12), $n)
        }
    } finally { Remove-Item -Recurse -Force -LiteralPath $tmp -ErrorAction SilentlyContinue }
}
function Publish-Release([string]$repo, [string]$id, [bool]$latest) {
    $l = if ($latest) { "true" } else { "false" }
    if ($DryRun) { Write-Host "[dry-run] would: publish draft on $repo (draft=false, make_latest=$l)" -ForegroundColor Yellow; return }
    & gh api -X PATCH "repos/$repo/releases/$id" -F draft=false -f make_latest=$l | Out-Null
    if ($LASTEXITCODE -ne 0) { Die "publishing the draft on $repo failed" }
}

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
$targets = @(@{ repo = $HubRepo; latest = $true })
if ($AlsoSmashClassic) { $targets += @{ repo = $BsRepo; latest = $false } }
foreach ($t in $targets) {
    if (Find-Release $t.repo) { Die "release (or draft) $Tag already exists on $($t.repo)" }
}
if (-not $DryRun) {
    & git -C $Hub rev-parse -q --verify "refs/tags/$Tag" *> $null
    if ($LASTEXITCODE -eq 0) { Die "tag $Tag already exists in $Hub" }
}

# ── 2. Bump VERSION in both repos ──
Step "Bumping VERSION to $Tag"
$verFiles = @((Join-Path $Root "VERSION"), (Join-Path $Hub "VERSION"))
foreach ($f in $verFiles) {
    $script:origVersion[$f] = if (Test-Path -LiteralPath $f) { [System.IO.File]::ReadAllBytes($f) } else { $null }
    $old =if (Test-Path $f) { [System.IO.File]::ReadAllText($f) } else { "" }
    $nl = if ($old.EndsWith("`n")) { "`n" } else { "" }
    [System.IO.File]::WriteAllText($f, $Tag + $nl, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "$f -> $Tag"
}
$script:bumped = $true

# ── 3. Test gate: build, then the offline tests. A failure stops everything before packaging. ──
Step "Test gate: build + ctest -LE online (RETROHUB_QA=1)"
$cmakeExe = Join-Path $CmakeBin "cmake.exe"; $ctestExe = Join-Path $CmakeBin "ctest.exe"
if (-not (Test-Path -LiteralPath $cmakeExe)) { $cmakeExe = "cmake" }
if (-not (Test-Path -LiteralPath $ctestExe)) { $ctestExe = "ctest" }
$env:PATH = "$CmakeBin;C:\msys64\mingw64\bin;$env:PATH"
$env:RETROHUB_QA = "1"; $env:SSB64_MUTE = "1"; $env:RETRORUN_MUTE = "1"; $env:N64RUN_MUTE = "1"
$HubBuild = Join-Path $Hub "build"
if (-not (Test-Path (Join-Path $HubBuild "CMakeCache.txt"))) {
    & $cmakeExe -S $Hub -B $HubBuild
    if ($LASTEXITCODE -ne 0) { Die "TEST GATE: cmake configure failed (exit $LASTEXITCODE); nothing was packaged or published" }
}
& $cmakeExe --build $HubBuild --config Release --parallel 4
if ($LASTEXITCODE -ne 0) { Die "TEST GATE: build failed (exit $LASTEXITCODE); nothing was packaged or published" }
& $ctestExe --test-dir $HubBuild -C Release -LE online --output-on-failure
if ($LASTEXITCODE -ne 0) { Die "TEST GATE: ctest failed (exit $LASTEXITCODE); nothing was packaged or published" }
[void]$script:done.Add("test gate passed")

# ── 4. Package (fast path) and validate SHA256SUMS ──
$Dist = if ($OutDir) { $OutDir } elseif ($DryRun) { Join-Path ([System.IO.Path]::GetTempPath()) "release-dryrun-$Tag" } else { Join-Path $Root "dist" }
if (-not $SkipPackage) {
    Step "Packaging into $Dist"
    $pkgArgs = @{ OutDir = $Dist; RetroHubDir = $Hub }
    if ($ForceBattleShip) { $pkgArgs.ForceBattleShip = $true }
    & (Join-Path $PSScriptRoot "package-windows.ps1") @pkgArgs
    if ($LASTEXITCODE -ne 0) { Die "package-windows.ps1 failed (exit $LASTEXITCODE)" }
}
foreach ($req in $RequiredAssets) { if (-not (Test-Path -LiteralPath (Join-Path $Dist $req))) { Die "missing required release asset $req in $Dist" } }
try { $expected = Get-ExpectedAssets $Dist } catch { Die "$_" }
$assets = @($expected.Keys | ForEach-Object { Join-Path $Dist $_ })
Write-Host "Assets to upload ($($assets.Count)): $($expected.Keys -join ', ')"
[void]$script:done.Add("packaged $($assets.Count) assets in $Dist (SHA256SUMS verified)")

if ($DryRun) { $script:remote = Join-Path ([System.IO.Path]::GetTempPath()) ("release-dryrun-remote-" + [guid]::NewGuid().ToString("N")) }

# ── 5. Commit VERSION in both repos (only VERSION, whatever else is staged), tag RetroHub ──
Step "Committing VERSION and tagging"
if ($DryRun) {
    Run "git -C $Root commit VERSION -m $Tag" {}
    Run "git -C $Hub commit VERSION -m $Tag" {}
    Run "git -C $Hub tag $Tag" {}
} else {
    $pre = @{}
    foreach ($r in @($Root, $Hub)) { $pre[$r] = GitC $r rev-parse HEAD }
    foreach ($r in @($Root, $Hub)) {
        GitC $r add VERSION | Out-Null
        GitC $r commit -m $Tag -- VERSION | Out-Null
        $script:committed = $true
        Write-Host "$r -> $(GitC $r rev-parse --short HEAD)"
    }
    GitC $Hub tag $Tag | Out-Null
    [void]$script:done.Add("committed VERSION in BattleShip and RetroHub, tagged RetroHub $Tag (all local)")
    [void]$script:undo.Add("git -C `"$Hub`" tag -d $Tag")
    [void]$script:undo.Add("git -C `"$Hub`" reset --soft $($pre[$Hub])      # local VERSION commit")
    [void]$script:undo.Add("git -C `"$Root`" reset --soft $($pre[$Root])    # local VERSION commit")
}

# ── 6. Draft release(s) with all assets, then download every asset back and verify ──
Step "Creating DRAFT release(s) and verifying the uploaded assets"
$drafts = @()
foreach ($t in $targets) {
    $repo = $t.repo
    [void]$script:undo.Insert(0, "gh release delete $Tag -R $repo --yes     # removes the draft (or run: gh api -X DELETE repos/$repo/releases/<id>)")
    $id = New-DraftRelease $repo $assets
    if (-not $id) { Die "creating the draft release on $repo failed (a partial draft may exist; see the undo list)" }
    [void]$script:done.Add("draft release $Tag created on $repo with $($assets.Count) assets (id $id)")
    try { Confirm-Remote $repo $id $expected } catch { Die "verification of the uploaded assets failed: $_ . The draft on $repo is NOT published." }
    [void]$script:done.Add("downloaded every asset back from $repo and verified its SHA-256")
    $drafts += @{ repo = $repo; id = $id; latest = $t.latest }
}

# ── 7. Push (fast-forward only, never force) ──
Step "Pushing"
Run "git -C $Hub push origin ${RetroHubBranch}:main" { & git -C $Hub push origin "${RetroHubBranch}:main" }
Run "git -C $Hub push origin $Tag" { & git -C $Hub push origin $Tag }
if (-not $DryRun) {
    [void]$script:done.Add("pushed RetroHub $RetroHubBranch and tag $Tag to origin")
    [void]$script:undo.Insert(0, "git -C `"$Hub`" push origin :refs/tags/$Tag     # remove the pushed tag; main stays (revert the VERSION commit with git revert if you must)")
}
Run "git -C $Decomp push fatty HEAD:smash-classic" { & git -C $Decomp push fatty HEAD:smash-classic }
Run "git -C $Root push fatty ${BattleShipBranch}:main" { & git -C $Root push fatty "${BattleShipBranch}:main" }
if (-not $DryRun) { [void]$script:done.Add("pushed decomp and BattleShip $BattleShipBranch to fatty main") }

# ── 8. Worker ──
if ($DeployWorker) {
    Step "Deploying the Cloudflare Worker"
    Push-Location (Join-Path $Root "server\cloudflare")
    try {
        if ($DryRun) { & npx wrangler deploy --dry-run; if ($LASTEXITCODE -ne 0) { Write-Host "wrangler dry-run failed" -ForegroundColor Yellow } }
        else { & npx wrangler deploy; if ($LASTEXITCODE -ne 0) { Die "wrangler deploy failed (the release is still a DRAFT; fix and publish with: gh api -X PATCH repos/$HubRepo/releases/<id> -F draft=false -f make_latest=true)" } }
    } finally { Pop-Location }
}

# ── 9. Publish the drafts (this is the only step that makes anything public) ──
Step "Publishing"
foreach ($d in $drafts) {
    Publish-Release $d.repo $d.id $d.latest
    if (-not $DryRun) { [void]$script:done.Add("published $Tag on $($d.repo)"); $script:undo.Clear() }
}

if ($DryRun) {
    Restore-Versions
    if ($script:remote -and (Test-Path $script:remote)) { Remove-Item -Recurse -Force $script:remote -ErrorAction SilentlyContinue }
    Write-Host "`nDry run OK: nothing committed, pushed, deployed or published. VERSION files restored. Assets for inspection: $Dist" -ForegroundColor Green
    Write-Host ("Dry run complete in {0:N0}s" -f $sw.Elapsed.TotalSeconds) -ForegroundColor Green
    exit 0
}

Write-Host ("`nReleased $Tag on {0} in {1:N0}s" -f $(if ($AlsoSmashClassic) { "both repos" } else { $HubRepo }), $sw.Elapsed.TotalSeconds) -ForegroundColor Green
if ($AlsoSmashClassic) { Write-Host "   https://github.com/$BsRepo/releases/tag/$Tag" }
Write-Host "   https://github.com/$HubRepo/releases/tag/$Tag"
