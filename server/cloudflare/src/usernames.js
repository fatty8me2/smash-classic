// RetroHub usernames: pure validation / normalization (no Worker imports, unit-testable in plain node).
// The registry itself lives in the Directory Durable Object (friends.js); see RetroHub/docs/ACCOUNTS.md.
//
//   display  = NFKC form of what the player typed (case kept), 3-16 chars of [A-Za-z0-9_.-]
//   key      = the uniqueness key: lowercase, separators (_ . -) removed, digit look-alikes folded (0->o, 1->l, 5->s).
//              i and l are NOT folded ("Kai" and "Kal" are different names). Non-ASCII look-alikes (Cyrillic/Greek) can
//              never be claimed at all: only [A-Za-z0-9_.-] is accepted after NFKC.

export const NAME_MIN = 3;
export const NAME_MAX = 16;
export const HOLD_MS = 7 * 24 * 60 * 60 * 1000;      // a renamed-away name is held for its old owner this long
export const LEGACY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;   // an auto-claimed (migrated) name can be displaced by an older account this long

const ALLOWED = /^[A-Za-z0-9_.-]+$/;
const CODE_LIKE = /^rh-?[a-z2-7]{4}-?[a-z2-7]{4}$/i;      // would be mistaken for a friend code

/** Look-alike folding applied to the lowercase, separator-free form. */
export function foldKey(s) {
  return s
    .toLowerCase()
    .replace(/[_.-]/g, "")
    .replace(/0/g, "o")
    .replace(/1/g, "l")
    .replace(/5/g, "s");
}

const RESERVED_WORDS = [
  "admin", "administrator", "retrohub", "retro", "hub", "mod", "moderator", "system", "staff", "support", "official",
  "smashclassic", "smash", "root", "owner", "server", "everyone", "here", "help", "anonymous", "guest", "player",
  "null", "undefined", "nintendo", "sony", "microsoft", "cloudflare", "anthropic", "claude", "bot", "dev", "developer",
  "operator", "sysop", "team", "announcement", "news", "me", "you", "unknown", "deleted", "removed",
];
// Small, unambiguous list only (substring match on the folded key). Not a substitute for moderation.
const BAD_WORDS = [
  "fuck", "shit", "cunt", "nigger", "nigga", "faggot", "bitch", "whore", "rapist", "nazi", "hitler", "kike", "retard",
];
// Reserved/profanity checks are stricter than uniqueness: leetspeak 1/l also counts as i here ("Adm1n"), so impersonation is blocked.
const strong = (s) => foldKey(s).replace(/l/g, "i");
const RESERVED = new Set(RESERVED_WORDS.map(strong));
const BAD = BAD_WORDS.map(strong);

/**
 * Validate and normalize a proposed username.
 * Returns {ok:true, display, key} or {ok:false, reason} with reason one of:
 *   invalid-chars | too-short | too-long | bad-shape | reserved | profanity | looks-like-code
 * `test` = the account is a QA/test account: it may only use qa- names (reason `qa-only` / `test-only-qa`).
 */
export function normalizeUsername(raw, opts = {}) {
  if (typeof raw !== "string") return { ok: false, reason: "invalid-chars" };
  const display = raw.normalize("NFKC").trim();
  if (!ALLOWED.test(display)) return { ok: false, reason: display.length ? "invalid-chars" : "too-short" };
  if (display.length < NAME_MIN) return { ok: false, reason: "too-short" };
  if (display.length > NAME_MAX) return { ok: false, reason: "too-long" };
  if (!/^[A-Za-z0-9]/.test(display) || !/[A-Za-z0-9]$/.test(display) || /[_.-]{2}/.test(display)) {
    return { ok: false, reason: "bad-shape" };
  }
  const isQa = /^qa[-_.]/i.test(display);
  if (opts.test) {
    if (!isQa) return { ok: false, reason: "test-only-qa" };
  } else if (isQa) {
    return { ok: false, reason: "qa-only" };
  }
  if (CODE_LIKE.test(display)) return { ok: false, reason: "looks-like-code" };
  const key = foldKey(display);
  if (key.length < NAME_MIN) return { ok: false, reason: "too-short" };
  if (!opts.test) {
    const sk = strong(display);
    if (RESERVED.has(sk)) return { ok: false, reason: "reserved" };
    if (BAD.some((w) => sk.includes(w))) return { ok: false, reason: "profanity" };
  }
  return { ok: true, display, key };
}

/** Wire reason -> short machine reason used in `error.detail` / `username_result.reason`. */
export function reasonToError(reason) {
  switch (reason) {
    case "taken": case "held": return "username-taken";
    case "reserved": case "profanity": case "looks-like-code": return "username-reserved";
    case "qa-only": case "test-only-qa": return "username-test";
    default: return "username-invalid";
  }
}

/** Key for looking a name up (add-friend by username). No policy checks, just shape + folding. */
export function lookupKey(raw) {
  if (typeof raw !== "string") return null;
  const d = raw.normalize("NFKC").trim();
  if (!ALLOWED.test(d) || d.length < NAME_MIN || d.length > NAME_MAX) return null;
  const k = foldKey(d);
  return k.length >= NAME_MIN ? k : null;
}
