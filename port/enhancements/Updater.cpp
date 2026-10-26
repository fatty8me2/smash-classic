/* Smash Classic auto-updater, modeled on Jump Circuit's (autoload/updater.gd):
 *
 *   - On launch, ask GitHub for the latest release of kRepo. Only a strictly
 *     newer semantic version counts as an update.
 *   - The platform asset must download from this repo's releases (nothing
 *     else is trusted) and is verified against the size and SHA-256 digest
 *     GitHub reports for it.
 *   - Windows: a hidden PowerShell installer waits for the game to exit,
 *     unpacks the zip into a staging folder, checks it holds a complete
 *     build, backs up the files it will replace, copies the new files over
 *     the install, and relaunches the game. Any failure restores the backup
 *     and reopens the previous version. Saves, settings and the ROM-derived
 *     BattleShip.o2r are never in the zip, so they are never touched.
 *   - "Skip this version" is remembered; --no-update-check (or
 *     SSB64_NO_UPDATE_CHECK=1) disables the launch check.
 *
 * Linux (AppImage) and macOS (DMG) keep the upstream download flow. */
#include "enhancements.h"

#include "port_log.h"
#include "../build_version.h"

#include <libultraship/bridge/consolevariablebridge.h>
#include <ship/Context.h>
#include <ship/window/Window.h>
#include <ship/window/gui/Gui.h>

#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <functional>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

#if defined(__linux__)
#include <sys/stat.h>
#endif

#if defined(_WIN32)
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <bcrypt.h>
#include <shellapi.h>
#endif

