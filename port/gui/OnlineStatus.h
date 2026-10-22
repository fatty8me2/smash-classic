#pragma once

#include <ship/window/gui/GuiWindow.h>

namespace ssb64 {

/* Lists the room's players (up to 4): fighter pick, connection and ping. */
void DrawNetplayPlayers();

/* Online play overlay, drawn even with the Esc menu closed:
 *   - in a match: a warning if the players' games went out of sync;
 *   - before/after a match: who is in the room and what they picked,
 *     connection info, and Start match / Start rematch (host) / Leave. */
class OnlineStatusWindow : public Ship::GuiWindow {
  public:
    OnlineStatusWindow();
    void Draw() override;

  protected:
    void InitElement() override;
    void DrawElement() override;
    void UpdateElement() override;
};

} // namespace ssb64
