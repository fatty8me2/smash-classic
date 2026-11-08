// Account deletion, cloud-saves side (called from the R2Budget DO as op "v2_acct_wipe"; only the account's own UserHub sends it, after it
// checked the typed confirmation). No bucket-wide operation: it works ONLY on the rows of one uid in the index.
//
//   slice:  every live object of the uid is marked dead (the same markDead the version eviction uses) and its key is handed back, at most
//           `max` per call. Uploads still in flight are aborted first (bytes released) and their keys are deleted as well. The caller deletes those keys in R2 (the ordinary free delete) and confirms them with "v2_del_done", which
//           removes the index rows and the account's byte counters. Keys already dead but not yet confirmed are offered again.
//   done:   no object rows are left (in-flight uploads are aborted and their objects deleted too). The uid's
//           version / game / device / ticket / attachment rows and its account row are then deleted.
//
// `markDead(d, rkey, nowS, dels)` is passed in by r2budget_v2.js so this file has no imports.
export function acctWipe(d, q, nowS, markDead) {
  const uid = String(q.uid || "");
  if (!/^[a-z2-7]{26}$/.test(uid)) return { r: "err", status: 400, code: "bad-uid" };
  const max = Math.max(1, Math.min(Number(q.max) || 100, 400));
  const dels = [];
  // Uploads still in flight: release their reserved bytes (d.abort) and delete whatever object they may already have written.
  for (const r of d.q(`SELECT * FROM files WHERE uid=? AND pend IS NOT NULL LIMIT ?`, uid, max)) { d.abort(r); dels.push(r.rkey); }
  for (const r of d.q(`SELECT rkey FROM files WHERE uid=? AND dead IS NULL AND pend IS NULL LIMIT ?`, uid, max)) markDead(d, r.rkey, nowS, dels);
  if (dels.length < max) {
    for (const r of d.q(`SELECT rkey FROM files WHERE uid=? AND dead IS NOT NULL AND pend IS NULL LIMIT ?`, uid, max - dels.length)) {
      if (!dels.includes(r.rkey)) dels.push(r.rkey);
    }
  }
  const left = d.q(`SELECT COUNT(*) c FROM files WHERE uid=? AND pend IS NULL`, uid)[0].c;
  let done = false;
  if (dels.length === 0 && left === 0) {
    for (const t of ["vers", "games", "tickets", "devices", "revoked"]) d.q(`DELETE FROM ${t} WHERE uid=?`, uid);
    try {
      d.q(`DELETE FROM attach_to WHERE id IN (SELECT id FROM attach WHERE uid=?)`, uid);
      d.q(`DELETE FROM attach WHERE uid=?`, uid);
    } catch { /* attachment tables absent */ }
    d.q(`DELETE FROM accts WHERE uid=?`, uid);
    done = true;
  }
  return { r: "ok", dels, left, done };
}