namespace ssb64 {
namespace enhancements {

static std::atomic<bool> s_updateChecked{false};
static std::atomic<bool> s_updateAvailable{false};
static std::atomic<bool> s_isDownloading{false};
static std::atomic<bool> s_downloadComplete{false};
static std::atomic<bool> s_isCheckingForUpdates{false};
static std::atomic<bool> s_updateCheckFailed{false};
static std::atomic<bool> s_quitForUpdate{false};

static std::string s_latestVersion = "";
static std::string s_releaseNotes = "";
static std::string s_downloadUrl = "";
static long long s_assetSize = 0;
static std::string s_assetDigest = "";
static std::string s_updateStatus = "";
static std::string s_downloadStatus = "";
static std::mutex s_stringMutex;

namespace {


constexpr const char* kRepo = "fatty8me2/smash-classic";
constexpr const char* kLatestReleaseApi = "https://api.github.com/repos/fatty8me2/smash-classic/releases/latest";
constexpr const char* kReleasePageUrl = "https://github.com/fatty8me2/smash-classic/releases/latest";
constexpr const char* kDownloadPrefix = "https://github.com/fatty8me2/smash-classic/releases/download/";
constexpr const char* kSkippedVersionCVar = "gUpdater.SkippedVersion";

#if defined(__linux__)
constexpr const char* kPlatformAssetName = "BattleShip-x86_64.AppImage";
#elif defined(_WIN32)
constexpr const char* kPlatformAssetName = "BattleShip-windows.zip";
#elif defined(__APPLE__)
constexpr const char* kPlatformAssetName = "BattleShip.dmg";
#else
constexpr const char* kPlatformAssetName = "";
#endif

#if defined(_WIN32)
/* Embedded Windows installer (see the file header). Runs hidden under
 * Windows PowerShell 5.1, which every supported Windows ships. */
constexpr const char* kWindowsInstallerScript = R"PS(
param(
    [int]$WaitForPid,
    [string]$ZipPath,
    [string]$InstallDir,
    [string]$GamePath,
    [string]$Version
)
$ErrorActionPreference = "Stop"
# Tell the waiting game we are running: only then does it quit and hand over.
try { Set-Content -LiteralPath ($ZipPath + ".started") -Value $PID -ErrorAction Stop } catch { }
$stage = Join-Path $env:TEMP ("SmashClassic-update-" + [guid]::NewGuid().ToString("N"))
$unpacked = Join-Path $stage "new"
$backup = Join-Path $stage "backup"
$required = @("BattleShip.exe", "torch.exe", "f3d.o2r", "config.yml")
$installed = @()
try {
    try { Wait-Process -Id $WaitForPid -Timeout 20 -ErrorAction Stop } catch { }
    # Any copy of the game still running from this folder (a second window, or
    # one stuck shutting down) keeps BattleShip.exe locked. Give it a few
    # seconds, then close it - the player already chose to update.
    $exe = [System.IO.Path]::GetFullPath($GamePath)
    for ($i = 0; $i -lt 40; $i++) {
        $running = @(Get-Process -Name "BattleShip" -ErrorAction SilentlyContinue | Where-Object {
            try { [System.IO.Path]::GetFullPath($_.Path) -ieq $exe } catch { $false } })
        if ($running.Count -eq 0) { break }
        if ($i -ge 10) { $running | Stop-Process -Force -ErrorAction SilentlyContinue }
        Start-Sleep -Milliseconds 500
    }
    New-Item -ItemType Directory -Path $unpacked -Force | Out-Null
    Expand-Archive -LiteralPath $ZipPath -DestinationPath $unpacked -Force
    foreach ($name in $required) {
        if (-not (Test-Path -LiteralPath (Join-Path $unpacked $name) -PathType Leaf)) {
            throw ("the update is missing " + $name)
        }
    }
    $files = Get-ChildItem -LiteralPath $unpacked -Recurse -File -Force |
        ForEach-Object { $_.FullName.Substring($unpacked.Length + 1) }
    New-Item -ItemType Directory -Path $backup -Force | Out-Null
    try {
        foreach ($rel in $files) {
            $destination = Join-Path $InstallDir $rel
            if (Test-Path -LiteralPath $destination -PathType Leaf) {
                $saved = Join-Path $backup $rel
                New-Item -ItemType Directory -Path (Split-Path $saved) -Force | Out-Null
                Copy-Item -LiteralPath $destination -Destination $saved -Force
            }
            New-Item -ItemType Directory -Path (Split-Path $destination) -Force | Out-Null
            # Antivirus scans can hold a just-released file for a moment.
            for ($try = 1; ; $try++) {
                try { Copy-Item -LiteralPath (Join-Path $unpacked $rel) -Destination $destination -Force; break }
                catch { if ($try -ge 10) { throw } Start-Sleep -Milliseconds 500 }
            }
            $installed += $rel
        }
    } catch {
        foreach ($rel in $installed) {
            $destination = Join-Path $InstallDir $rel
            $saved = Join-Path $backup $rel
            try {
                if (Test-Path -LiteralPath $saved -PathType Leaf) {
                    Copy-Item -LiteralPath $saved -Destination $destination -Force
                } else {
                    Remove-Item -LiteralPath $destination -Force
                }
            } catch { }
        }
        throw
    }
    Remove-Item -LiteralPath $ZipPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath ($ZipPath + ".started") -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
    Start-Process -FilePath $GamePath -WorkingDirectory $InstallDir
} catch {
    $message = "Could not install Smash Classic " + $Version + ": " + $_.Exception.Message + "`nThe previous version will be opened."
    try {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show($message, "Smash Classic Update", "OK", "Error") | Out-Null
    } catch { }
    Remove-Item -LiteralPath $ZipPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath ($ZipPath + ".started") -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $GamePath -PathType Leaf) {
        Start-Process -FilePath $GamePath -WorkingDirectory $InstallDir
    }
}
)PS";
#endif

#if !defined(_WIN32)
std::string ShellSingleQuote(const std::string& s) {
    std::string out = "'";
    for (char c : s) {
        if (c == '\'') {
            out += "'\\''";
        } else {
            out += c;
        }
    }
    out += "'";
    return out;
}
#endif

void SetUpdateStatus(const std::string& status) {
    std::lock_guard<std::mutex> lock(s_stringMutex);
    s_updateStatus = status;
}

void SetDownloadStatus(const std::string& status) {
    std::lock_guard<std::mutex> lock(s_stringMutex);
    s_downloadStatus = status;
}

/* "v1.2.3" / "1.2" -> {1,2,3}; anything non-numeric ends the version. */
std::vector<int> ParseVersion(std::string v) {
    std::vector<int> parts;
    size_t at = (!v.empty() && (v[0] == 'v' || v[0] == 'V')) ? 1 : 0;
    while (at < v.size()) {
        size_t end = at;
        while (end < v.size() && v[end] >= '0' && v[end] <= '9') end++;
        if (end == at) break;
        parts.push_back(std::atoi(v.substr(at, end - at).c_str()));
        if (end >= v.size() || v[end] != '.') break;
        at = end + 1;
    }
    return parts;
}

/* -1 / 0 / 1. An unparseable current version ("dev") is older than anything. */
int CompareVersions(const std::string& a, const std::string& b) {
    std::vector<int> pa = ParseVersion(a);
    std::vector<int> pb = ParseVersion(b);
    if (pa.empty() || pb.empty()) {
        return pa.empty() == pb.empty() ? 0 : (pa.empty() ? -1 : 1);
    }
    for (size_t i = 0; i < pa.size() || i < pb.size(); i++) {
        int va = (i < pa.size()) ? pa[i] : 0;
        int vb = (i < pb.size()) ? pb[i] : 0;
        if (va != vb) return (va < vb) ? -1 : 1;
    }
    return 0;
}

#if defined(_WIN32)
int RunCaptureNoWindow(std::string cmd, const std::function<void(const std::string&)>& onLine) {
    HANDLE readPipe = nullptr;
    HANDLE writePipe = nullptr;
    SECURITY_ATTRIBUTES sa{};
    sa.nLength = sizeof(sa);
    sa.bInheritHandle = TRUE;
    if (!CreatePipe(&readPipe, &writePipe, &sa, 0)) return -1;
    SetHandleInformation(readPipe, HANDLE_FLAG_INHERIT, 0);

    STARTUPINFOA si{};
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdOutput = writePipe;
    si.hStdError = writePipe;

    PROCESS_INFORMATION pi{};
    BOOL ok = CreateProcessA(nullptr, cmd.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi);
    CloseHandle(writePipe);
    if (!ok) {
        CloseHandle(readPipe);
        return -1;
    }
    std::string line;
    char buf[512];
    DWORD got = 0;
    while (ReadFile(readPipe, buf, sizeof(buf), &got, nullptr) && got > 0) {
        for (DWORD i = 0; i < got; ++i) {
            char c = buf[i];
            if (c == '\r' || c == '\n') {
                if (!line.empty()) {
                    onLine(line);
                    line.clear();
                }
            } else {
                line += c;
            }
        }
    }
    if (!line.empty()) onLine(line);
    CloseHandle(readPipe);
    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD code = 0;
    GetExitCodeProcess(pi.hProcess, &code);
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
    return static_cast<int>(code);
}

/* Lowercase hex SHA-256 of a file (Windows CNG), or "" on error. */
std::string Sha256File(const std::string& path) {
    BCRYPT_ALG_HANDLE alg = nullptr;
    BCRYPT_HASH_HANDLE hash = nullptr;
    std::string hex;
    if (BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, nullptr, 0) != 0) return hex;
    if (BCryptCreateHash(alg, &hash, nullptr, 0, nullptr, 0, 0) == 0) {
        std::ifstream in(path, std::ios::binary);
        std::vector<char> buf(1 << 16);
        bool ok = static_cast<bool>(in);
        while (ok && in) {
            in.read(buf.data(), buf.size());
            std::streamsize n = in.gcount();
            if (n > 0 && BCryptHashData(hash, reinterpret_cast<PUCHAR>(buf.data()), static_cast<ULONG>(n), 0) != 0) {
                ok = false;
            }
        }
        unsigned char digest[32];
        if (ok && BCryptFinishHash(hash, digest, sizeof(digest), 0) == 0) {
            static const char* kHex = "0123456789abcdef";
            for (unsigned char b : digest) {
                hex += kHex[b >> 4];
                hex += kHex[b & 15];
            }
        }
        BCryptDestroyHash(hash);
    }
    BCryptCloseAlgorithmProvider(alg, 0);
    return hex;
}

