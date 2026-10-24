/* libultraship glue for the RetroHub controls integration. See hub_controls.h for the env contract.
 *
 * SESSION ONLY: libultraship's Clear/Add/Set mapping calls write the gControllers CVars and save the config
 * file. To keep a hub launch from leaking into BattleShip's own config (standalone launches), the gControllers
 * block is snapshotted before the profile is applied and written back afterwards; the in-memory controller
 * objects keep the hub mapping for the session. Pad->port routing and the axis thresholds are in-memory only. */
#include "hub_controls.h"

#include <libultraship/libultraship.h>
#include <libultraship/controller/controldeck/ControlDeck.h>
#include <ship/controller/controldevice/controller/mapping/sdl/SDLButtonToButtonMapping.h>
#include <ship/controller/controldevice/controller/mapping/sdl/SDLAxisDirectionToButtonMapping.h>
#include <ship/controller/controldevice/controller/mapping/sdl/SDLAxisDirectionToAxisDirectionMapping.h>
#include <ship/controller/physicaldevice/ConnectedPhysicalDeviceManager.h>
#include <ship/controller/physicaldevice/GlobalSDLDeviceSettings.h>
#include <ship/config/Config.h>
#include <ship/config/ConsoleVariable.h>
#include <SDL2/SDL.h>

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <sstream>
#include <vector>

#include "port_log.h"

namespace {
bool sFromHub = false;
bool sActive = false;
hubc::ExitCombo sCombo(1.0);

void ApplyToPort(const hubc::Plan& plan, uint8_t port) {
    auto deck = Ship::Context::GetInstance()->GetControlDeck();
    if (!deck) return;
    auto c = deck->GetControllerByPort(port);
    if (!c) return;

    // Buttons: clear the N64 buttons' mappings, then add the hub's sources (multi-term = OR).
    for (auto& [mask, button] : c->GetAllButtons()) button->ClearAllButtonMappings();
    for (const auto& b : plan.buttons) {
        auto btn = c->GetButton(b.bitmask);
        if (!btn) continue;
        if (b.src.axis) {
            btn->AddButtonMapping(std::make_shared<Ship::SDLAxisDirectionToButtonMapping>(
                port, b.bitmask, b.src.idx, b.src.sign));
        } else {
            btn->AddButtonMapping(std::make_shared<Ship::SDLButtonToButtonMapping>(port, b.bitmask, b.src.idx));
        }
    }

    if (plan.has_stick) {
        auto stick = c->GetLeftStick();
        stick->ClearAllMappings();
        for (const auto& s : plan.stick) {
            stick->AddAxisDirectionMapping(
                static_cast<Ship::Direction>(s.dir),
                std::make_shared<Ship::SDLAxisDirectionToAxisDirectionMapping>(
                    port, Ship::LEFT_STICK, static_cast<Ship::Direction>(s.dir), s.axis, s.sign));
        }
        stick->SetDeadzone(static_cast<uint8_t>(plan.deadzone_pct));
        stick->SetSensitivity(static_cast<uint8_t>(plan.sensitivity_pct));
    }
    if (!plan.rumble) c->GetRumble()->ClearAllMappings();   // rumble off: no rumble mapping
}

std::string PadKey(int32_t instanceId) {
    SDL_Joystick* joy = SDL_JoystickFromInstanceID(instanceId);
    if (!joy) return std::string();
    char guid[40] = "";
    SDL_JoystickGetGUIDString(SDL_JoystickGetGUID(joy), guid, sizeof(guid));
    std::string k = guid;
    const char* serial = SDL_JoystickGetSerial(joy);
    if (serial && serial[0]) { k += "#"; k += serial; }
    return k;
}

/* Route connected pads to ports 1..4 in the hub's port order (in memory only; the routing is not persisted). */
std::string ApplyPortOrder(const std::vector<std::string>& order) {
    auto mgr = Ship::Context::GetInstance()->GetControlDeck()->GetConnectedPhysicalDeviceManager();
    if (!mgr) return "no device manager";
    std::vector<int32_t> ids;
    for (const auto& [id, name] : mgr->GetConnectedSDLGamepadNames()) ids.push_back(id);
    std::sort(ids.begin(), ids.end());
    std::vector<std::string> keys;
    for (int32_t id : ids) keys.push_back(PadKey(id));
    std::vector<int> idx = hubc::order_pads(keys, order);
    std::string log;
    for (size_t slot = 0; slot < idx.size(); slot++) {
        int32_t id = ids[idx[slot]];
        for (uint8_t port = 0; port < 4; port++) {
            if (port == slot) mgr->UnignoreInstanceIdForPort(port, id);
            else mgr->IgnoreInstanceIdForPort(port, id);
        }
        char buf[96];
        std::snprintf(buf, sizeof(buf), "%sport%zu=%s", slot ? ", " : "", slot + 1, slot < 4 ? keys[idx[slot]].c_str() : "(none)");
        log += buf;
    }
    return log.empty() ? "no pads connected" : log;
}

std::string DescribeMapping(uint8_t port) {
    auto c = Ship::Context::GetInstance()->GetControlDeck()->GetControllerByPort(port);
    if (!c) return "";
    static const struct { uint32_t m; const char* n; } kNames[] = {
        { hubc::kA, "A" }, { hubc::kB, "B" }, { hubc::kZ, "Z" }, { hubc::kStart, "Start" }, { hubc::kL, "L" }, { hubc::kR, "R" },
        { hubc::kCUp, "CUp" }, { hubc::kCDown, "CDown" }, { hubc::kCLeft, "CLeft" }, { hubc::kCRight, "CRight" },
    };
    std::string out;
    for (const auto& k : kNames) {
        auto btn = c->GetButton(k.m);
        if (!btn) continue;
        std::vector<std::string> ids;
        for (const auto& [id, m] : btn->GetAllButtonMappings()) ids.push_back(id);
        std::sort(ids.begin(), ids.end());
        out += std::string(out.empty() ? "" : "; ") + k.n + "=";
        for (size_t i = 0; i < ids.size(); i++) out += (i ? "," : "") + ids[i];
    }
    char buf[80];
    std::snprintf(buf, sizeof(buf), " | stick dz=%d sens=%d", c->GetLeftStick()->GetDeadzonePercentage(),
                  c->GetLeftStick()->GetSensitivityPercentage());
    return out + buf;
}
} // namespace

