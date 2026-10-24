// Global daily request budget (cost guard). HARD RULE: stay far below the Cloudflare free plan so a traffic spike
// degrades the service instead of costing money. Limits (cited again in reqbudget_core.js): Workers 100k requests/day;
// Durable Objects 100k requests/day (alarms included), 13,000 GB-s/day, 100k rows written/day, incoming WebSocket
// messages billed 20:1 (https://developers.cloudflare.com/durable-objects/platform/pricing/).
//
// Every billable unit is counted:
//   reqs    Worker fetches (index.js)                          1 each
//   doReqs  requests arriving at a Durable Object (fetch())    1 each (Worker->DO and DO->DO)
//   wsMsgs  incoming WebSocket messages in /hub and /friends   1/20 each (hibernation 20:1 ratio)
//   frames  relayed /ws frames (NetplayRoom)                   1/20 each
//   alarms  DO alarm invocations (presence refresh)            1 each
//   gbs     DO duration estimate (128 MB x estimated awake secs per event), compared with the 13,000 GB-s cap
// Units are summed across Workers and DOs, which over-counts relative to each separate limit (conservative).
//
// Thresholds (fractions of the daily cap, default 100,000 units/UTC day; override with the DAILY_REQ_CAP var;
// duration pressure = gbs / DAILY_DUR_CAP is folded in as the same fraction of the cap):
//   >= 50%  no NEW relay sessions   (clients are told "server-busy"; they can still connect directly over UDP)
//   >= 70%  no NEW rooms            (/ws and /hub role=host refused with reason "server-busy")
//   >= 90%  relayed frames dropped, hub binary relay dropped, new /friends sockets refused, presence alarms stop
// Per-room relay rate cap: RELAY_ROOM_MSGS_PER_SEC frames/s sustained (burst 2x), excess dropped.
//
// Hot path cost: note*() only bump in-memory numbers. maybeFlush() sends them to the single ReqBudget DO at most every
// FLUSH_MS (30 s) per isolate (one DO request) and caches the verdict, so the DO is never on the per-request path.
// When the DO cannot be reached the last verdict is kept, but the isolate's own count still grows and applies
// (fail closed on the local number).

import { DurableObject } from "cloudflare:workers";

import {
  DEFAULT_DAILY_CAP, DEFAULT_DAILY_DUR_CAP, FRAMES_PER_UNIT, FLUSH_MS, utcDay, verdict, DayLedger,
  unitsOfAll, durationGbs, effectiveTotal, sumCounts, EMPTY_COUNTS,
} from "./reqbudget_core.js";
export * from "./reqbudget_core.js";

// ---- per-isolate gate (module state) ----
const g = {
  pending: { ...EMPTY_COUNTS },  // not yet flushed
  units: new DayLedger(),        // everything this isolate saw today (fallback if the DO is unreachable)
  gbs: new DayLedger(),
  remote: 0, remoteDay: "",      // last effective total reported by the DO
  lastFlush: 0, flushing: false,
};

export function resetGateForTests() {
  g.pending = { ...EMPTY_COUNTS }; g.units = new DayLedger(); g.gbs = new DayLedger();
  g.remote = 0; g.remoteDay = ""; g.lastFlush = 0; g.flushing = false;
}

function note(c) {
  for (const k of Object.keys(c)) g.pending[k] += c[k];
  g.units.add(unitsOfAll(c));
  g.gbs.add(durationGbs(c));
}
export const noteRequest = (n = 1) => note({ reqs: n });
export const noteRelayFrame = () => note({ frames: 1 });
export const noteDoRequest = (n = 1) => note({ doReqs: n });
export const noteWsMessage = (n = 1) => note({ wsMsgs: n });
export const noteAlarm = (n = 1) => note({ alarms: n });
export const pendingCounts = () => ({ ...g.pending });

function capOf(env, key, dflt) {
  const n = Number(env && env[key]);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

// Current verdict from the cached DO total (if from today) or this isolate's count, whichever is higher.
export function gate(env, waitUntil) {
  maybeFlush(env, waitUntil);
  const today = utcDay();
  const cap = capOf(env, "DAILY_REQ_CAP", DEFAULT_DAILY_CAP);
  const local = effectiveTotal(g.units.get(), g.gbs.get(), cap, capOf(env, "DAILY_DUR_CAP", DEFAULT_DAILY_DUR_CAP));
  return verdict(Math.max(g.remoteDay === today ? g.remote : 0, local), cap);
}

// Cheap hook for Durable Objects: count one event kind and flush if due. `ctx` is the DO's ctx (for waitUntil).
export function meter(env, ctx, kind) {
  if (kind === "do") noteDoRequest(); else if (kind === "ws") noteWsMessage(); else if (kind === "alarm") noteAlarm();
  maybeFlush(env, ctx && ctx.waitUntil ? (p) => ctx.waitUntil(p) : undefined);
}

export function maybeFlush(env, waitUntil, force = false) {
  if (!env || !env.REQ_BUDGET || g.flushing) return;
  const now = Date.now();
  if (!force && now - g.lastFlush < FLUSH_MS) return;
  g.lastFlush = now;
  g.flushing = true;
  const sent = g.pending;
  g.pending = { ...EMPTY_COUNTS };
  const p = env.REQ_BUDGET.get(env.REQ_BUDGET.idFromName("global")).fetch("https://reqbudget/add", {
    method: "POST", headers: { "x-rh-internal": "1", "content-type": "application/json" },
    body: JSON.stringify(sent),
  }).then(async (r) => {
    if (!r.ok) throw new Error("reqbudget " + r.status);
    const j = await r.json();
    g.remote = j.total; g.remoteDay = j.day;
  }).catch(() => { g.pending = sumCounts(g.pending, sent); })   // keep the counts for the next flush
    .finally(() => { g.flushing = false; });
  if (waitUntil) waitUntil(p);
}

export class ReqBudget extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.units = new DayLedger();
    this.gbs = new DayLedger();
    ctx.blockConcurrencyWhile(async () => {
      const s = await ctx.storage.get("st");
      if (s && s.day === utcDay()) {
        this.units.day = s.day; this.units.total = Number(s.units ?? s.total) || 0;
        this.gbs.day = s.day; this.gbs.total = Number(s.gbs) || 0;
      }
    });
  }
  async fetch(request) {
    if (request.headers.get("x-rh-internal") !== "1") return new Response("no", { status: 403 });
    const b = await request.json().catch(() => ({}));
    const c = {};
    for (const k of Object.keys(EMPTY_COUNTS)) c[k] = Number(b[k]) || 0;
    c.doReqs += 1;   // this flush request itself is a billed DO request
    const units = this.units.add(unitsOfAll(c));
    const gbs = this.gbs.add(durationGbs(c));
    const total = effectiveTotal(units, gbs, capOf(this.env, "DAILY_REQ_CAP", DEFAULT_DAILY_CAP),
      capOf(this.env, "DAILY_DUR_CAP", DEFAULT_DAILY_DUR_CAP));
    await this.ctx.storage.put("st", { day: this.units.day, units, gbs });   // one small write per flush
    return Response.json({ ok: true, day: this.units.day, total, units, gbs });
  }
}