std::string ExecutablePath() {
    char path[MAX_PATH];
    DWORD n = GetModuleFileNameA(nullptr, path, MAX_PATH);
    return (n > 0 && n < MAX_PATH) ? std::string(path, n) : std::string();
}
#endif

int RunCapture(std::string cmd, const std::function<void(const std::string&)>& onLine) {
#if defined(_WIN32)
    return RunCaptureNoWindow(std::move(cmd), onLine);
#else
    FILE* pipe = popen(cmd.c_str(), "r");
    if (!pipe) return -1;
    int c;
    std::string currentLine;
    while ((c = fgetc(pipe)) != EOF) {
        if (c == '\r' || c == '\n') {
            if (!currentLine.empty()) onLine(currentLine);
            currentLine.clear();
        } else {
            currentLine += static_cast<char>(c);
        }
    }
    if (!currentLine.empty()) onLine(currentLine);
    return pclose(pipe);
#endif
}

std::string CurlCommandPrefix() {
#if defined(__linux__)
    // AppRun prepends bundled AppImage libs for the game itself. Those libs
    // poison distro tools like curl/xdg-open, so strip loader overrides here.
    return "env -u LD_LIBRARY_PATH -u LD_PRELOAD curl";
#else
    return "curl";
#endif
}

std::string BuildCheckCommand() {
#if defined(_WIN32)
    return std::string("curl -fLsS -m 10 -H \"User-Agent: SmashClassic-Updater\" -H \"Accept: application/vnd.github+json\" \"") +
           kLatestReleaseApi + "\"";
#else
    return CurlCommandPrefix() + " -fLsS -m 10 -H " + ShellSingleQuote("User-Agent: SmashClassic-Updater") + " " +
           ShellSingleQuote(kLatestReleaseApi) + " 2>&1";
#endif
}

