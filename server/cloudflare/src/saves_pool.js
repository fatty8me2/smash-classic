// Pure helpers for cloud saves v2 (no Workers imports, so Node tests can load them). See RetroHub/docs/CLOUD_SAVES_V2.md.
// Classification, retention, pool state, large-pool caps and the eviction ordering live here; the Durable Object
// (r2budget_v2.js) only does the SQL around them.

export const MB = 1024 * 1024;
export const ACCOUNT_CAP = 50 * MB;      // per account, all retained versions
export const PROT_CAP = 20 * MB;         // protected class ceiling (settings + battery + small cards, history included)
export const SMALL_CARD = 512 * 1024;    // memory cards up to this size are protected
export const POOL_TIGHT = 0.7;
export const POOL_FULL = 0.9;
export const KEEP_PROTECTED = 3;         // retained versions per path
export const KEEP_LARGE = 1;
export const DAY_PUTS = 1500;
export const DAY_GETS = 6000;
export const IDLE_LARGE_DAYS = 90;
export const IDLE_ALL_DAYS = 730;        // 24 months

export const CLASSES = ["settings", "battery", "card", "state", "shot"];
const CARD_EXT = new Set(["mcd", "mcr", "gci", "gcp", "vmp", "vmc", "ps2", "mc2", "card", "raw"]);
const SHOT_EXT = new Set(["png", "jpg", "jpeg", "bmp", "tga", "webp"]);

const extOf = (name) => { const i = name.lastIndexOf("."); return i < 0 ? "" : name.slice(i + 1).toLowerCase(); };

// Mirror of the C++ classify_path (RetroHub src/saves). Golden table: RetroHub/docs/cloud_classify_cases.txt.
// `rel` is relative to the game folder ("battery/x.sra", "states/auto.state", "meta.json", "_account/x").
export function classifyPath(rel, size = 0) {
  const parts = String(rel).split("/");
  const seg0 = parts[0].toLowerCase();
  const name = parts[parts.length - 1].toLowerCase();
  if (seg0 === "_account" || name === "meta.json") return "settings";
  if (parts.length === 1 && name === "cover.png") return "settings";   // the user's custom cover at the game root
  if (seg0 === "states") return SHOT_EXT.has(extOf(name)) ? "shot" : "state";
  if (CARD_EXT.has(extOf(name))) return "card";
  if (seg0 === "battery") return "battery";
  return size > SMALL_CARD ? "card" : "battery";   // unknown layout: small stays protected, big is treated as a large card
}

export const isProtectedClass = (cls, size = 0) => cls === "settings" || cls === "battery" || (cls === "card" && size <= SMALL_CARD);
export const keepVersions = (prot) => (prot ? KEEP_PROTECTED : KEEP_LARGE);

// v1 object key ("system/game/rest" | "_account/rest" | anything else) -> game + path inside the game.
export function splitV1Key(key) {
  const s = key.split("/");
  if (s[0] === "_account" && s.length >= 2) return { gkey: "_account/_", path: key };
  if (s.length >= 3) return { gkey: s[0] + "/" + s[1], path: s.slice(2).join("/") };
  return { gkey: "_misc/_", path: key };
}

// Pool state from the global stored-bytes counter.
export function poolState(total, storageCap, tight = POOL_TIGHT, full = POOL_FULL) {
  if (!(storageCap > 0)) return "full";
  const f = total / storageCap;
  return f >= full ? "full" : f >= tight ? "tight" : "ok";
}

// Large-pool cap (bytes) for one account. ok: whatever is left of the account cap after protected data. tight:
// accounts above `floor` (20% of the cap = 10 MB by default) are shrunk in steps 60% / 40% (30 / 20 MB), full: floor.
// Accounts at or below the floor are never shrunk.
export function largeCap(pool, protUsed, accountCap = ACCOUNT_CAP, frac = 0) {
  const room = Math.max(0, accountCap - protUsed);
  if (pool === "ok") return room;
  const floor = accountCap * 0.2;
  let step;
  if (pool === "full") step = floor;
  else step = frac >= 0.8 ? accountCap * 0.4 : accountCap * 0.6;   // tight: 70-80% -> 30 MB, 80-90% -> 20 MB
  return Math.min(room, Math.max(floor, step));
}

