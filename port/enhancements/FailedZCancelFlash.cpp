#include "../net/netrules.h"
#include "enhancements.h"
#include <libultraship/bridge/consolevariablebridge.h>

namespace ssb64 {
    namespace enhancements {

        const char* FailedZCancelCVarName() {
            return "gEnhancements.CasualRules.FailedZCancelFlash";
        }

    } // namespace enhancements
} // namespace ssb64

extern "C" int port_enhancement_IsFailedZCancelFlashEnabled(void) {
    // Off in online matches: the flash starts a colanim from gameplay code
    // (and colanims can spawn effects that draw on the game RNG), so a
    // per-player setting here would make the two simulations diverge.
    if (port_netrules_active()) {
        return 0;
    }
    return CVarGetInteger(ssb64::enhancements::FailedZCancelCVarName(), 0) != 0;
}