std::string BuildDownloadCommand(const std::string& destPath, const std::string& url) {
#if defined(_WIN32)
    return "curl -fL -# -m 600 -o \"" + destPath + "\" \"" + url + "\"";
#else
    return CurlCommandPrefix() + " -fL -# -o " + ShellSingleQuote(destPath) + " " + ShellSingleQuote(url) + " 2>&1";
#endif
}

/* Only this repo's release downloads are trusted, and the URL is spliced
 * into a command line, so it must not contain quoting characters. */
bool IsTrustedDownloadUrl(const std::string& url) {
    if (url.rfind(kDownloadPrefix, 0) != 0) return false;
    for (char c : url) {
        if (c == '"' || c == '\'' || c == '\\' || c <= 0x20 || c == 0x7F) return false;
    }
    return true;
}

void ResetDownloadStateForNewCheck() {
    s_downloadComplete.store(false);
    SetDownloadStatus("");
}

bool LaunchCheckDisabled() {
    const char* env = std::getenv("SSB64_NO_UPDATE_CHECK");
    if (env != nullptr && env[0] != '\0' && env[0] != '0') return true;
#if defined(_WIN32)
    int argc = 0;
    LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    bool found = false;
    for (int i = 1; argv != nullptr && i < argc; i++) {
        if (wcscmp(argv[i], L"--no-update-check") == 0) found = true;
    }
    LocalFree(argv);
    return found;
#else
    return false;
#endif
}

} // namespace

std::string GetCurrentVersion() {
    return BATTLESHIP_CURRENT_VERSION;
}

