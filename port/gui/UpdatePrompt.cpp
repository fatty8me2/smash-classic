#include "UpdatePrompt.h"

#include "../enhancements/enhancements.h"
#include "../net/netlobby.h"

extern "C" int port_diag_scene_is_menu(void);

#include <imgui.h>

#include <string>

namespace ssb64 {

namespace {
constexpr const char* kVisibilityCVar = "gUpdatePrompt.Visible";
constexpr int kNotesMaxLines = 14;

void ReplaceAll(std::string& s, const std::string& from, const std::string& to) {
    for (size_t at = s.find(from); at != std::string::npos; at = s.find(from, at + to.size())) {
        s.replace(at, from.size(), to);
    }
}

/* First lines of the release notes as plain text: markdown emphasis and
 * heading markers dropped, and the arrow (not in the menu font) spelled out. */
std::string NotesExcerpt(const std::string& notes) {
    std::string out;
    int lines = 0;
    for (size_t at = 0; at < notes.size() && lines < kNotesMaxLines;) {
        size_t end = notes.find('\n', at);
        std::string line = notes.substr(at, (end == std::string::npos) ? std::string::npos : end - at);
        if (!line.empty() && line.back() == '\r') line.pop_back();
        while (!line.empty() && line[0] == '#') line.erase(0, 1);
        if (!line.empty() && line[0] == ' ') line.erase(0, 1);
        ReplaceAll(line, "**", "");
        ReplaceAll(line, "`", "");
        ReplaceAll(line, "\xE2\x86\x92", "->");
        out += line + "\n";
        lines++;
        if (end == std::string::npos) break;
        at = end + 1;
    }
    return out;
}
} // namespace

UpdatePromptWindow::UpdatePromptWindow()
    : Ship::GuiWindow(kVisibilityCVar, false, "Update available", ImVec2(520, 0),
                      ImGuiWindowFlags_NoCollapse | ImGuiWindowFlags_AlwaysAutoResize |
                          ImGuiWindowFlags_NoSavedSettings) {
}

void UpdatePromptWindow::InitElement() {
    Hide();     // never restore a stale "visible" state from the config
    enhancements::CheckForUpdatesAsync(false);
}

void UpdatePromptWindow::UpdateElement() {
}

/* The prompt may only be open on the title / menu screens and with no online room or match: never over gameplay. */
static bool PromptSafeNow() {
    return port_diag_scene_is_menu() != 0 &&
           (port_netlobby_state() == PORT_NETLOBBY_IDLE || port_netlobby_state() == PORT_NETLOBBY_FAILED);
}

void UpdatePromptWindow::Draw() {
    const bool safe = PromptSafeNow();
    if (!safe && IsVisible() && !enhancements::IsDownloading() && !enhancements::IsDownloadComplete()) {
        Hide();            // a match or online session began: close it, and offer it again at the next menu
        mPrompted = false;
    }
    if (safe && !mPrompted && enhancements::IsUpdateAvailable() && !enhancements::IsLatestVersionSkipped()) {
        mPrompted = true;
        Show();
    }
    if (IsVisible()) {
        const ImGuiViewport* viewport = ImGui::GetMainViewport();
        ImGui::SetNextWindowPos(viewport->GetCenter(), ImGuiCond_Appearing, ImVec2(0.5f, 0.5f));
    }
    Ship::GuiWindow::Draw();
}

void UpdatePromptWindow::DrawElement() {
    const std::string latest = enhancements::GetLatestVersion();
    const std::string current = enhancements::GetCurrentVersion();
    const bool busy = enhancements::IsDownloading() || enhancements::IsDownloadComplete();

    ImGui::Text("Smash Classic %s is out - you have %s.", latest.c_str(), current.c_str());
    ImGui::Spacing();

    const std::string notes = NotesExcerpt(enhancements::GetReleaseNotes());
    if (!notes.empty()) {
        ImGui::BeginChild("##UpdateNotes", ImVec2(500, 220), true);
        ImGui::TextWrapped("%s", notes.c_str());
        ImGui::EndChild();
        ImGui::Spacing();
    }

    const std::string status = enhancements::GetDownloadStatus();
    if (!status.empty()) {
        ImGui::TextWrapped("%s", status.c_str());
        ImGui::Spacing();
    }

    ImGui::BeginDisabled(busy);
    if (ImGui::Button("Update now", ImVec2(150, 0))) {
        enhancements::StartGameUpdate();
    }
    ImGui::SameLine();
    if (ImGui::Button("Later", ImVec2(150, 0))) {
        Hide();
    }
    ImGui::SameLine();
    if (ImGui::Button("Skip this version", ImVec2(170, 0))) {
        enhancements::SkipLatestVersion();
        Hide();
    }
    ImGui::EndDisabled();

    ImGui::Spacing();
    ImGui::TextDisabled("The game restarts by itself once the update is installed. Saves and settings are kept.");
}

} // namespace ssb64
