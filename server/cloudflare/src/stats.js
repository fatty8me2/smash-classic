// Lightweight operational counters + the admin-only GET /admin/stats summary.
//
//   GET /admin/stats   Authorization: Bearer <ADMIN_TOKEN>
//     404 when the ADMIN_TOKEN secret is not configured (the route does not exist).
//     401 without the right token (compared in constant time).
//
// Counters (daily buckets, UTC): rooms (host rooms created), relay_secs (relay seconds, summed when a relayed
// room closes), desync (client desync reports), v:<version> (host/join connections per game version).
//
// Hot-path cost: bump() only touches an in-memory Map in the current isolate. flushDue() sends the Map to the
// single OpsStats Durable Object at most once per minute per isolate (one DO request, a few upserts), and only
// when something was counted. Losing an unflushed minute on eviction is acceptable: these are approximate.
//
// Storage: one SQLite table `daily(day, k, n)`, pruned to the last 30 days. Free plan (SQLite-backed DO class).

import { DurableObject } from "cloudflare:workers";

const FLUSH_MS = 60 * 1000;
const KEEP_DAYS = 30;
const WEEK_DAYS = 7;
const SEP = "\u0001";
const VER_RE = /^[A-Za-z0-9._-]{1,16}$/;

const pending = new Map();   // `${day}${SEP}${key}` -> n (this isolate only)
let lastFlush = 0;

const utcDay = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const daysBack = (n) => utcDay(Date.now() - n * 24 * 3600 * 1000);

export function count(key, n = 1) {
  if (!n) return;
  const k = utcDay() + SEP + key;
  pending.set(k, (pending.get(k) || 0) + n);
}

// Version strings are client-supplied: only plain tokens are counted.
export function countVersion(ver) {
  if (typeof ver === "string" && VER_RE.test(ver)) count("v:" + ver);
}

// Send pending counts to the OpsStats DO if the last flush is over a minute old (or never happened).
// `waitUntil` keeps the isolate alive for the write; the request itself never waits on it.
export function flushDue(env, waitUntil, force = false) {
  if (!pending.size || !env.OPS_STATS) return;
  const now = Date.now();
  if (!force && now - lastFlush < FLUSH_MS) return;
  lastFlush = now;
  const batch = [...pending];
  pending.clear();
  const rows = batch.map(([k, n]) => {
    const i = k.indexOf(SEP);
    return [k.slice(0, i), k.slice(i + 1), n];
  });
  const p = env.OPS_STATS.get(env.OPS_STATS.idFromName("global")).fetch("https://stats/bump", {
    method: "POST", headers: { "x-rh-internal": "1", "content-type": "application/json" },
    body: JSON.stringify({ rows }),
  }).then((r) => { if (!r.ok) throw new Error("stats " + r.status); }).catch(() => {
    for (const [k, n] of batch) pending.set(k, (pending.get(k) || 0) + n);   // keep them for the next flush
  });
  waitUntil(p);
}

// Constant-time string comparison (no early exit on the first differing byte).
export function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a), y = enc.encode(b);
  const n = Math.max(x.length, y.length);
  let d = x.length ^ y.length;
  for (let i = 0; i < n; i++) d |= (x[i] || 0) ^ (y[i] || 0);
  return d === 0;
}

export class OpsStats extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS daily (day TEXT NOT NULL, k TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, k))`);
    this.pruned = "";
  }

  async fetch(request) {
    if (request.headers.get("x-rh-internal") !== "1") return new Response("no", { status: 403 });
    const url = new URL(request.url);
    if (url.pathname === "/bump") {
      const { rows } = await request.json();
      for (const [day, k, n] of rows) {
        if (typeof day !== "string" || typeof k !== "string" || !Number.isFinite(n) || n < 0) continue;
        this.sql.exec(`INSERT INTO daily(day,k,n) VALUES(?,?,?) ON CONFLICT(day,k) DO UPDATE SET n=n+excluded.n`, day, k, Math.floor(n));
      }
      const today = utcDay();
      if (this.pruned !== today) {       // at most one prune per UTC day per instance
        this.pruned = today;
        this.sql.exec(`DELETE FROM daily WHERE day < ?`, daysBack(KEEP_DAYS));
      }
      return Response.json({ ok: true });
    }
    if (url.pathname === "/read") {
      const rows = this.sql.exec(`SELECT day,k,n FROM daily WHERE day >= ? ORDER BY day`, daysBack(WEEK_DAYS - 1)).toArray();
      return Response.json({ today: utcDay(), rows });
    }
    return new Response("not found", { status: 404 });
  }
}

// ---- admin summary ----

const json = (obj, status = 200) => new Response(JSON.stringify(obj, null, 2), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store" },
});

// Routed from src/index.js. Never called on hot paths.
export async function adminStatsFetch(request, env, waitUntil) {
  if (!env.ADMIN_TOKEN) return new Response("not found", { status: 404 });
  if (request.method !== "GET") return new Response("method not allowed", { status: 405, headers: { allow: "GET" } });
  const auth = request.headers.get("authorization") || "";
  const given = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!safeEqual(given, env.ADMIN_TOKEN)) return json({ error: "unauthorized" }, 401);

  // This isolate's pending counts first, so a read right after activity sees it.
  flushDue(env, waitUntil, true);

  const budgetStub = env.R2_BUDGET.get(env.R2_BUDGET.idFromName("global"));
  const b = await (await budgetStub.fetch("https://budget/b", {
    method: "POST", headers: { "x-rh-internal": "1", "content-type": "application/json" },
    body: JSON.stringify({ op: "status" }),
  })).json();
  const c = b.caps;
  const stub = env.OPS_STATS.get(env.OPS_STATS.idFromName("global"));
  const s = await (await stub.fetch("https://stats/read", { headers: { "x-rh-internal": "1" } })).json();

  const today = s.today;
  const clientVersions = {};
  const roomsToday = { rooms: 0, relayMinutes: 0, desync: 0 };
  let relaySecs = 0;
  for (const { day, k, n } of s.rows) {
    if (k.startsWith("v:")) {
      clientVersions[k.slice(2)] = (clientVersions[k.slice(2)] || 0) + n;   // week total
    } else if (day === today) {
      if (k === "rooms") roomsToday.rooms += n;
      else if (k === "relay_secs") relaySecs += n;
      else if (k === "desync") roomsToday.desync += n;
    }
  }
  roomsToday.relayMinutes = Math.round((relaySecs / 60) * 10) / 10;

  return json({
    generated: new Date().toISOString(),
    r2: {
      month: b.month,
      storedBytes: b.total, storageCapBytes: c.storage,
      classA: { used: b.a, cap: c.a }, classB: { used: b.b, cap: c.b },
    },
    durableObjects: {
      day: b.day,
      rowsWritten: b.rows, rowsCap: c.rows,
      rowsRead: b.reads, rowsReadCap: c.reads,
      wallMs: b.ms, wallMsCap: c.ms,
    },
    paused: {
      classA: b.a >= c.a, classB: b.b >= c.b, storage: b.total >= c.storage,
      dailyDo: b.rows >= c.rows || b.reads >= c.reads || b.ms >= c.ms,
      reconcileDirty: !!b.dirty,
    },
    counters: {
      day: today,
      today: roomsToday,
      clientVersionsWeek: clientVersions,
    },
  });
}