void CheckForUpdatesAsync(bool force) {
    if (s_isCheckingForUpdates.load() || s_isDownloading.load()) return;
    if (!force && s_updateChecked.load()) return;
    if (!force && LaunchCheckDisabled()) {
        s_updateChecked.store(true);
        SetUpdateStatus("Update check disabled.");
        return;
    }
    s_updateChecked.store(true);
    s_isCheckingForUpdates.store(true);
    s_updateCheckFailed.store(false);
    s_updateAvailable.store(false);
    ResetDownloadStateForNewCheck();
    SetUpdateStatus("");

    std::thread([]() {
        std::string response;
        int exitCode = RunCapture(BuildCheckCommand(), [&](const std::string& line) { response += line; });
        if (exitCode != 0 || response.empty()) {
            s_updateCheckFailed.store(true);
            SetUpdateStatus("Unable to check for updates.");
            s_isCheckingForUpdates.store(false);
            return;
        }
        try {
            auto release = nlohmann::json::parse(response);
            if (!release.contains("tag_name") || !release["tag_name"].is_string()) {
                throw std::runtime_error("latest release missing tag_name");
            }
            std::string latestTag = release["tag_name"].get<std::string>();
            std::string notes = (release.contains("body") && release["body"].is_string())
                                    ? release["body"].get<std::string>() : std::string();
            {
                std::lock_guard<std::mutex> lock(s_stringMutex);
                s_latestVersion = latestTag;
                s_releaseNotes = notes;
                s_downloadUrl.clear();
                s_assetSize = 0;
                s_assetDigest.clear();
            }
            if (CompareVersions(latestTag, BATTLESHIP_CURRENT_VERSION) <= 0) {
                SetUpdateStatus("Up to date (" + std::string(BATTLESHIP_CURRENT_VERSION) + ").");
            } else {
                bool found = false;
                if (release.contains("assets") && release["assets"].is_array()) {
                    for (const auto& asset : release["assets"]) {
                        if (!asset.contains("name") || !asset["name"].is_string() ||
                            asset["name"].get<std::string>() != kPlatformAssetName ||
                            !asset.contains("browser_download_url") || !asset["browser_download_url"].is_string()) {
                            continue;
                        }
                        std::string url = asset["browser_download_url"].get<std::string>();
                        long long size = (asset.contains("size") && asset["size"].is_number()) ? asset["size"].get<long long>() : 0;
                        if (!IsTrustedDownloadUrl(url) || size <= 0) {
                            port_log("Updater: rejecting release asset %s\n", url.c_str());
                            break;
                        }
                        std::lock_guard<std::mutex> lock(s_stringMutex);
                        s_downloadUrl = url;
                        s_assetSize = size;
                        s_assetDigest = (asset.contains("digest") && asset["digest"].is_string())
                                            ? asset["digest"].get<std::string>() : std::string();
                        found = true;
                        break;
                    }
                }
                if (found) {
                    s_updateAvailable.store(true);
                    SetUpdateStatus("");
                    port_log("Updater: %s available (have %s)\n", latestTag.c_str(), BATTLESHIP_CURRENT_VERSION);
                } else {
                    s_updateCheckFailed.store(true);
                    SetUpdateStatus("Latest release has no update for this platform.");
                }
            }
        } catch (...) {
            s_updateCheckFailed.store(true);
            SetUpdateStatus("Unable to read update information.");
        }
        s_isCheckingForUpdates.store(false);
    }).detach();
}