// Eviction order of large items. item: {game, path, cls, mtime, stored, playedAt, pin}
// Games: least recently played first, pinned games last. Inside a game: states, shots, then cards; oldest mtime first.
const CLS_RANK = { state: 0, shot: 1, card: 2 };
export function evictionOrder(items, protectGame = null) {
  const list = items.filter((i) => i.game !== protectGame && !isProtectedClass(i.cls, i.stored));
  return list.sort((a, b) =>
    (a.pin ? 1 : 0) - (b.pin ? 1 : 0) ||
    a.playedAt - b.playedAt ||
    (a.game < b.game ? -1 : a.game > b.game ? 1 : 0) ||
    (CLS_RANK[a.cls] ?? 3) - (CLS_RANK[b.cls] ?? 3) ||
    a.mtime - b.mtime ||
    (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// Choose items to evict so that at least `need` bytes are freed. Returns {picked, freed}.
export function pickEvictions(items, need, protectGame = null, max = Infinity) {
  const picked = [];
  let freed = 0;
  for (const it of evictionOrder(items, protectGame)) {
    if (freed >= need || picked.length >= max) break;
    picked.push(it); freed += it.stored;
  }
  return { picked, freed };
}

// Global pressure: items of accounts above their fair share, least recently played first, at most `max`.
// items additionally carry `uid`; largeByUid: Map uid -> large bytes.
export function fairShare(storageCap, accountsWithLarge) {
  return accountsWithLarge > 0 ? (storageCap * 0.3) / accountsWithLarge : Infinity;
}
export function globalEvictions(items, largeByUid, share, need, max = 20) {
  const over = items.filter((i) => (largeByUid.get(i.uid) || 0) > share && !isProtectedClass(i.cls, i.stored));
  over.sort((a, b) => (a.pin ? 1 : 0) - (b.pin ? 1 : 0) || a.playedAt - b.playedAt || a.mtime - b.mtime);
  const picked = [];
  const left = new Map(largeByUid);
  let freed = 0;
  for (const it of over) {
    if (freed >= need || picked.length >= max) break;
    if ((left.get(it.uid) || 0) <= share) continue;      // never push an account below its fair share
    picked.push(it); freed += it.stored; left.set(it.uid, left.get(it.uid) - it.stored);
  }
  return { picked, freed };
}

export const leaseHeld = (row, dev, now) => !!(row && row.lease_dev && row.lease_until > now && row.lease_dev !== dev);
export const LEASE_SECS = 12 * 60;

export function secondsToUtcMidnight(now = Date.now()) {
  const d = new Date(now);
  return Math.max(1, Math.ceil((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - now) / 1000));
}

// Relative path validation. `v1` additionally reserves the first segment "o" (the blob area of the account).
const MAX_KEY = 240, MAX_SEGMENTS = 8;
export function cleanKey(raw, v1 = true) {
  if (typeof raw !== "string" || !raw || raw.length > MAX_KEY) return null;
  const segs = raw.split("/");
  if (segs.length > MAX_SEGMENTS) return null;
  for (const s of segs) {
    if (!s || s === "." || s === "..") return null;
    if (s.length > 120 || /[\x00-\x1f\x7f\\:*?"<>|]/.test(s)) return null;
    if (/[. ]$/.test(s)) return null;
  }
  if (segs[0].toLowerCase() === "_identity") return null; // the account secret never goes to the cloud
  if (v1 && segs[0] === "o") return null;
  if (/\.hubtmp$/i.test(raw)) return null;
  return segs.join("/");
}
export const cleanGame = (g) => { const k = cleanKey(g, false); return k && k.split("/").length === 2 ? k : null; };

export const HEX64 =/^[0-9a-f]{64}$/;
export const DEV_RE = /^[a-z0-9-]{8,40}$/;
export const cleanDeviceName = (n) => {
  const s = String(n ?? "").replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 40);
  return s || "PC";
};
