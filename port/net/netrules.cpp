/* See netrules.h. */
#include "netrules.h"
#include "port_log.h"

namespace {
bool sActive = false;
int sGlobal[PORT_NETRULE_TAP_JUMP_DISABLED] = {};
int sTapJump[4] = {};
} // namespace

extern "C" void port_netrules_set(int auto_z_cancel, int comp_ruleset, int neutral_spawns, int hazards_disabled,
                                  const int *tap_jump_disabled)
{
    sGlobal[PORT_NETRULE_AUTO_Z_CANCEL] = auto_z_cancel != 0;
    sGlobal[PORT_NETRULE_COMP_RULESET] = comp_ruleset != 0;
    sGlobal[PORT_NETRULE_NEUTRAL_SPAWNS] = neutral_spawns != 0;
    sGlobal[PORT_NETRULE_HAZARDS_DISABLED] = hazards_disabled != 0;
    for (int i = 0; i < 4; i++) {
        sTapJump[i] = (tap_jump_disabled != nullptr && tap_jump_disabled[i] != 0) ? 1 : 0;
    }
    sActive = true;
    port_log("SSB64 NetRules: auto_z=%d comp=%d neutral=%d hazards_off=%d tapjump_off=%d,%d,%d,%d\n",
             auto_z_cancel, comp_ruleset, neutral_spawns, hazards_disabled, sTapJump[0], sTapJump[1], sTapJump[2],
             sTapJump[3]);
}

extern "C" void port_netrules_clear(void)
{
    sActive = false;
}

extern "C" int port_netrules_active(void)
{
    return sActive ? 1 : 0;
}

extern "C" int port_netrules_override(int rule, int player, int *out)
{
    if (!sActive || rule < 0 || rule >= PORT_NETRULE_COUNT || out == nullptr) {
        return 0;
    }
    if (rule == PORT_NETRULE_TAP_JUMP_DISABLED) {
        *out = (player >= 0 && player < 4) ? sTapJump[player] : 0;
    } else {
        *out = sGlobal[rule];
    }
    return 1;
}
