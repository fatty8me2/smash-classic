// Global daily request budget (cost guard). HARD RULE: stay far below the Workers free plan (100k requests/day) so a
// traffic spike degrades the relay instead of costing money.
//
// Unit = one billed request: a Worker fetch counts 1; relayed WebSocket frames count 1/20 each (Durable Objects bill
// incoming WS messages at 20:1). Counting is approximate and errs high.
//
// Thresholds (fractions of the daily cap, default 100,000 units/UTC day; override with the DAILY_REQ_CAP var):
//   >= 50%  no NEW relay sessions   (clients are told "server-busy"; they can still connect directly over UDP)
//   >= 70%  no NEW rooms            (/ws role=host refused with reason "server-busy")
//   >= 90%  relayed frames dropped  (relay sessions in progress stop; direct play is unaffected)
// Per-room relay rate cap: RELAY_ROOM_MSGS_PER_SEC frames/s sustained (burst 2x), excess dropped.
//
// Hot path cost: note() only bumps in-memory numbers. flush() sends them to the single ReqBudget DO at most every
// FLUSH_MS per isolate (one DO request) and caches the verdict, so the DO is never on the per-request path.
// When the DO cannot be reached the last verdict is kept, but the isolate's own count still grows and applies
// (fail closed on the local number).

import { DurableObject } from "cloudflare:workers";

import { DEFAULT_DAILY_CAP, FRAMES_PER_UNIT, utcDay, verdict, DayLedger, unitsOf } from "./reqbudget_core.js";
export * from "./reqbudget_core.js";

// ---- per-isolate gate (module state) ----
const g = {
  reqs: 0, frames: 0,            // not yet flushed
  local: new DayLedger(),        // everything this isolate saw today (fallback if the DO is unreachable)
  remote: 0, remoteDay: "",      // last total reported by the DO
  lastFlush: 0, flushing: false,
};

export function resetGateForTests() {
  g.reqs = 0; g.frames = 0; g.local = new DayLedger(); g.remote = 0; g.remoteDay = ""; g.lastFlush = 0; g.flushing = false;
}

export const noteRequest = (n = 1) => { g.reqs += n; g.local.add(n); };
export const noteRelayFrame = () => { g.frames++; g.local.add(1 / FRAMES_PER_UNIT); };

function capOf(env) {
  const n = Number(env && env.DAILY_REQ_CAP);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DAILY_CAP;
}

// Current verdict from the cached DO total (if from today) or this isolate's count, whichever is higher.
export function gate(env, waitUntil) {
  maybeFlush(env, waitUntil);
  const today = utcDay();
  const total = Math.max(g.remoteDay === today ? g.remote : 0, g.local.get());
  return verdict(total, capOf(env));
}

export function maybeFlush(env, waitUntil, force = false) {
  if (!env || !env.REQ_BUDGET || g.flushing) return;
  const now = Date.now();
  if (!force && now - g.lastFlush < FLUSH_MS) return;
  g.lastFlush = now;
  g.flushing = true;
  const reqs = g.reqs, frames = g.frames;
  g.reqs = 0; g.frames = 0;
  const p = env.REQ_BUDGET.get(env.REQ_BUDGET.idFromName("global")).fetch("https://reqbudget/add", {
    method: "POST", headers: { "x-rh-internal": "1", "content-type": "application/json" },
    body: JSON.stringify({ reqs, frames }),
  }).then(async (r) => {
    if (!r.ok) throw new Error("reqbudget " + r.status);
    const j = await r.json();
    g.remote = j.total; g.remoteDay = j.day;
  }).catch(() => { g.reqs += reqs; g.frames += frames; })   // keep the counts for the next flush
    .finally(() => { g.flushing = false; });
  if (waitUntil) waitUntil(p);
}

export class ReqBudget extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ledger = new DayLedger();
    ctx.blockConcurrencyWhile(async () => {
      const s = await ctx.storage.get("st");
      if (s && s.day === utcDay()) { this.ledger.day = s.day; this.ledger.total = s.total; }
    });
  }
  async fetch(request) {
    if (request.headers.get("x-rh-internal") !== "1") return new Response("no", { status: 403 });
    const b = await request.json().catch(() => ({}));
    const total = this.ledger.add(unitsOf(Number(b.reqs) || 0, Number(b.frames) || 0));
    await this.ctx.storage.put("st", { day: this.ledger.day, total });   // one small write per flush
    return Response.json({ ok: true, day: this.ledger.day, total });
  }
}
