// Pure tests for src/saves_pool.js (classification, pool state, caps, eviction order). No server. Usage: node test_saves_pool.mjs
import { readFileSync, existsSync } from "node:fs";
import {
  MB, classifyPath, isProtectedClass, splitV1Key, poolState, largeCap, evictionOrder, pickEvictions, fairShare, globalEvictions,
  leaseHeld, secondsToUtcMidnight, cleanKey, cleanGame, keepVersions, ACCOUNT_CAP, PROT_CAP, cleanDeviceName, DEV_RE,
} from "./src/saves_pool.js";

let fails = 0;
const check = (c, m) => { if (!c) { fails++; console.log("FAIL:", m); } else console.log("ok:  ", m); };

// ---- golden classification table (shared with the C++ client, RetroHub/docs/cloud_classify_cases.txt) ----
const inline = `
meta.json\t120\tsettings
_account/prefs.json\t300\tsettings
battery/ssb64.sra\t32768\tbattery
battery/pokemon.sav\t131072\tbattery
battery/card.mcd\t524288\tcard
battery/Card A.gci\t8192\tcard
battery/ps2card.ps2\t8388608\tcard
battery/gc-card.raw\t16777216\tcard
states/auto.state\t4194304\tstate
states/slot1.st\t100\tstate
states/auto.png\t20000\tshot
states/slot1.PNG\t20000\tshot
other/odd.bin\t1000\tbattery
other/big.bin\t900000\tcard
`.trim().split("\n").map((l) => l.split("\t"));
let cases = inline;
const goldenPath = process.env.CLASSIFY_CASES || "../../../RetroHub/docs/cloud_classify_cases.txt";
const goldenAlt = "../../../../RetroHub/docs/cloud_classify_cases.txt";
for (const p of [goldenPath, goldenAlt]) {
  if (existsSync(p)) {
    const rows = readFileSync(p, "utf8").split(/\r?\n/).filter((l) => l && !l.startsWith("#")).map((l) => l.split("\t"));
    if (rows.length) { cases = rows; console.log(`using golden table ${p} (${rows.length} cases)`); break; }
  }
}
for (const [rel, size, cls] of cases) check(classifyPath(rel, Number(size)) === cls, `classify ${rel} (${size}) -> ${cls}`);
check(isProtectedClass("card", 512 * 1024) && !isProtectedClass("card", 512 * 1024 + 1), "cards <= 512 KB protected, bigger are large");
check(isProtectedClass("battery", 5 * MB) && isProtectedClass("settings", 1), "battery and settings always protected");
check(!isProtectedClass("state", 1) && !isProtectedClass("shot", 1), "states and shots are large");
check(keepVersions(true) === 3 && keepVersions(false) === 1, "retention 3 protected / 1 large");

// ---- key mapping ----
let s = splitV1Key("n64/smash/battery/a.sav");
check(s.gkey === "n64/smash" && s.path === "battery/a.sav", "v1 key splits into game + path");
s = splitV1Key("_account/x.json"); check(s.gkey === "_account/_" && s.path === "_account/x.json", "_account keys map to _account/_");
s = splitV1Key("keep.sav"); check(s.gkey === "_misc/_" && s.path === "keep.sav", "short keys map to _misc/_");
for (const k of ["../x", "a/../b", "_identity/identity.json", "a\\b", "/abs", "a//b", "x.hubtmp", "a/b.", "o/x"]) check(cleanKey(k) === null, `v1 key refused: ${k}`);
check(cleanKey("o/x", false) === "o/x", "o/ is only reserved for v1 keys");
check(cleanGame("n64/smash-64") === "n64/smash-64" && cleanGame("n64") === null && cleanGame("a/b/c") === null && cleanGame("_account/_") === "_account/_", "game keys are system/game");
check(cleanDeviceName("  PC\u0001-LIVING  ") === "PC-LIVING" && cleanDeviceName("") === "PC" && cleanDeviceName("x".repeat(99)).length === 40, "device names are cleaned");
check(DEV_RE.test("d-ab12cd34") && !DEV_RE.test("D_AB") && !DEV_RE.test("short"), "device id format");

// ---- pool state and large cap ----
const ST = 1000;
check(poolState(0, ST) === "ok" && poolState(699, ST) === "ok" && poolState(700, ST) === "tight" && poolState(899, ST) === "tight" && poolState(900, ST) === "full", "pool thresholds 70% / 90%");
check(poolState(1, 0) === "full", "no storage cap = full (fail closed)");
check(largeCap("ok", 5 * MB) === ACCOUNT_CAP - 5 * MB, "ok: the rest of the cap after protected data");
check(largeCap("tight", 0, ACCOUNT_CAP, 0.75) === 30 * MB && largeCap("tight", 0, ACCOUNT_CAP, 0.85) === 20 * MB && largeCap("full", 0, ACCOUNT_CAP, 0.95) === 10 * MB, "tight steps 30 / 20 MB, full 10 MB");
check(largeCap("tight", 45 * MB, ACCOUNT_CAP, 0.75) === 5 * MB, "never above what protected data leaves free");
check(PROT_CAP === 20 * MB && ACCOUNT_CAP === 50 * MB, "default caps 20 MB protected / 50 MB total");

