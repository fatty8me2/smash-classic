#include "OnlineStatus.h"

#include "../net/netlobby.h"

#include <imgui.h>
#include <cstdio>
#include <libultraship/bridge/consolevariablebridge.h>

extern "C" int syNetRollbackIsDesynced(void);

namespace ssb64 {

namespace {
const char* const kFighters[] = { "Mario", "Fox", "Donkey Kong", "Samus", "Luigi", "Link",
                                  "Yoshi", "Captain Falcon", "Kirby", "Pikachu", "Jigglypuff", "Ness" };
const char* const kStages[] = { "Peach's Castle", "Sector Z", "Kongo Jungle", "Planet Zebes", "Hyrule Castle",
                                "Yoshi's Island", "Dream Land", "Saffron City", "Mushroom Kingdom" };

bool InMatchDesynced() {
    return port_netlobby_state() == PORT_NETLOBBY_IN_MATCH && syNetRollbackIsDesynced() != 0;
}

bool AfterMatch() {
    return port_netlobby_after_match() != 0 && port_netlobby_state() == PORT_NETLOBBY_CONNECTED;
}

/* Started from RetroHub: the room is joined automatically, so the
 * pre-match picks live here instead of in the Esc menu's Netplay panel. */
bool HubPreMatch() {
    if (port_netlobby_auto_active() == 0 || port_netlobby_after_match() != 0) {
        return false;
    }
    const int state = port_netlobby_state();
    return state != PORT_NETLOBBY_IDLE && state != PORT_NETLOBBY_IN_MATCH;
}

void DrawFighterPicker() {
    int fighter = port_netlobby_my_fkind();
    if (fighter < 0 || fighter >= IM_ARRAYSIZE(kFighters)) {
        fighter = 0;
    }
    ImGui::SetNextItemWidth(220);
    if (ImGui::Combo("Your fighter", &fighter, kFighters, IM_ARRAYSIZE(kFighters))) {
        CVarSetInteger("gNetplay.Fighter", fighter);
        port_netlobby_set_fkind(fighter);
    }
}

void DrawStartControls(const char* start_label) {
    if (port_netlobby_is_host()) {
        int stage = port_netlobby_stage();
        if (stage < 0 || stage >= IM_ARRAYSIZE(kStages)) {
            stage = 0;
        }
        ImGui::SetNextItemWidth(220);
        if (ImGui::Combo("Stage", &stage, kStages, IM_ARRAYSIZE(kStages))) {
            CVarSetInteger("gNetplay.Stage", stage);
            port_netlobby_set_stage(stage);
        }
        ImGui::BeginDisabled(port_netlobby_state() != PORT_NETLOBBY_CONNECTED || port_netlobby_can_start() == 0);
        if (ImGui::Button(start_label, ImVec2(160, 0))) {
            port_netlobby_start_match();
        }
        ImGui::EndDisabled();
        ImGui::SameLine();
    }
    if (ImGui::Button("Leave", ImVec2(120, 0))) {
        port_netlobby_cancel();
    }
}
} // namespace

void DrawNetplayPlayers() {
    for (int slot = 0; slot < PORT_NETLOBBY_MAX_PLAYERS; slot++) {
        PortNetLobbyPlayer player;
        if (port_netlobby_get_player(slot, &player) == 0) {
            continue;
        }
        const char* fighter = (player.fkind >= 0 && player.fkind < IM_ARRAYSIZE(kFighters)) ? kFighters[player.fkind]
                                                                                           : "choosing...";
        char role[24] = {};
        std::snprintf(role, sizeof(role), "%s%s", player.is_host ? "host" : "", player.is_self ? (player.is_host ? ", you" : "you") : "");
        char line[160];
        int n = std::snprintf(line, sizeof(line), "Player %d%s%s%s: %s", slot + 1, role[0] ? " (" : "", role,
                              role[0] ? ")" : "", fighter);
        if (!player.connected) {
            std::snprintf(line + n, sizeof(line) - n, "  - connecting...");
        } else if (player.ping_ms >= 0) {
            std::snprintf(line + n, sizeof(line) - n, "  - %d ms%s", player.ping_ms, player.relay ? " (relayed)" : "");
        }
        ImGui::TextUnformatted(line);
    }
}

OnlineStatusWindow::OnlineStatusWindow()
    : Ship::GuiWindow("gOnlineStatus.Visible", false, "Online", ImVec2(-1, -1),
                      ImGuiWindowFlags_NoCollapse | ImGuiWindowFlags_AlwaysAutoResize |
                          ImGuiWindowFlags_NoSavedSettings) {
}

void OnlineStatusWindow::InitElement() {
    Hide();
}

void OnlineStatusWindow::UpdateElement() {
}

void OnlineStatusWindow::Draw() {
    const bool wanted = InMatchDesynced() || AfterMatch() || HubPreMatch();
    if (wanted != IsVisible()) {
        if (wanted) {
            Show();
        } else {
            Hide();
        }
    }
    if (!IsVisible()) {
        return;
    }
    const ImGuiViewport* viewport = ImGui::GetMainViewport();
    ImGui::SetNextWindowPos(ImVec2(viewport->GetCenter().x, viewport->WorkPos.y + 12.0f), ImGuiCond_Always,
                            ImVec2(0.5f, 0.0f));
    Ship::GuiWindow::Draw();
}

void OnlineStatusWindow::DrawElement() {
    if (InMatchDesynced()) {
        ImGui::TextColored(ImVec4(1.0f, 0.45f, 0.35f, 1.0f), "Out of sync with the other players.");
        ImGui::TextWrapped("Your games no longer match - what you see may differ from what they see. "
                           "Finish or quit this match and start a rematch.");
        return;
    }
    ImGui::TextWrapped("%s", port_netlobby_status());
    ImGui::Spacing();
    DrawNetplayPlayers();
    if (HubPreMatch()) {
        ImGui::Spacing();
        DrawFighterPicker();
        if (!port_netlobby_is_host()) {
            ImGui::TextDisabled("The host picks the stage and starts the match.");
        }
        ImGui::Spacing();
        DrawStartControls("Start match");
        return;
    }
    ImGui::TextDisabled("You're all back in your own menus. Use this window to play again.");
    ImGui::Spacing();
    DrawFighterPicker();
    ImGui::Spacing();
    DrawStartControls("Start rematch");
}

} // namespace ssb64
