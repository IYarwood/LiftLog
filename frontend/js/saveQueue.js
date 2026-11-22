// Debounced save queue for set edits (browser ES module, no dependencies; also
// imported by backend/test/save-queue.test.js).
//
// Each key (a set id) has at most one pending save holding:
//   - target: where to send it, captured when the edit was scheduled, so a
//     save that fires later never reads app state that has since changed
//     (e.g. `active` becoming null after FINISH);
//   - fields: every field edited since the last send, merged (typing reps then
//     weight within the delay sends both, not just the last one).
// flushAll() sends everything now and resolves when it's done, so callers can
// make sure edits reach the server before they finish or reload the workout.
export function createSaveQueue(send, delay = 600) {
  const pending = new Map();   // key -> { target, fields, timer }

  // Send one key's pending save now. Resolves true on success (or if nothing
  // was pending), false if the send failed — the edit is then kept so the next
  // flush retries it. Never rejects.
  function fire(key) {
    const p = pending.get(key);
    if (!p) return Promise.resolve(true);
    clearTimeout(p.timer);
    pending.delete(key);
    return Promise.resolve()
      .then(() => send(p.target, p.fields))
      .then(() => true, (err) => {
        console.error('Set update failed:', err);
        const newer = pending.get(key);   // edited again while this was in flight
        pending.set(key, {
          target: p.target,
          fields: { ...p.fields, ...(newer ? newer.fields : {}) },
          timer: newer ? newer.timer : null,
        });
        return false;
      });
  }

  return {
    schedule(key, target, fields) {
      const p = pending.get(key);
      if (p) clearTimeout(p.timer);
      const entry = { target: p ? p.target : target, fields: { ...(p ? p.fields : {}), ...fields } };
      entry.timer = setTimeout(() => fire(key), delay);
      pending.set(key, entry);
    },
    flush: fire,
    // Resolves true only if every pending save reached the server.
    async flushAll() {
      const results = await Promise.all([...pending.keys()].map(fire));
      return results.every(Boolean);
    },
    // Forget a pending save (its set was deleted, or saved some other way).
    drop(key) {
      const p = pending.get(key);
      if (p) clearTimeout(p.timer);
      pending.delete(key);
    },
    // Unsent field values for a key (a copy), or null.
    pendingFields(key) {
      const p = pending.get(key);
      return p ? { ...p.fields } : null;
    },
    get size() { return pending.size; },
  };
}