extern "C" void port_hub_controls_init(int argc, char** argv) {
    for (int i = 1; i < argc; i++) if (std::strcmp(argv[i], "--from-hub") == 0) sFromHub = true;
    if (!sFromHub) return;
    sActive = true;   // exit combo works even without a profile

    const char* path = std::getenv("SSB64_CONTROLS");
    if (!path || !path[0]) return;
    std::ifstream f(path, std::ios::binary);
    if (!f) { port_log("HubControls: cannot open %s\n", path); return; }
    std::stringstream ss; ss << f.rdbuf();
    hubc::Plan plan = hubc::plan_from_json(ss.str());
    if (!plan.valid) { port_log("HubControls: bad profile %s\n", path); return; }

    auto ctx = Ship::Context::GetInstance();
    auto cv = ctx->GetConsoleVariables();
    auto conf = ctx->GetConfig();

    // Snapshot the persisted controller config (flush in-memory CVars first so the snapshot is current).
    cv->Save();
    nlohmann::json nested = conf->GetNestedJson();
    bool hadBlock = nested.contains("CVars") && nested["CVars"].contains("gControllers");
    nlohmann::json snap = hadBlock ? nested["CVars"]["gControllers"] : nlohmann::json();

    if (plan.is_default) {
        port_log("HubControls: profile '%s' is the built-in default: keeping BattleShip's own Smash layout "
                 "(A attack, B special, X/Y jump, RB shield)\n", plan.name.c_str());
    } else {
        for (uint8_t p = 0; p < 4; p++) ApplyToPort(plan, p);
        auto gs = ctx->GetControlDeck()->GetGlobalSDLDeviceSettings();
        if (gs) {
            if (plan.stick_thr_pct) gs->SetStickAxisThresholdPercentage(plan.stick_thr_pct);
            if (plan.trigger_thr_pct) gs->SetTriggerAxisThresholdPercentage(plan.trigger_thr_pct);
        }
        port_log("HubControls: applied profile '%s' (%zu button sources, stick=%d, rumble=%d, thresholds stick=%d%% trigger=%d%%)\n",
                 plan.name.c_str(), plan.buttons.size(), plan.has_stick, plan.rumble, plan.stick_thr_pct, plan.trigger_thr_pct);
        for (uint8_t p = 0; p < 4; p++) port_log("HubControls: port%d mapping: %s\n", p + 1, DescribeMapping(p).c_str());
    }
    if (!plan.port_order.empty()) port_log("HubControls: pad order: %s\n", ApplyPortOrder(plan.port_order).c_str());

    // Undo the persisted side effects (session only): write the original gControllers block back and reload CVars.
    cv->ClearBlock("gControllers");
    if (hadBlock) conf->SetBlock("CVars.gControllers", snap);
    cv->Load();
    port_log("HubControls: config restored (session-only mapping)\n");
}

extern "C" int port_hub_controls_tick(void) {
    if (!sActive) return 0;
    bool held[16];
    int n = 0;
    int count = SDL_NumJoysticks();
    for (int i = 0; i < count && n < 16; i++) {
        if (!SDL_IsGameController(i)) continue;
        SDL_GameController* gc = SDL_GameControllerFromInstanceID(SDL_JoystickGetDeviceInstanceID(i));
        if (!gc) continue;   // not opened by libultraship (yet)
        held[n++] = SDL_GameControllerGetButton(gc, SDL_CONTROLLER_BUTTON_BACK) &&
                    SDL_GameControllerGetButton(gc, SDL_CONTROLLER_BUTTON_START);
    }
    static const bool sTestHeld = std::getenv("SSB64_HUB_TEST_COMBO") != nullptr;   // test hook: simulate Back+Start held
    if (sTestHeld && n < 16) held[n++] = true;
    return sCombo.update(held, n, SDL_GetTicks() / 1000.0) ? 1 : 0;
}
