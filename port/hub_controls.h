#pragma once
/* RetroHub controller-profile integration (only active with --from-hub).
 *
 * ENV CONTRACT: SSB64_CONTROLS=<path to JSON file> (hubctl::profile_to_json output for the "n64" system),
 * honored ONLY together with --from-hub. Missing/unreadable/bad file = the game's own saved mapping, untouched.
 *
 * This header is pure (no libultraship / SDL): parsing, translation plan and the Back+Start hold timer are unit
 * tested in hub_controls_test.cpp. The libultraship glue lives in hub_controls_apply.cpp. */

#include <cstdint>
#include <string>
#include <vector>

namespace hubc {

/* N64 button bitmasks (same values as libultra BTN_*). */
enum : uint32_t {
    kCRight = 0x0001, kCLeft = 0x0002, kCDown = 0x0004, kCUp = 0x0008, kR = 0x0010, kL = 0x0020,
    kDRight = 0x0100, kDLeft = 0x0200, kDDown = 0x0400, kDUp = 0x0800, kStart = 0x1000, kZ = 0x2000,
    kB = 0x4000, kA = 0x8000,
};

/* Stick directions, same order as Ship::Direction. */
enum StickDir { kLeft = 0, kRight = 1, kUp = 2, kDown = 3 };

/* One SDL source: button idx (SDL_CONTROLLER_BUTTON_*), or axis idx (SDL_CONTROLLER_AXIS_*) with sign -1/+1. */
struct Source {
    bool axis = false;
    int idx = 0;
    int sign = 0;
    int threshold = 0;   // "@N" (0..32767); 0 = not given (profile axis_threshold applies)
};

struct ButtonBind { uint32_t bitmask; Source src; };
struct StickBind { StickDir dir; int axis; int sign; };

struct Plan {
    bool valid = false;
    std::string name;
    std::vector<ButtonBind> buttons;      // several entries per bitmask = OR
    std::vector<StickBind> stick;         // empty = stick unbound (profile had no "stick")
    bool has_stick = false;
    int deadzone_pct = 20;                // libultraship ControllerStick::SetDeadzone
    int sensitivity_pct = 100;            // SetSensitivity
    bool rumble = false;
    std::vector<std::string> port_order;
    int axis_threshold = 16384;           // profile default for axis terms without "@"
    bool is_default = false;              // built-in "default-n64": keep BattleShip's own natural Smash layout
    int stick_thr_pct = 0;                // GlobalSDLDeviceSettings stick threshold (0 = leave)
    int trigger_thr_pct = 0;              // ... trigger threshold (0 = leave)
};

/* Pad ordering: given each connected pad's key ("guid" or "guid#serial") in the game's default order, returns
 * indices (into `pads`) in port order: matches from `port_order` first, then the rest in default order. */
std::vector<int> order_pads(const std::vector<std::string>& pads, const std::vector<std::string>& port_order);

/* SDL name -> index (-1 unknown). */
int button_index(const std::string& name);
int axis_index(const std::string& name);
/* "a", "leftx-@9000", "x|b" -> sources (invalid terms skipped). */
std::vector<Source> parse_expr(const std::string& expr);
/* Profile JSON -> plan. valid=false on parse error / wrong system. */
Plan plan_from_json(const std::string& json);

/* Back+Start held on one pad for `hold_secs` => fires once. update() is fed every frame with one entry per pad. */
class ExitCombo {
  public:
    explicit ExitCombo(double hold_secs = 1.0) : hold_(hold_secs) {}
    /* Returns true exactly once when the hold completes. */
    bool update(const bool* back_and_start_per_pad, int pads, double now);
    bool fired() const { return fired_; }
  private:
    double hold_;
    double since_ = -1.0;
    bool fired_ = false;
};

} // namespace hubc

#ifdef __cplusplus
extern "C" {
#endif
/* Called from port.cpp. Both are no-ops unless --from-hub was passed. */
void port_hub_controls_init(int argc, char** argv);   /* after ControlDeck+SDL are up */
int port_hub_controls_tick(void);                      /* per frame; returns 1 when the exit combo fired */
#ifdef __cplusplus
}
#endif
