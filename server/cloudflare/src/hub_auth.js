// Game-room seat authorisation (netcore-M3). A "-N" game room is started from a lobby room with the same code, so a seat in it may only
// be taken by an ACCOUNT that sits in that lobby with the same slot. Pure logic (no Cloudflare imports) so it can be unit tested.
//
// seats = the lobby roster as the lobby room reports it: [{slot, uid, spec}], uid = the account that seat PROVED with an ident ("" / null =
// never proved one: an older client, or auto-friend off). Seats that never proved an account cannot be held against anybody, so they
// stay allowed (compatibility with shipped clients); a proven account is held to the roster.
//   who = {slot, uid, spec, dropin}: the seat being checked (uid = the account it just proved in the game room).
// -> null (allowed) or a close reason:
//   "wrong-slot"     the account is in the lobby, but at another slot than the one it took
//   "slot-not-yours" the lobby slot belongs to a different proven account
//   "not-in-lobby"   the account is not in the lobby that started this game (or the slot does not exist there)
// Spectators and drop-in joiners (they sit on lobby spectator / drop-in seats, not on their game slot) only need to be in the lobby.
export function gameSeatVerdict(who, seats) {
  if (!Array.isArray(seats) || seats.length === 0) return null;   // lobby gone / not asked: never lock anybody out
  const flexible = !!(who.spec || who.dropin);
  const mine = seats.filter((s) => s.uid && s.uid === who.uid);
  if (mine.length) {
    if (flexible || mine.some((s) => s.slot === who.slot && !s.spec)) return null;
    return "wrong-slot";
  }
  if (flexible) return seats.some((s) => !s.uid) ? null : "not-in-lobby";
  const occupant = seats.find((s) => s.slot === who.slot && !s.spec);
  if (!occupant) return "not-in-lobby";
  return occupant.uid ? "slot-not-yours" : null;   // an unproven lobby seat cannot be told apart from a legacy client: allowed
}
