// RetroHub usernames: pure validation / normalization (no Worker imports, unit-testable in plain node).
// The registry itself lives in the Directory Durable Object (friends.js); see RetroHub/docs/ACCOUNTS.md.
//
//   display  = NFKC form of what the player typed (case kept), leading/trailing space trimmed, runs of spaces collapsed to one.
//              3-20 characters from: printable ASCII (letters, digits, space, symbols) except  " \ < > ` /  plus the
//              Latin-1 letters U+00C0-U+00FF except x (U+00D7) and / (U+00F7). Nothing else: no emoji, no other scripts
//              (the hub's font only has Basic Latin + Latin-1), no control / zero-width / bidi characters.
//              Excluded ASCII: " and \ break JSON / command lines, < > ` break markup, / breaks paths.
//   key      = the uniqueness key: lowercase, Latin-1 accents stripped to the base letter (e->e, n->n, ss, ae, o, th, d),
//              EVERY character that is not [a-z0-9] removed, then digit look-alikes folded (0->o, 1->l, 5->s).
//              For any name valid under the old rules ([A-Za-z0-9_.-], only _ . - were removed) this is byte-identical to
//              the old key, so existing registrations never change. i and l are NOT folded. Needs >= 3 key characters.
//              Non-Latin look-alikes (Cyrillic/Greek) can never be claimed: they are not in the allowed set.

export const NAME_MIN = 3;
export const NAME_MAX = 20;
export const HOLD_MS = 7 * 24 * 60 * 60 * 1000;      // a renamed-away name is held for its old owner this long
export const LEGACY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;   // an auto-claimed (migrated) name can be displaced by an older account this long

// space..~ except " / < > \ `   +   U+00C0-U+00FF except U+00D7, U+00F7
const ALLOWED = /^[ !#-.0-;=?-\[\]-_a-~À-ÖØ-öø-ÿ]+$/;
const CODE_LIKE = /^rh[- ]?[a-z2-7]{4}[- ]?[a-z2-7]{4}$/i;      // would be mistaken for a friend code

const ACCENT = {
  "à": "a", "á": "a", "â": "a", "ã": "a", "ä": "a", "å": "a", "æ": "ae",
  "ç": "c", "è": "e", "é": "e", "ê": "e", "ë": "e",
  "ì": "i", "í": "i", "î": "i", "ï": "i", "ð": "d", "ñ": "n",
  "ò": "o", "ó": "o", "ô": "o", "õ": "o", "ö": "o", "ø": "o",
  "ù": "u", "ú": "u", "û": "u", "ü": "u", "ý": "y", "þ": "th", "ÿ": "y", "ß": "ss",
};

/** Trim, collapse space runs, NFKC (shared by validation and lookup). */
function shape(raw) {
  return raw.normalize("NFKC").trim().replace(/ {2,}/g, " ");
}

/** Uniqueness key of an already-shaped name: lowercase, de-accent, keep only [a-z0-9], then look-alike folding. */
export function foldKey(s) {
  return s
    .toLowerCase()
    .replace(/[ß-ÿ]/g, (c) => ACCENT[c] ?? "")
    .replace(/[^a-z0-9]/g, "")
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
  const display = shape(raw);
  if (!ALLOWED.test(display)) return { ok: false, reason: display.length ? "invalid-chars" : "too-short" };
  if (display.length < NAME_MIN) return { ok: false, reason: "too-short" };
  if (display.length > NAME_MAX) return { ok: false, reason: "too-long" };
  const isQa = /^qa[-_. ]/i.test(display);
  if (opts.test) {
    if (!isQa) return { ok: false, reason: "test-only-qa" };
  } else if (isQa) {
    return { ok: false, reason: "qa-only" };
  }
  if (CODE_LIKE.test(display)) return { ok: false, reason: "looks-like-code" };
  const key = foldKey(display);
  if (key.length < NAME_MIN) return { ok: false, reason: "bad-shape" };   // needs 3+ letters/digits
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
  const d = shape(raw);
  if (!ALLOWED.test(d) || d.length < NAME_MIN || d.length > NAME_MAX) return null;
  const k = foldKey(d);
  return k.length >= NAME_MIN ? k : null;
}
