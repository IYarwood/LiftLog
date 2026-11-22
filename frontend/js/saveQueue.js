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
// Failures: a 4xx (err.status 400–499) is permanent — the server refused the
// value, or the set/exercise is gone — so it is reported to onRejected and
// NOT retried (retrying could never succeed and would block FINISH forever).
// Anything else (network error, 5xx) is kept and retried by the next flush.
export function createSaveQueue(send, delay = 600, { onRejected } = {}) {
  const pending = new Map();    // key -> { target, fields, timer, failed }
  const inflight = new Map();   // key -> promise for the key's last send
  const dropped = new Set();    // keys dropped while a send may be in flight
  const isPermanent = (err) => !!err && err.status >= 400 && err.status < 500;

  // A failed (retryable) send goes back in the queue, without a timer: the
  // next flushAll retries it. Fields edited since then win over the old ones.
  function requeue(key, p) {
    const cur = pending.get(key);
    pending.set(key, {
      target: p.target,
      fields: { ...p.fields, ...(cur ? cur.fields : {}) },
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
        if (!dropped.has(key)) requeue(key, p);   // else its set/exercise was removed
      })
      .finally(() => { if (inflight.get(key) === run) inflight.delete(key); });
    inflight.set(key, run);
    return run;
  }

  return {
    schedule(key, target, fields) {
      dropped.delete(key);
      const p = pending.get(key);
      if (p) clearTimeout(p.timer);
      const entry = { target: p ? p.target : target, fields: { ...(p ? p.fields : {}), ...fields }, failed: false };
      entry.timer = setTimeout(() => fire(key), delay);
      pending.set(key, entry);
    },
    flush: fire,
    // Send everything now and wait for it, including sends already in flight.
    // Resolves true unless an edit is still unsaved because its send failed
    // (it stays queued for the next flush).
    async flushAll() {
      [...pending.keys()].forEach(fire);
      while (inflight.size) await Promise.all([...inflight.values()]);
      return ![...pending.values()].some(p => p.failed);
    },
    // Forget a pending save (its set was deleted, or saved some other way).
    // A send already in flight still finishes, but is not retried if it fails.
    drop(key) {
      const p = pending.get(key);
      if (p) clearTimeout(p.timer);
      pending.delete(key);
      dropped.add(key);
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