void StartGameUpdate() {
    if (s_isDownloading.load()) return;
    s_isDownloading.store(true);

    std::string url;
    long long expectedSize;
    std::string expectedDigest;
    std::string version;
    {
        std::lock_guard<std::mutex> lock(s_stringMutex);
        if (s_downloadUrl.empty()) {
            s_downloadStatus = "Error: No update download available.";
            s_isDownloading.store(false);
            return;
        }
        s_downloadStatus = "Starting download...";
        url = s_downloadUrl;
        expectedSize = s_assetSize;
        expectedDigest = s_assetDigest;
        version = s_latestVersion;
    }

    std::thread([url, expectedSize, expectedDigest, version]() {
        auto onProgressLine = [](const std::string& line) {
            if (line.find('%') == std::string::npos) return;
            std::string pct;
            for (char ch : line) {
                if ((ch >= '0' && ch <= '9') || ch == '.') pct += ch;
            }
            if (!pct.empty()) SetDownloadStatus("Downloading... " + pct + "%");
        };
        auto fail = [](const std::string& message) {
            SetDownloadStatus("Error: " + message);
            s_isDownloading.store(false);
        };

#if defined(_WIN32)
        std::string exePath = ExecutablePath();
        size_t slash = exePath.find_last_of("\\/");
        if (slash == std::string::npos) {
            fail("could not locate the install folder.");
            return;
        }
        std::string exeDir = exePath.substr(0, slash);
        std::string updatesDir = exeDir + "\\updates";
        CreateDirectoryA(updatesDir.c_str(), nullptr);
        std::string zipPath = updatesDir + "\\update.zip";
        std::remove(zipPath.c_str());
        std::remove((zipPath + ".started").c_str());

        if (RunCapture(BuildDownloadCommand(zipPath, url), onProgressLine) != 0) {
            std::remove(zipPath.c_str());
            fail("download failed.");
            return;
        }
        SetDownloadStatus("Verifying...");
        {
            std::ifstream in(zipPath, std::ios::binary | std::ios::ate);
            long long actual = in ? static_cast<long long>(in.tellg()) : -1;
            if (actual != expectedSize) {
                std::remove(zipPath.c_str());
                fail("download was incomplete.");
                return;
            }
        }
        if (expectedDigest.rfind("sha256:", 0) == 0 && Sha256File(zipPath) != expectedDigest.substr(7)) {
            std::remove(zipPath.c_str());
            fail("download failed verification.");
            return;
        }
        std::string scriptPath = updatesDir + "\\install_update.ps1";
        {
            std::ofstream script(scriptPath, std::ios::binary | std::ios::trunc);
            script << kWindowsInstallerScript;
            if (!script) {
                fail("could not prepare the installer.");
                return;
            }
        }
        char systemRoot[MAX_PATH] = "C:\\Windows";
        GetEnvironmentVariableA("SystemRoot", systemRoot, MAX_PATH);
        std::string cmd = std::string("\"") + systemRoot + "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\"" +
                          " -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass" +
                          " -File \"" + scriptPath + "\"" +
                          " -WaitForPid " + std::to_string(GetCurrentProcessId()) +
                          " -ZipPath \"" + zipPath + "\"" +
                          " -InstallDir \"" + exeDir + "\"" +
                          " -GamePath \"" + exePath + "\"" +
                          " -Version \"" + version + "\"";
        STARTUPINFOA si{};
        si.cb = sizeof(si);
        PROCESS_INFORMATION pi{};
        /* A hidden console of its own (PowerShell won't run detached from
         * any console). Break away from the game's job object if there is
         * one, so the installer outlives the game; not every job allows
         * that, so fall back to a plain launch. */
        std::string cmdBreakaway = cmd;
        if (!CreateProcessA(nullptr, cmdBreakaway.data(), nullptr, nullptr, FALSE,
                            CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB, nullptr, exeDir.c_str(), &si, &pi) &&
            !CreateProcessA(nullptr, cmd.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr,
                            exeDir.c_str(), &si, &pi)) {
            fail("could not start the installer.");
            return;
        }
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);

        /* Quit only once the installer is confirmed running; it waits for
         * this process to exit before touching any files. */
        std::string marker = zipPath + ".started";
        bool started = false;
        for (int i = 0; i < 300 && !started; i++) {     // PowerShell can take a while to cold-start
            Sleep(100);
            started = GetFileAttributesA(marker.c_str()) != INVALID_FILE_ATTRIBUTES;
        }
        if (!started) {
            fail("the installer did not start.");
            return;
        }
        SetDownloadStatus("Installing " + version + " - the game will restart...");
        s_downloadComplete.store(true);
        port_log("Updater: installer started for %s, closing the game\n", version.c_str());
        s_quitForUpdate.store(true);    // TickUpdater closes the window on the main thread
#elif defined(__linux__)
        const char* appImagePath = getenv("APPIMAGE");
        if (!appImagePath) {
            fail("not running as an AppImage.");
            return;
        }
        std::string tempPath = std::string(appImagePath) + ".part";
        if (RunCapture(BuildDownloadCommand(tempPath, url), onProgressLine) != 0) {
            std::remove(tempPath.c_str());
            fail("download failed.");
            return;
        }
        chmod(tempPath.c_str(), S_IRWXU | S_IRGRP | S_IXGRP | S_IROTH | S_IXOTH);
        if (std::rename(tempPath.c_str(), appImagePath) != 0) {
            fail("could not replace the AppImage.");
            return;
        }
        SetDownloadStatus("Update complete! Please restart the game.");
        s_downloadComplete.store(true);
#elif defined(__APPLE__)
        std::string tempDmg = "/tmp/SmashClassic_Update.dmg";
        if (RunCapture(BuildDownloadCommand(tempDmg, url), onProgressLine) != 0) {
            std::remove(tempDmg.c_str());
            fail("download failed.");
            return;
        }
        SetDownloadStatus("Download complete! Opening DMG...");
        s_downloadComplete.store(true);
        std::string openCmd = "open \"" + tempDmg + "\"";
        system(openCmd.c_str());
#endif
        s_isDownloading.store(false);
    }).detach();
}

