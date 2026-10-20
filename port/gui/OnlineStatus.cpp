#include "OnlineStatus.h"

#include "../net/netlobby.h"

#include <imgui.h>
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

/* Started from Classic Hub: the room is joined automatically, so the
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
        ImGui::BeginDisabled(port_netlobby_state() != PORT_NETLOBBY_CONNECTED || port_netlobby_peer_fkind() < 0);
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
        ImGui::TextColored(ImVec4(1.0f, 0.45f, 0.35f, 1.0f), "Out of sync with your opponent.");
        ImGui::TextWrapped("Your games no longer match - what you see may differ from what they see. "
                           "Finish or quit this match and start a rematch.");
        return;
    }
    ImGui::TextWrapped("%s", port_netlobby_status());
    const int ping = port_netlobby_ping_ms();
    if (ping >= 0) {
        ImGui::Text("Ping: %d ms%s", ping, port_netlobby_is_relay() ? " (relayed)" : "");
    }
    if (HubPreMatch()) {
        const int peer = port_netlobby_peer_fkind();
        if (peer >= 0 && peer < IM_ARRAYSIZE(kFighters)) {
            ImGui::Text("Opponent: %s", kFighters[peer]);
        }
        ImGui::Spacing();
        DrawFighterPicker();
        if (!port_netlobby_is_host()) {
            ImGui::TextDisabled("The host picks the stage and starts the match.");
        }
        ImGui::Spacing();
        DrawStartControls("Start match");
        return;
    }
    ImGui::TextDisabled("You're both back in your own menus. Use this window to play again.");
    ImGui::Spacing();
    DrawFighterPicker();
    ImGui::Spacing();
    DrawStartControls("Start rematch");
}

} // namespace ssb64
