// Pure rate-limit helpers shared by the Worker and the Node tests.
// No bindings, no storage: callers keep the state in memory (per isolate or per
// Durable Object instance). Losing it on eviction only resets a counter.

// Fixed-window counter keyed by string. Used for room creation per client IP.
export class FixedWindow {
  constructor(limit, windowMs, now = () => Date.now()) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.map = new Map();
  }

  // true = allowed (and counted); false = over the limit.
  hit(key) {
    const t = this.now();
    let row = this.map.get(key);
    if (!row || t - row.start >= this.windowMs) {
      row = { start: t, n: 0 };
      this.map.set(key, row);
      // Keep the map bounded: drop expired rows when it grows.
      if (this.map.size > 10000) {
        for (const [k, r] of this.map) if (t - r.start >= this.windowMs) this.map.delete(k);
      }
    }
    if (row.n >= this.limit) return false;
    row.n++;
    return true;
  }
}

// Token bucket for relayed bytes on one socket. `ratePerSec` sustained,
// `burst` bytes allowed at once. A frame larger than the bucket is refused.
export class ByteBucket {
  constructor(ratePerSec, burst, now = () => Date.now()) {
    this.rate = ratePerSec;
    this.burst = burst;
    this.now = now;
    this.tokens = burst;
    this.last = now();
    this.overSince = 0;
  }

  // Tracks how long the bucket has been refusing without a single success.
  // Returns true when frames have been refused continuously for >= ms.
  sustainedOver(ms) {
    return this.overSince !== 0 && this.now() - this.overSince >= ms;
  }

  take(bytes) {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.rate);
    this.last = t;
    if (bytes > this.tokens) {
      if (!this.overSince) this.overSince = t;
      return false;
    }
    this.overSince = 0;
    this.tokens -= bytes;
    return true;
  }
}

// ---- presence fan-out ----
// One presence event is one Directory call plus one Durable Object call per target, and the Workers Free plan allows 50
// subrequests per invocation (checked 2026-11-01), so an event reaches at most this many friends. The rest are reached by
// the rotation below and always re-sync on their own next hello (their fan-out pulls our current status from the reply).
export const PRESENCE_FANOUT_CAP = 40;

// Presence fan-out target selection: the friends that are currently online, in list order. When more than `cap` are online,
// the `cap` LEAST RECENTLY SERVED ones (never served first; ties broken by list order, rotated by `offset`). `served` maps a
// uid to the sequence number of the last event that reached it (see FanoutRotation, which stamps it), so the same friends are
// never the ones skipped: a friend who stays online is reached within ceil(n / cap) events, however the list churns.
export function onlineTargets(friendUids, onlineSet, cap = Infinity, served = null, offset = 0) {
  const on = [];
  for (const uid of friendUids) if (onlineSet.has(uid)) on.push(uid);
  const n = on.length;
  if (!(cap >= 0) || n <= cap) return on;
  const off = (((Math.trunc(Number(offset)) || 0) % n) + n) % n;
  return on
    .map((uid, i) => ({ uid, k: (served && served.get(uid)) || 0, r: (i - off + n) % n }))
    .sort((a, b) => a.k - b.k || a.r - b.r)
    .slice(0, cap)
    .map((x) => x.uid);
}

// The state behind onlineTargets for one account (in memory; a hub that wakes up starts with a time-derived `offset`, so it is
// not always the same friends that come first). pick() returns the targets of the next event and, when the event was capped,
// stamps them as served.
export class FanoutRotation {
  constructor(offset = 0) { this.served = new Map(); this.seq = 0; this.offset = offset; }
  pick(friendUids, onlineSet, cap) {
    let online = 0;
    for (const uid of friendUids) if (onlineSet.has(uid)) online++;
    const targets = onlineTargets(friendUids, onlineSet, cap, this.served, this.offset);
    if (targets.length < online) {   // capped: the next event starts with the friends this one skipped
      this.seq++;
      for (const uid of targets) this.served.set(uid, this.seq);
      if (this.served.size > 2 * friendUids.length + 64) {   // forget friends that are gone
        const keep = new Set(friendUids);
        for (const uid of [...this.served.keys()]) if (!keep.has(uid)) this.served.delete(uid);
      }
    }
    return targets;
  }
}

// Constants. Relay: worst case from the game is ~60 frames/s x 1024 bytes per
// frame from one socket (about 61 KB/s); the bucket allows 8x that sustained.
// Over-budget frames are dropped (never a close for a short burst); a socket is closed only after
// RELAY_ABUSE_MS of continuous over-budget traffic (sustained abuse, not a save-exchange burst).
export const RELAY_BYTES_PER_SEC = 1024 * 1024;
export const RELAY_BURST_BYTES = 4 * 1024 * 1024;
export const RELAY_ABUSE_MS = 10 * 1000;
export const ROOMS_PER_IP_PER_MIN = 30;
export const FRIENDS_MSGS_PER_MIN = 300;