/* Called once per frame on the main thread (PortPushFrame). */
void TickUpdater() {
    if (s_quitForUpdate.exchange(false)) {
        if (auto context = Ship::Context::GetInstance()) {
            if (auto window = context->GetWindow()) {
                window->Close();
            }
        }
    }
}

void SkipLatestVersion() {
    std::string version = GetLatestVersion();
    CVarSetString(kSkippedVersionCVar, version.c_str());
    if (auto context = Ship::Context::GetInstance()) {
        if (auto window = context->GetWindow()) {
            if (auto gui = window->GetGui()) gui->SaveConsoleVariablesNextFrame();
        }
    }
}

bool IsLatestVersionSkipped() {
    return GetLatestVersion() == CVarGetString(kSkippedVersionCVar, "");
}

void OpenReleasePage() {
    const char* url = kReleasePageUrl;
#if defined(_WIN32)
    ShellExecuteA(nullptr, "open", url, nullptr, nullptr, SW_SHOWNORMAL);
#elif defined(__APPLE__)
    std::string cmd = std::string("open ") + url;
    system(cmd.c_str());
#else
    std::string cmd = std::string("env -u LD_LIBRARY_PATH -u LD_PRELOAD xdg-open ") + ShellSingleQuote(url) + " &";
    system(cmd.c_str());
#endif
}

bool IsCheckingForUpdates() { return s_isCheckingForUpdates.load(); }
bool IsUpdateAvailable() { return s_updateAvailable.load(); }
bool DidUpdateCheckFail() { return s_updateCheckFailed.load(); }
bool IsDownloading() { return s_isDownloading.load(); }
bool IsDownloadComplete() { return s_downloadComplete.load(); }

std::string GetUpdateStatus() { std::lock_guard<std::mutex> lock(s_stringMutex); return s_updateStatus; }
std::string GetDownloadStatus() { std::lock_guard<std::mutex> lock(s_stringMutex); return s_downloadStatus; }
std::string GetLatestVersion() { std::lock_guard<std::mutex> lock(s_stringMutex); return s_latestVersion; }
std::string GetReleaseNotes() { std::lock_guard<std::mutex> lock(s_stringMutex); return s_releaseNotes; }

} // namespace enhancements
} // namespace ssb64
