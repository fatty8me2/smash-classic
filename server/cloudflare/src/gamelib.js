// Friend game libraries (metadata only: system / game key / catalog id / title; never files).
// Pure helpers + UserHub glue. Tables: glib (id=1, share, ver, ctr, h, games) and glib_friend (uid PK, ver).
export const MAX_LIB_ENTRIES = 2000;
export const MAX_LIB_JSON = 300000;
const SYS_RE = /^[a-z0-9]{1,8}$/;

const strip = (raw, max) =>
  Array.from(String(raw ?? "").replace(/\s+/g, " ").replace(/[\p{C}\p{Zl}\p{Zp}]/gu, "").trim()).slice(0, max).join("");

/* Validates + dedupes (s+k) + caps. Returns [{s,k,c,t}]. */
export function sanitizeGames(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  const seen = new Set();
  for (const g of list) {
    if (out.length >= MAX_LIB_ENTRIES) break;
    if (!g || typeof g !== "object") continue;
    if (typeof g.s !== "string" || !SYS_RE.test(g.s)) continue;
    const k = strip(g.k, 64), t = strip(g.t, 80), c = strip(g.c, 32);
    if (!k && !c) continue;
    if (!t) continue;
    const id = g.s + "|" + k + (k ? "" : "|" + c);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ s: g.s, k, c, t });
  }
  return out;
}
export const canon = (games) => JSON.stringify(games);
export const cleanHash = (h) => strip(h, 24);
/* Raw size check applied before the general 8 KB limit. */
export function isLibraryFrame(message) {
  return typeof message === "string" && /^\s*\{\s*"type"\s*:\s*"library"/.test(message);
}

export function initGlib(sql) {
  sql.exec("CREATE TABLE IF NOT EXISTS glib (id INTEGER PRIMARY KEY CHECK (id = 1), share INTEGER NOT NULL DEFAULT 0, ver INTEGER NOT NULL DEFAULT 0, ctr INTEGER NOT NULL DEFAULT 0, h TEXT NOT NULL DEFAULT '', games TEXT NOT NULL DEFAULT '[]')");
  sql.exec("CREATE TABLE IF NOT EXISTS glib_friend (uid TEXT PRIMARY KEY, ver INTEGER NOT NULL)");
}
export function glibRow(hub) {
  return hub.one("SELECT * FROM glib WHERE id=1") || { share: 0, ver: 0, ctr: 0, h: "", games: "[]" };
}
export const glibInfo = (hub) => { const r = glibRow(hub); return { ver: r.share ? r.ver : 0, h: r.h, share: !!r.share }; };
export const ownLibVer = (hub) => glibInfo(hub).ver;
export function setFriendLib(hub, uid, ver) {
  if (!Number.isInteger(ver) || ver < 0) return;
  if (ver === 0) hub.run("DELETE FROM glib_friend WHERE uid=?", uid);
  else hub.run("INSERT OR REPLACE INTO glib_friend (uid, ver) VALUES (?, ?)", uid, ver);
}
export const friendLibVer = (hub, uid) => { const r = hub.one("SELECT ver FROM glib_friend WHERE uid=?", uid); return r ? r.ver : 0; };
export const dropFriendLib = (hub, uid) => hub.run("DELETE FROM glib_friend WHERE uid=?", uid);
export function clearAllLib(hub) { hub.run("DELETE FROM glib"); hub.run("DELETE FROM glib_friend"); }

/* Handles {type:"library"}. Returns true when presence must be re-broadcast. */
export function handleLibrary(hub, ws, msg) {
  if (!hub.hit("lib", 12, 10 * 60 * 1000)) { hub.err(ws, "rate-limited", "library"); return false; }
  const share = msg.share === true;
  const cur = glibRow(hub);
  let changed = false;
  let games = "[]", h = "";
  if (share) {
    games = canon(sanitizeGames(msg.games));
    h = cleanHash(msg.h);
  }
  let ver = cur.ver, ctr = cur.ctr;
  if (!share) {
    if (cur.share || cur.games !== "[]") { changed = true; ver = 0; }
  } else if (!cur.share || cur.games !== games) {
    changed = true; ctr = cur.ctr + 1; ver = ctr;
  }
  if (changed) hub.run("INSERT OR REPLACE INTO glib (id, share, ver, ctr, h, games) VALUES (1, ?, ?, ?, ?, ?)", share ? 1 : 0, ver, ctr, h, games);
  else if (share && cur.h !== h) hub.run("UPDATE glib SET h=? WHERE id=1", h);
  try { ws.send(JSON.stringify({ type: "library_ack", ver: share ? ver : 0, share, h })); } catch { /* closing */ }
  return changed;
}

/* Handles {type:"friend_library"}. */
export async function handleFriendLibrary(hub, ws, msg, uidArg, p) {
  const uid = uidArg(msg.uid);
  if (!uid) return hub.err(ws, "bad-request", "friend_library");
  if (!hub.isFriend(uid)) return hub.err(ws, "not-friends", "friend_library");
  if (!hub.hit("flib", 60, 60 * 1000)) return hub.err(ws, "rate-limited", "friend_library");
  let r = null;
  try { r = await hub.call(uid, "lib_get", { uid: p.uid, test: hub.isTestAccount() }); } catch { /* unreachable */ }
  const ver = r && r.r === "ok" && Number.isInteger(r.ver) ? r.ver : 0;
  setFriendLib(hub, uid, ver);
  let out;
  if (ver > 0 && msg.have === ver) out = { type: "friend_library", uid, ver, unchanged: true };
  else out = { type: "friend_library", uid, ver, games: ver > 0 ? r.games : [] };
  try { ws.send(JSON.stringify(out)); } catch { /* closing */ }
}

/* Internal route lib_get on the owner's hub. */
export function internalLibGet(hub, from, b) {
  if (!hub.isFriend(from) || hub.isBlocked(from)) return { r: "ok", ver: 0 };
  if (!!b.test !== hub.isTestAccount()) return { r: "ok", ver: 0 };
  const row = glibRow(hub);
  if (!row.share || row.ver <= 0) return { r: "ok", ver: 0 };
  return { r: "ok", ver: row.ver, games: JSON.parse(row.games) };
}
