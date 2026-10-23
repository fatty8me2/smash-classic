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
  }

  take(bytes) {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.rate);
    this.last = t;
    if (bytes > this.tokens) return false;
    this.tokens -= bytes;
    return true;
  }
}

// Presence fan-out target selection: the friends that are currently online,
// capped at `cap` (oldest links first, as the friends list is ordered).
export function onlineTargets(friendUids, onlineSet, cap = Infinity) {
  const out = [];
  for (const uid of friendUids) {
    if (out.length >= cap) break;
    if (onlineSet.has(uid)) out.push(uid);
  }
  return out;
}

// Constants. Relay: worst case from the game is ~60 frames/s x 1024 bytes per
// frame from one socket (about 61 KB/s); the bucket allows 8x that sustained.
export const RELAY_BYTES_PER_SEC = 512 * 1024;
export const RELAY_BURST_BYTES = 2 * 1024 * 1024;
export const ROOMS_PER_IP_PER_MIN = 30;
export const FRIENDS_MSGS_PER_MIN = 300;
