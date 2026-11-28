// Debounced save queue for set edits (browser ES module, no dependencies; also
// imported by backend/test/save-queue.test.js).
//
// Each key (a set id) has at most one pending save holding:
//   - target: where to send it, captured when the edit was scheduled, so a
//     save that fires later never reads app state that has since changed
//     (e.g. `active` becoming null after FINISH);
//   - fields: every field edited since the last send, merged (typing reps then
//     weight within the delay sends both, not just the last one).
// Sends for one key run one at a time, in order (each waits for the previous),
// so an older value can never land on the server after a newer one.
// flushAll() sends everything pending now and resolves only when every send —
// including ones that were already in flight — has finished, so callers can
// make sure edits reached the server before they finish or reload the workout.
//
// Versions: every edited field gets a new version number. A failed send only
// requeues the fields whose value is still the newest one edited — if the
// user typed something newer meanwhile (whether that is queued, in flight or
// already saved), the stale value is discarded, never resent over it.
//
// Failures: a 4xx (err.status 400–499) is permanent — the server refused the
// value, or the set/exercise is gone — so it is reported to onRejected and
// NOT retried (retrying could never succeed and would block FINISH forever).
// Anything else (network error, 5xx) is kept and retried by the next flush.
export function createSaveQueue(send, delay = 600, { onRejected } = {}) {
  const pending = new Map();    // key -> { target, fields, vers, timer, failed }
  const inflight = new Map();   // key -> promise for the key's last send
  const latest = new Map();     // key -> { field: newest version edited }; gone once dropped
  let version = 0;
  const isPermanent = (err) => !!err && err.status >= 400 && err.status < 500;

  // A failed (retryable) send goes back in the queue, without a timer: the
  // next flushAll retries it — but only fields nobody has edited since.
  function requeue(key, p) {
    const lv = latest.get(key);
    if (!lv) return;                                // dropped: set/exercise removed
    const keep = Object.keys(p.fields).filter(f => lv[f] === p.vers[f]);
    if (!keep.length) return;                       // all superseded by newer edits
    const fields = {}, vers = {};
    for (const f of keep) { fields[f] = p.fields[f]; vers[f] = p.vers[f]; }
    const cur = pending.get(key);                   // newer edits, if any, win
    pending.set(key, {
      target: p.target,
      fields: { ...fields, ...(cur ? cur.fields : {}) },
      vers: { ...vers, ...(cur ? cur.vers : {}) },
      timer: cur ? cur.timer : null,
      failed: true,
    });
  }

  // Start sending one key's pending save (after any send for the same key that
  // is still in flight). Returns the promise for that send; never rejects.
  function fire(key) {
    const p = pending.get(key);
    if (!p) return inflight.get(key) || Promise.resolve();
    clearTimeout(p.timer);
    pending.delete(key);
    const prev = inflight.get(key) || Promise.resolve();
    const run = prev
      .then(() => send(p.target, p.fields))
      .then(() => {}, (err) => {
        if (isPermanent(err)) {
          if (onRejected) onRejected(p.target, p.fields, err);
          return;
        }
        console.error('Set update failed:', err);
        requeue(key, p);
      })
      .finally(() => { if (inflight.get(key) === run) inflight.delete(key); });
    inflight.set(key, run);
    return run;
  }

  return {
    schedule(key, target, fields) {
      if (!latest.has(key)) latest.set(key, {});
      const lv = latest.get(key);
      const p = pending.get(key);
      if (p) clearTimeout(p.timer);
      const vers = { ...(p ? p.vers : {}) };
      for (const f of Object.keys(fields)) vers[f] = lv[f] = ++version;
      const entry = { target: p ? p.target : target, fields: { ...(p ? p.fields : {}), ...fields }, vers, failed: !!(p && p.failed) };
      entry.timer = setTimeout(() => fire(key), delay);
      pending.set(key, entry);
    },
    flush: fire,
    // Take `fields` out of a key's pending save without sending anything (the
    // value on screen became invalid: what's stored stays as it is). Also
    // bumps their version, so an older in-flight send of them that fails is
    // not retried.
    unschedule(key, fields) {
      const lv = latest.get(key);
      if (lv) for (const f of fields) lv[f] = ++version;
      const p = pending.get(key);
      if (!p) return;
      for (const f of fields) { delete p.fields[f]; delete p.vers[f]; }
      if (!Object.keys(p.fields).length) { clearTimeout(p.timer); pending.delete(key); }
    },
    // Send everything now and wait for it, including sends already in flight.
    // Resolves true unless an edit is still unsaved because its send failed
    // (it stays queued for the next flush).
    // Edits made while it runs are sent too. Each failed edit is retried once
    // per call (not forever), so this always finishes.
    async flushAll() {
      const failedThisRound = new Set();
      for (;;) {
        const keys = [...pending.keys()].filter(k => !failedThisRound.has(k));
        if (!keys.length && !inflight.size) break;
        keys.forEach(fire);
        await Promise.all([...inflight.values()]);
        for (const [k, p] of pending) if (p.failed) failedThisRound.add(k);
      }
      return ![...pending.values()].some(p => p.failed);
    },
    // Forget a pending save (its set was deleted, or saved some other way).
    // A send already in flight still finishes, but is not retried if it fails.
    drop(key) {
      const p = pending.get(key);
      if (p) clearTimeout(p.timer);
      pending.delete(key);
      latest.delete(key);   // an in-flight send for it won't be requeued
    },
    // Drop every pending save for which `shouldDrop(target)` is true — e.g. its
    // set or exercise no longer exists. Returns how many were dropped.
    dropWhere(shouldDrop) {
      let n = 0;
      for (const [key, p] of [...pending]) {
        if (shouldDrop(p.target)) { this.drop(key); n++; }
      }
      return n;
    },
    // Unsent field values for a key (a copy), or null.
    pendingFields(key) {
      const p = pending.get(key);
      return p ? { ...p.fields } : null;
    },
    get size() { return pending.size; },
  };
}

// Save one key's full value now (the set's SAVE button), outside the debounce.
// Any as-you-type save for the key is sent first and awaited, so it can't land
// after (and overwrite) this one. Only THEN are the values read: read() runs
// after the wait, so a keystroke made while that save was in flight is part of
// what gets sent (reading first sent — and showed — the older value).
//   read()     → the values to send, or null to not save (e.g. now invalid);
//                its edits stay queued in that case.
//   send(vals) → the request; if it throws, the error propagates (the caller
//                decides how to requeue).
// Resolves to the values sent, or null if read() declined.
export async function saveNow(queue, key, read, send) {
  await queue.flush(key);
  const vals = read();
  if (!vals) return null;
  queue.drop(key);   // edits typed during the wait are in vals: don't resend them
  // A send that STARTED during the wait (its debounce fired) is still in
  // flight; drop() can't stop it. Let it land first, or it could arrive
  // after (and overwrite) the full save.
  await queue.flush(key);
  await send(vals);
  return vals;
}