// ---- /hub (RetroHub rooms): per-IP limits and relay notices ----
// Same shape as the /ws guards in index.js (in memory, per isolate, best effort; loopback is never limited, see ipKey).
export const HUB_ROOMS_PER_IP_PER_MIN = 30;     // role=host sockets (lobby and game rooms) one address may open per minute
export const HUB_SOCKETS_PER_IP_PER_MIN = 120;  // any /hub socket (host, join, watch) per minute: a LAN party and reconnects fit easily
export const RELAY_NOTICE_MS = 10 * 1000;       // a socket is told "relay_denied" at most this often

// ---- text frames inside a room ----
// The real control traffic of a room socket is a handful of frames a minute, except the announcement of a joining RetroHub:
// its game library goes out in parts of 3000 bytes (about 17 parts per 1000 games), again whenever the membership changes. So the
// budget is generous: 50/s sustained with a burst of 600 never touches a client, even with a library of thousands of games.
// Over-budget frames are dropped; a socket that stays over budget for TEXT_ABUSE_MS (a flood, not a burst) is closed.
export const TEXT_MSGS_PER_SEC = 50;
export const TEXT_BURST = 600;
export const TEXT_ABUSE_MS = 5 * 1000;

// Per-socket limiter (a WeakMap of ByteBuckets, so closed sockets cost nothing). check(): 0 = pass, 1 = drop the frame,
// 2 = drop it and close the socket: frames have been dropped for abuseMs in a row, i.e. with no quiet gap of DROP_GAP_MS between
// two drops. (ByteBucket.sustainedOver cannot tell: it resets on every frame that fits, and a flood always gets its refill
// through.) A client whose burst runs over the budget for a moment is dropped from, never closed.
const DROP_GAP_MS = 1000;
export class SocketLimiter {
  constructor(rate, burst, abuseMs, now = () => Date.now()) {
    this.rate = rate; this.burst = burst; this.abuseMs = abuseMs; this.now = now;
    this.map = new WeakMap();
  }
  check(ws, cost = 1) {
    let s = this.map.get(ws);
    if (!s) { s = { bucket: new ByteBucket(this.rate, this.burst, this.now), first: 0, last: 0 }; this.map.set(ws, s); }
    if (s.bucket.take(cost)) return 0;
    const t = this.now();
    if (!s.first || t - s.last > DROP_GAP_MS) s.first = t;   // a quiet gap ends the streak
    s.last = t;
    return t - s.first >= this.abuseMs ? 2 : 1;
  }
}

// ---- stats counters keyed by client-supplied text ----
// The game version of a /ws connection ends up as a counter row (one stored row per distinct key per flush), and the caller is
// anonymous: only a plain x.y.z (or "-" for none) is accepted, and after `max` distinct values in a UTC day in this isolate the
// rest are counted together as "other". key() returns "" for text that is not a version (not counted at all).
export class VersionKeys {
  constructor(max = 32, now = () => Date.now()) {
    this.max = max; this.now = now; this.day = ""; this.seen = new Set();
  }
  key(ver) {
    if (ver === "-") return "-";
    if (typeof ver !== "string" || !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ver)) return "";
    const d = new Date(this.now()).toISOString().slice(0, 10);
    if (d !== this.day) { this.day = d; this.seen.clear(); }
    if (this.seen.has(ver)) return ver;
    if (this.seen.size >= this.max) return "other";
    this.seen.add(ver);
    return ver;
  }
}

// ---- /hub ident (account proof used for auto-friending) ----
export const IDENT_TRIES_PER_SOCKET = 3;        // a seat sends one ident per welcome; retries beyond this are ignored
export const IDENT_PER_ROOM_PER_HOUR = 24;
// ---- /hub launch replay (the host's latest launch message, stored for late spectators) ----
export const LAUNCH_WRITES_PER_HOUR = 20;       // storage writes per room per hour; a host launches a handful of times

// ---- /friends: sockets that have not said hello yet ----
export const HELLO_DEADLINE_MS = 30 * 1000;     // hello must arrive within this long of the upgrade
export const PREAUTH_MAX_FRAMES = 3;            // frames a socket may send before it is authenticated (hello plus retries)
export const MAX_UNAUTHED_SOCKETS = 8;          // parked unauthenticated sockets per account; the oldest are closed to make room

