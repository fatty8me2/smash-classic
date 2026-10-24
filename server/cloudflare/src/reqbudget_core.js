// Pure helpers for the daily request budget (no Workers imports, so Node tests can load them). See reqbudget.js.

export const DEFAULT_DAILY_CAP = 100_000;
export const RELAY_NEW_FRAC = 0.5;
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

