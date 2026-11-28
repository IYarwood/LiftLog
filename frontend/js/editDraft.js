// Editing a FINISHED workout (browser ES module; uses setFields.js; also imported
// by backend/test/edit-draft-client.test.js).
//
// Nothing is autosaved while editing: typed values live in a local draft (a
// copy of the workout) and are only sent when the user taps "done". A finished
// workout's values are real logged lifts, so a half-typed value (100 on the
// way to 10000) must never reach the server. Leaving without "done" discards
// the draft.
import { setFieldError, setFieldNumber } from './setFields.js?v=dev';

const FIELDS = ['reps', 'weight'];
const isBlank = (v) => setFieldNumber(v) === null;
const norm = setFieldNumber;

// A deep-enough copy of a workout for editing (the draft).
export function makeDraft(session) {
  return {
    ...session,
    exercises: (session.exercises || []).map(ex => ({
      ...ex,
      sets: (ex.sets || []).map(s => ({ ...s })),
    })),
  };
}

// Compare the draft with the stored workout. Returns
//   { patches: [{ exId, setId, fields }], invalid: [{ exId, setId, message }] }
// patches: one per set with changed fields, holding ONLY those fields (as
//   numbers). Unchanged fields are never sent.
// invalid: sets whose draft holds a value that can't be saved, or a blank
//   where a value is stored (a finished workout's value is fixed or the set
//   deleted, never cleared). "done" must refuse while this is non-empty.
// Sets missing from either side (added/deleted, which happen immediately) are
// handled by their own calls; a set only in the draft compares against blanks.
export function draftChanges(original, draft) {
  const orig = new Map();
  for (const ex of original.exercises || []) for (const s of ex.sets || []) orig.set(s.id, s);
  const patches = [], invalid = [];
  for (const ex of draft.exercises || []) {
    for (const s of ex.sets || []) {
      const o = orig.get(s.id) || { reps: null, weight: null };
      const fields = {};
      const errors = [];
      for (const f of FIELDS) {
        const err = setFieldError(f, s[f]);
        if (err) { errors.push(err); continue; }
        if (norm(s[f]) === norm(o[f])) continue;
        if (isBlank(s[f])) { errors.push('Enter a value or delete the set.'); continue; }
        fields[f] = norm(s[f]);
      }
      if (errors.length) invalid.push({ exId: ex.id, setId: s.id, message: errors.join(' ') });
      else if (Object.keys(fields).length) patches.push({ exId: ex.id, setId: s.id, fields });
    }
  }
  return { patches, invalid };
}

// Has the user typed anything that differs from what's stored?
export function hasDraftChanges(original, draft) {
  const { patches, invalid } = draftChanges(original, draft);
  return patches.length > 0 || invalid.length > 0;
}
