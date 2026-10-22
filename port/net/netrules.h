#pragma once

/* Gameplay-affecting enhancement settings for an online match.
 *
 * Several enhancements (tap-jump disable, Auto Z-Cancel, competitive ruleset,
 * neutral spawns, stage hazards) are read from local settings while the match
 * simulates. Two peers with different settings would simulate different
 * games, so the lobby agrees on one set at match start (host's global rules,
 * each player's own tap-jump) and the enhancement getters return those until
 * the match ends. */

#ifdef __cplusplus
extern "C" {
#endif

enum PortNetRule {
    PORT_NETRULE_AUTO_Z_CANCEL,
    PORT_NETRULE_COMP_RULESET,
    PORT_NETRULE_NEUTRAL_SPAWNS,
    PORT_NETRULE_HAZARDS_DISABLED,
    PORT_NETRULE_TAP_JUMP_DISABLED,     /* per player */
    PORT_NETRULE_COUNT
};

/* tap_jump_disabled: one flag per game slot (4 entries). */
void port_netrules_set(int auto_z_cancel, int comp_ruleset, int neutral_spawns, int hazards_disabled,
                       const int *tap_jump_disabled);
void port_netrules_clear(void);

/* 1 and *out set when an online match overrides the rule, else 0. */
int port_netrules_override(int rule, int player, int *out);

/* 1 while an online match is running (its rules are in force). */
int port_netrules_active(void);

#ifdef __cplusplus
}
#endif