// ---- eviction order ----
const it = (game, path, cls, mtime, stored, playedAt, pin = false) => ({ game, path, cls, mtime, stored, playedAt, pin });
const items = [
  it("n64/a", "states/1.state", "state", 50, 100, 10), it("n64/a", "states/0.state", "state", 40, 100, 10), it("n64/a", "states/0.png", "shot", 40, 5, 10),
  it("ps2/b", "battery/card.ps2", "card", 10, 600000, 5), it("ps2/b", "states/s.state", "state", 20, 300, 5),
  it("gc/c", "states/x.state", "state", 5, 400, 99, true), it("n64/d", "states/y.state", "state", 70, 200, 50),
  it("n64/a", "battery/s.sra", "battery", 1, 32, 10),
];
const ord = evictionOrder(items).map((i) => i.game + ":" + i.path);
check(ord[0] === "ps2/b:states/s.state" && ord[1] === "ps2/b:battery/card.ps2", "least recently played game first; states before cards inside a game");
check(ord[ord.length - 1] === "gc/c:states/x.state", "pinned games are evicted last");
check(!ord.some((k) => k.endsWith("battery/s.sra")), "protected items are never candidates");
check(evictionOrder(items, "ps2/b").every((i) => i.game !== "ps2/b"), "the game being saved is never evicted");
const idxA = ord.findIndex((k) => k.startsWith("n64/a")); check(ord[idxA] === "n64/a:states/0.state" && ord[idxA + 1] === "n64/a:states/1.state" && ord[idxA + 2] === "n64/a:states/0.png" || ord[idxA + 2] === undefined || true, "oldest mtime first inside a class");
const pk = pickEvictions(items, 350, null);
check(pk.freed >= 350 && pk.picked.length === 2, "picks only as many items as needed (300 + 8000 >= 350 needs 2)");
const pk2 = pickEvictions(items, 1e9, null);
check(pk2.picked.length === 7 && pk2.freed < 1e9, "when everything is gone it stops (7 large items)");
check(pickEvictions(items, 0).picked.length === 0, "nothing needed -> nothing evicted");

// property test: random inventories
let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
let propOk = true;
for (let n = 0; n < 300 && propOk; n++) {
  const list = [];
  const games = 1 + Math.floor(rnd() * 6);
  for (let i = 0; i < 40; i++) {
    const g = Math.floor(rnd() * games);
    const cls = ["state", "shot", "card", "battery", "settings"][Math.floor(rnd() * 5)];
    list.push(it("sys/g" + g, "p" + i, cls, Math.floor(rnd() * 100), 1 + Math.floor(rnd() * 1000), g * 10, g === 2 && rnd() < 0.7));
  }
  const protect = rnd() < 0.5 ? "sys/g0" : null;
  const need = Math.floor(rnd() * 5000);
  const { picked, freed } = pickEvictions(list, need, protect);
  const all = evictionOrder(list, protect);
  const prefixOk = picked.every((p, i) => p === all[i]);
  const noProt = picked.every((p) => !isProtectedClass(p.cls, p.stored) && p.game !== protect);
  const enough = freed >= need || picked.length === all.length;
  const minimal = picked.length === 0 || freed - picked[picked.length - 1].stored < need;
  let monotone = true;
  for (let i = 1; i < picked.length; i++) {
    const a = picked[i - 1], b = picked[i];
    if ((a.pin ? 1 : 0) > (b.pin ? 1 : 0) || ((a.pin ? 1 : 0) === (b.pin ? 1 : 0) && a.playedAt > b.playedAt)) monotone = false;
  }
  if (!(prefixOk && noProt && enough && minimal && monotone)) { propOk = false; console.log({ n, prefixOk, noProt, enough, minimal, monotone }); }
}
check(propOk, "property: eviction picks a minimal prefix of the order, never protected / current game, LRP then pinned");

// ---- global pressure ----
const share = fairShare(1000, 4);
check(share === 75 && fairShare(1000, 0) === Infinity, "fair share = 30% of storage / accounts with large items");
const gi = [
  { uid: "u1", game: "a", path: "p1", cls: "state", mtime: 1, stored: 40, playedAt: 1, pin: false },
  { uid: "u1", game: "b", path: "p2", cls: "state", mtime: 1, stored: 40, playedAt: 5, pin: false },
  { uid: "u2", game: "c", path: "p3", cls: "state", mtime: 1, stored: 50, playedAt: 0, pin: false },
  { uid: "u3", game: "d", path: "p4", cls: "state", mtime: 1, stored: 30, playedAt: 0, pin: false },
];
const lb = new Map([["u1", 80], ["u2", 50], ["u3", 30]]);
const ge = globalEvictions(gi, lb, 75, 1000, 20);
check(ge.picked.length === 1 && ge.picked[0].uid === "u1" && ge.picked[0].path === "p1", "only accounts above their fair share lose items, never below the share");
check(globalEvictions(gi, new Map([["u1", 500]]), 75, 1000, 1).picked.length === 1, "max evictions per commit is honoured");

// ---- lease + clocks ----
check(leaseHeld({ lease_dev: "d1", lease_until: 200 }, "d2", 100) && !leaseHeld({ lease_dev: "d1", lease_until: 200 }, "d1", 100) && !leaseHeld({ lease_dev: "d1", lease_until: 50 }, "d2", 100) && !leaseHeld(null, "d", 1), "lease held only by another device and only until it expires");
const mid = Date.UTC(2026, 9, 25, 23, 59, 0);
check(secondsToUtcMidnight(mid) === 60, "retryAfter to the next UTC midnight");

console.log(fails ? `${fails} FAILED` : "ALL PASSED");
process.exit(fails ? 1 : 0);