// ---- client address keys ----
// Rate-limit key for a client address: IPv4 as is, IPv6 reduced to its /64 (a household or a rented host owns a whole /64, so
// per-address limits would mean nothing). "" = no key: missing, malformed, or loopback. Local `wrangler dev` reports 127.0.0.1
// for every client (checked on wrangler 4.152.0, where a client-supplied CF-Connecting-IP also passes through), and Cloudflare
// never reports loopback for a real client, so loopback is simply never limited and local tests keep working.
export function ipKey(ip) {
  if (typeof ip !== "string") return "";
  let s = ip.trim().toLowerCase();
  if (!s || s.length > 45) return "";
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);   // IPv4-mapped IPv6
  if (mapped) s = mapped[1];
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(s)) {
    const o = s.split(".").map(Number);
    if (o.some((n) => n > 255) || o[0] === 127 || o.every((n) => n === 0)) return "";
    // Private / link-local ranges never reach Cloudflare as a client address (a LAN test of a local wrangler does): never limited.
    if (o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168) || (o[0] === 169 && o[1] === 254)) return "";
    return s;
  }
  if (!s.includes(":") || !/^[0-9a-f:]+$/.test(s)) return "";
  let groups;
  const dc = s.indexOf("::");
  if (dc >= 0) {
    if (s.indexOf("::", dc + 1) >= 0) return "";
    const a = s.slice(0, dc) ? s.slice(0, dc).split(":") : [];
    const b = s.slice(dc + 2) ? s.slice(dc + 2).split(":") : [];
    if (a.length + b.length > 7) return "";
    groups = [...a, ...Array(8 - a.length - b.length).fill("0"), ...b];
  } else {
    groups = s.split(":");
  }
  if (groups.length !== 8 || groups.some((x) => !/^[0-9a-f]{1,4}$/.test(x))) return "";
  const g = groups.map((x) => parseInt(x, 16));
  if (g.every((n) => n === 0) || (g.slice(0, 7).every((n) => n === 0) && g[7] === 1)) return "";   // :: and ::1
  if ((g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80) return "";   // unique-local and link-local
  return "v6:" + g.slice(0, 4).map((n) => n.toString(16)).join(":");
}

// ---- new-account limits (open registration is the root of most abuse: account farms fill cloud storage, the owner's
// friend list and the usernames) ----
// Counted per UTC day in the Directory, for accounts that really are new (the first hello of a uid). Accounts created by test
// clients ("test":true or a qa- name) have their own, separate counters so they can never use up the real ones. Loopback
// clients (local wrangler) are not limited at all. Refusals leave existing accounts untouched.
export const REG_PER_IP_PER_DAY = 6;            // new accounts per address (IPv6: per /64): a family or a small LAN party fits
export const REG_GLOBAL_PER_DAY = 100;          // new accounts the whole service takes in a day (one registration measures ~10 DO requests and ~60-80 rows: 100 a day = ~8% of the rows budget)
export const REG_TEST_PER_IP_PER_DAY = 30;
export const REG_TEST_GLOBAL_PER_DAY = 100;

// The four limits, with optional overrides from the environment (REG_PER_IP, REG_GLOBAL, REG_TEST_PER_IP, REG_TEST_GLOBAL;
// local tests only, unset in production). An override of 0 refuses everything of that kind.
export function regLimits(env = {}) {
  const n = (k, d) => {
    const raw = env && env[k];
    if (raw === undefined || raw === null || raw === "") return d;
    const v = Number(raw);
    return Number.isFinite(v) && v >= 0 ? Math.floor(v) : d;
  };
  return {
    ip: { real: n("REG_PER_IP", REG_PER_IP_PER_DAY), test: n("REG_TEST_PER_IP", REG_TEST_PER_IP_PER_DAY) },
    global: { real: n("REG_GLOBAL", REG_GLOBAL_PER_DAY), test: n("REG_TEST_GLOBAL", REG_TEST_GLOBAL_PER_DAY) },
  };
}

// Pure decision: null = accept, "global" = the service-wide daily limit is used up, "ip" = this address used its share.
// `used` = { ip, global } counts so far today. The service-wide limit is checked first (it is the more useful message).
export function regDecision(used, limits, test) {
  const kind = test ? "test" : "real";
  if (used.global >= limits.global[kind]) return "global";
  if (used.ip >= limits.ip[kind]) return "ip";
  return null;
}

// Whole seconds until the next 00:00 UTC (when every daily counter resets); at least 1.
export function secondsToUtcMidnight(t = Date.now()) {
  const d = new Date(t);
  return Math.max(1, Math.ceil((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - t) / 1000));
}
