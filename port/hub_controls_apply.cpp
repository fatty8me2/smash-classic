/* libultraship glue for the RetroHub controls integration. See hub_controls.h for the env contract.
 *
 * NOTE (config): libultraship's Clear*/Add* mapping calls write the gControllers.* CVars. In hub mode the hub
 * profile therefore overwrites the controller mapping in the game's own config (the standard config save will
 * persist it). The CVar gHubControls.Applied=1 marks this. A later standalone launch keeps the hub mapping until
 * the user resets it in the in-game controller menu. */
#include "hub_controls.h"

#include <libultraship/libultraship.h>
#include <libultraship/controller/controldeck/ControlDeck.h>
#include <ship/controller/controldevice/controller/mapping/sdl/SDLButtonToButtonMapping.h>
#include <ship/controller/controldevice/controller/mapping/sdl/SDLAxisDirectionToButtonMapping.h>
#include <ship/controller/controldevice/controller/mapping/sdl/SDLAxisDirectionToAxisDirectionMapping.h>
#include <SDL2/SDL.h>

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
        btn->SaveButtonMappingIdsToConfig();
    }
    for (auto& [mask, button] : c->GetAllButtons()) button->SaveButtonMappingIdsToConfig();

    if (plan.has_stick) {
        auto stick = c->GetLeftStick();
        stick->ClearAllMappings();
        for (const auto& s : plan.stick) {
            stick->AddAxisDirectionMapping(
                static_cast<Ship::Direction>(s.dir),
                std::make_shared<Ship::SDLAxisDirectionToAxisDirectionMapping>(
                    port, Ship::LEFT_STICK, static_cast<Ship::Direction>(s.dir), s.axis, s.sign));
        }
        stick->SaveAxisDirectionMappingIdsToConfig();
        stick->SetDeadzone(static_cast<uint8_t>(plan.deadzone_pct));
        stick->SetSensitivity(static_cast<uint8_t>(plan.sensitivity_pct));
    }
    if (!plan.rumble) c->GetRumble()->ClearAllMappings();   // rumble off: no rumble mapping
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
    for (uint8_t p = 0; p < 4; p++) ApplyToPort(plan, p);
    Ship::Context::GetInstance()->GetConsoleVariables()->SetInteger("gHubControls.Applied", 1);
    port_log("HubControls: applied profile '%s' (%zu button sources, stick=%d, rumble=%d); "
             "port_order (%zu) not applied: libultraship SDL mappings are not per-device\n",
             plan.name.c_str(), plan.buttons.size(), plan.has_stick, plan.rumble, plan.port_order.size());
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
    return sCombo.update(held, n, SDL_GetTicks() / 1000.0) ? 1 : 0;
}
