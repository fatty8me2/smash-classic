// Pure helpers for the daily request budget (no Workers imports, so Node tests can load them). See reqbudget.js.

export const DEFAULT_DAILY_CAP = 100_000;
export const RELAY_NEW_FRAC = 0.5;
export const SPECTATE_FRAC = 0.5;
export const ROOM_NEW_FRAC = 0.7;
export const RELAY_STOP_FRAC = 0.9;
export const FRAMES_PER_UNIT = 20;
export const RELAY_ROOM_MSGS_PER_SEC = 400;   // game sends ~60 frames/s per player; 4 players -> ~240
export const FLUSH_MS = 30 * 1000;

export const utcDay = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

// Pure: what is allowed given today's total units and the cap.
export function verdict(total, cap = DEFAULT_DAILY_CAP) {
  const c = Number.isFinite(cap) && cap > 0 ? cap : DEFAULT_DAILY_CAP;
  return {
    total, cap: c,
    relayNew: total < c * RELAY_NEW_FRAC,
    spectate: total < c * SPECTATE_FRAC,
    roomNew: total < c * ROOM_NEW_FRAC,
    relayFrames: total < c * RELAY_STOP_FRAC,
  };
}

// Pure: per-day running total with UTC-day rollover (used by the DO and by the in-isolate fallback).
export class DayLedger {
  constructor(now = () => Date.now()) { this.now = now; this.day = utcDay(now()); this.total = 0; }
  add(n) {
    const d = utcDay(this.now());
    if (d !== this.day) { this.day = d; this.total = 0; }
    if (n > 0) this.total += n;
    return this.total;
  }
  get() { return this.add(0); }
}

// Pure: units for a batch of counted events.
export const unitsOf = (requests, frames) => Math.max(0, requests) + Math.max(0, frames) / FRAMES_PER_UNIT;

// ---- Full billable-unit model (Workers + Durable Objects) ----
// Cloudflare free-tier limits (https://developers.cloudflare.com/durable-objects/platform/pricing/ and
// https://developers.cloudflare.com/workers/platform/limits/, checked 2026-10-24; reset 00:00 UTC):
//   Workers:         100,000 requests/day
//   Durable Objects: 100,000 requests/day (alarm invocations count), 13,000 GB-s duration/day,
//                    5M rows read/day, 100,000 rows written/day (each setAlarm() = 1 row written), 5 GB stored.
//   DO WebSocket:    incoming messages billed 20:1 as requests (100 msgs = 5 requests); outgoing messages and
//                    protocol pings are free; hibernated objects accrue no duration.
// Exceeding a limit makes that operation fail (no overage charge on the free plan), but we still degrade early.
// One combined "unit" = 1 Worker request + 1 DO request + 1 DO alarm + 1/20 incoming DO WS message. Summing the
// Workers and DO counters is deliberately conservative: it is >= each individual limit's usage, so the combined
// thresholds (50/70/90% of 100k) keep every separate limit below 90% of its own free cap.
export const DEFAULT_DAILY_DUR_CAP = 13_000;    // GB-s per day (DO free tier)
export const DO_MEMORY_GB = 0.128;              // DO billed at 128 MB
export const DUR_SECS_PER_DO_REQ = 0.05;        // estimated wall time an awake DO spends per request/alarm
export const DUR_SECS_PER_WS_MSG = 0.005;       // ... per incoming WS message (hibernation API wakes briefly)
export const EMPTY_COUNTS = Object.freeze({ reqs: 0, frames: 0, doReqs: 0, wsMsgs: 0, alarms: 0, gbs: 0 });

// Pure: estimated DO duration in GB-s for the counted DO events (plus any explicit awake seconds).
export const durationGbs = (c, extraSecs = 0) =>
  DO_MEMORY_GB * (Math.max(0, c.doReqs || 0) * DUR_SECS_PER_DO_REQ + Math.max(0, c.alarms || 0) * DUR_SECS_PER_DO_REQ
    + Math.max(0, c.wsMsgs || 0) * DUR_SECS_PER_WS_MSG + Math.max(0, extraSecs));

// Pure: request-like units for a batch (frames and wsMsgs are both billed 20:1).
export const unitsOfAll = (c) =>
  Math.max(0, c.reqs || 0) + Math.max(0, c.doReqs || 0) + Math.max(0, c.alarms || 0)
  + (Math.max(0, c.frames || 0) + Math.max(0, c.wsMsgs || 0)) / FRAMES_PER_UNIT;

// Pure: fold duration pressure into the request-unit axis so one verdict() covers both limits:
// durGbs/durCap of the day gone counts like the same fraction of the request cap.
export const effectiveTotal = (units, gbs, cap = DEFAULT_DAILY_CAP, durCap = DEFAULT_DAILY_DUR_CAP) =>
  Math.max(units, durCap > 0 ? (gbs / durCap) * cap : 0);

export const sumCounts = (a, b) => {
  const o = { ...EMPTY_COUNTS };
  for (const k of Object.keys(o)) o[k] = (Number(a && a[k]) || 0) + (Number(b && b[k]) || 0);
  return o;
};

// Presence refresh interval for the UserHub alarm: lease/3 of ONLINE_LEASE_MS (friends.js). Lease raised 3 -> 10 min
// so the alarm fires every ~3.3 min instead of every 60 s (about 3.3x fewer alarms, rows written and DO requests per
// connected account per day: 1440 -> 432).
export const PRESENCE_LEASE_MS = 10 * 60 * 1000;
export const presenceAlarmMs = (lease = PRESENCE_LEASE_MS) => Math.round(lease / 3);

