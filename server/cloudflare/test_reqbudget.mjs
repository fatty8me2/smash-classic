// Pure unit tests for src/reqbudget.js helpers (no wrangler needed). Run: node test_reqbudget.mjs
import { verdict, DayLedger, unitsOf, DEFAULT_DAILY_CAP } from "./src/reqbudget_core.js";
import { ByteBucket } from "./src/limits.js";
let bad = 0;
const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) bad++; };
let v = verdict(0);
ok(v.relayNew && v.roomNew && v.relayFrames, "fresh day allows everything");
v = verdict(50_000); ok(!v.relayNew && v.roomNew && v.relayFrames, "50% stops new relay only");
v = verdict(70_000); ok(!v.roomNew && v.relayFrames, "70% stops new rooms");
v = verdict(90_000); ok(!v.relayFrames, "90% drops relay frames");
v = verdict(10, 20); ok(!v.relayNew && v.cap === 20, "custom cap honored");
ok(verdict(1, NaN).cap === DEFAULT_DAILY_CAP && verdict(1, -5).cap === DEFAULT_DAILY_CAP, "bad cap falls back to default");
ok(verdict(49_999).spectate && !verdict(50_000).spectate && verdict(0).spectate, "spectate boundary: exactly 50% refused, just under allowed");
ok(unitsOf(10, 400) === 30, "400 frames = 20 units");
let t = Date.parse("2026-01-01T23:59:59Z");
const l = new DayLedger(() => t);
l.add(5); ok(l.get() === 5, "ledger adds");
t += 2000; ok(l.get() === 0, "ledger resets at UTC midnight");
l.add(-3); ok(l.get() === 0, "negative ignored");
let now = 0; const b = new ByteBucket(400, 800, () => now);
let pass = 0; for (let i = 0; i < 2000; i++) if (b.take(1)) pass++;
ok(pass === 800, "room rate cap: burst 800 then drops");
now = 1000; pass = 0; for (let i = 0; i < 2000; i++) if (b.take(1)) pass++;
ok(pass === 400, "room rate cap: 400/s sustained");
// ---- full billable-unit model ----
import { unitsOfAll, durationGbs, effectiveTotal, sumCounts, presenceAlarmMs, PRESENCE_LEASE_MS, DEFAULT_DAILY_DUR_CAP } from "./src/reqbudget_core.js";
ok(unitsOfAll({ reqs: 10, doReqs: 5, alarms: 2, wsMsgs: 100, frames: 20 }) === 10 + 5 + 2 + 6, "units: worker+DO+alarm+(ws+frames)/20");
ok(unitsOfAll({}) === 0 && unitsOfAll({ reqs: -5, wsMsgs: -1 }) === 0, "units: empty/negative safe");
ok(Math.abs(durationGbs({ doReqs: 100 }) - 0.128 * 100 * 0.05) < 1e-9, "duration estimate scales with DO requests");
ok(durationGbs({ wsMsgs: 1000 }) < durationGbs({ doReqs: 1000 }), "ws msgs cheaper in duration than DO requests");
ok(effectiveTotal(100, 0) === 100, "effective total = units when duration is idle");
ok(effectiveTotal(100, DEFAULT_DAILY_DUR_CAP * 0.6) === 60_000, "duration pressure dominates when higher (60% of GB-s = 60% of cap)");
ok(!verdict(effectiveTotal(10, DEFAULT_DAILY_DUR_CAP * 0.5)).relayNew, "50% duration stops new relay");
const s = sumCounts({ reqs: 1, alarms: 2 }, { reqs: 3, gbs: 1 });
ok(s.reqs === 4 && s.alarms === 2 && s.gbs === 1 && s.wsMsgs === 0, "sumCounts merges");
ok(presenceAlarmMs() === Math.round(PRESENCE_LEASE_MS / 3) && presenceAlarmMs() >= 180_000, "presence alarm >= 3 min (was 60 s)");
// Daily-load model: each presence alarm = 1 alarm + ~2 DO requests (directory refresh + its own fetch).
// 200 accounts online 3 h/day must stay under 50% of the cap; the old 60 s alarm would not have.
{
  const hrs = 3 * 3_600_000, accounts = 200, msgsPerAcct = 400;
  const model = (alarmMs) => { const a = accounts * (hrs / alarmMs); return unitsOfAll({ alarms: a, doReqs: a * 2, wsMsgs: accounts * msgsPerAcct }); };
  ok(model(presenceAlarmMs()) < 50_000, `200 accounts x 3h = ${Math.round(model(presenceAlarmMs()))} units/day < 50% cap`);
  ok(model(60_000) > 2.5 * model(presenceAlarmMs()), "old 60 s alarm cost >2.5x more");
}
// ---- rows-written axis (Durable Object storage rows; the free plan allows 100,000 a day, the cap is 60%) ----
import { DEFAULT_DAILY_ROWS_CAP, EMPTY_COUNTS } from "./src/reqbudget_core.js";
{
  const CAP = DEFAULT_DAILY_CAP, DUR = DEFAULT_DAILY_DUR_CAP, ROWS = DEFAULT_DAILY_ROWS_CAP;
  ok(DEFAULT_DAILY_ROWS_CAP >= 50_000 && DEFAULT_DAILY_ROWS_CAP <= 70_000, `rows cap ${ROWS} is 50-70% of the free plan's 100,000 rows written a day`);
  ok(EMPTY_COUNTS.rows === 0 && "rows" in EMPTY_COUNTS, "counts carry a rows axis");
  ok(effectiveTotal(10, 0, CAP, DUR, 0) === 10 && effectiveTotal(10, 0, CAP, DUR) === 10, "no rows written: the total is unchanged (old callers keep working)");
  ok(effectiveTotal(10, 0, CAP, DUR, ROWS * 0.5, ROWS) === 50_000, "half of the rows cap counts as half of the request cap");
  ok(effectiveTotal(60_000, DUR * 0.7, CAP, DUR, ROWS * 0.65) === 70_000, "the highest of units, duration and rows decides");
  ok(effectiveTotal(10, 0, CAP, DUR, -500, ROWS) === 10, "negative rows are ignored");
  ok(effectiveTotal(10, 0, CAP, DUR, ROWS * 10, 0) === 10, "a rows cap of 0 turns the axis off");
  ok(effectiveTotal(10, 0, 1000, DUR, 30, 60) === 500, "caps scale together (custom cap 1000, rows cap 60: 30 rows = 500 units)");
  // The same 50/70/90% gates trip on rows alone.
  const gateAt = (frac) => verdict(effectiveTotal(0, 0, CAP, DUR, ROWS * frac, ROWS));
  let v2 = gateAt(0.49); ok(v2.relayNew && v2.spectate && v2.roomNew && v2.relayFrames, "49% of the rows cap: everything allowed");
  v2 = gateAt(0.5); ok(!v2.relayNew && !v2.spectate && v2.roomNew && v2.relayFrames, "50% of the rows cap: no new relay sessions, no spectating");
  v2 = gateAt(0.7); ok(!v2.roomNew && v2.relayFrames, "70% of the rows cap: no new rooms");
  v2 = gateAt(0.9); ok(!v2.relayFrames, "90% of the rows cap: relayed frames dropped, new /friends sockets refused");
  ok(unitsOfAll({ rows: 99_999 }) === 0 && durationGbs({ rows: 99_999 }) === 0, "rows never count as request units or duration");
  const s2 = sumCounts({ rows: 5, reqs: 1 }, { rows: 7 });
  ok(s2.rows === 12 && s2.reqs === 1, "sumCounts merges rows");
  // Daily-load model: a presence alarm writes ~4.5 rows (setAlarm, the directory lease and its index entry, the budget flush).
  const model = (accounts, hours) => accounts * (hours * 3_600_000 / presenceAlarmMs()) * 4.5;
  ok(model(100, 3) < ROWS * 0.5, `100 accounts online 3 h a day = ~${Math.round(model(100, 3))} rows, under the 50% gate of ${ROWS * 0.5}`);
  ok(model(30, 24) > ROWS * 0.5 && model(30, 24) < ROWS, "30 accounts left open all day pass the 50% gate (the heartbeat is the biggest writer) but stay under the cap");
}
console.log(bad ? `${bad} FAILED` : "all passed"); process.exit(bad ? 1 : 0);
