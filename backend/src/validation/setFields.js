// Validation for PATCH /api/sessions/:id/exercises/:exId/sets/:setId.
// Values that the columns can't hold (sets.reps INTEGER, sets.weight
// NUMERIC(6,2)) must be a 400, not a database error (500) — the client retries
// 5xx saves, so a 500 for bad input would be retried forever.
// The frontend applies the same limits before sending (frontend/js/setFields.js).

const MAX_REPS = 9999;
const MAX_WEIGHT = 9999.99;   // NUMERIC(6,2): 4 digits before the point

// One numeric field of the body. Numbers may arrive as numbers or numeric
// strings (raw <input> values). Returns:
//   { omit: true }   not in the body → keep the stored value
//   { value: null }  null or blank   → clear the stored value
//   { value: n }     a finite number (range not checked here)
//   { bad: true }    anything else
function readNumber(body, key) {
  if (!Object.prototype.hasOwnProperty.call(body, key) || body[key] === undefined) return { omit: true };
  const v = body[key];
  if (v === null) return { value: null };
  if (typeof v === 'string') {
    if (!v.trim()) return { value: null };
    const n = Number(v);
    return Number.isFinite(n) ? { value: n } : { bad: true };
  }
  if (typeof v === 'number' && Number.isFinite(v)) return { value: v };
  return { bad: true };
}

// Returns { fields } holding only the keys to change (null = clear it), or
// { error } with a message for a 400.
//   reps / weight: omitted → unchanged; null or '' → cleared; else validated.
//   savedAt: omitted or null → unchanged (a saved set can't be un-saved).
function parseSetFields(body) {
  body = body && typeof body === 'object' ? body : {};
  const fields = {};

  const reps = readNumber(body, 'reps');
  if (reps.bad || (reps.value != null && !(Number.isInteger(reps.value) && reps.value >= 0 && reps.value <= MAX_REPS))) {
    return { error: `reps must be a whole number from 0 to ${MAX_REPS}` };
  }
  if (!reps.omit) fields.reps = reps.value;

  const weight = readNumber(body, 'weight');
  if (weight.value != null) {
    // Postgres rounds to 2 decimals on insert, so check the rounded value
    // (9999.995 would round to 10000.00 and overflow).
    weight.value = Math.round(weight.value * 100) / 100;
  }
  if (weight.bad || (weight.value != null && !(weight.value >= 0 && weight.value <= MAX_WEIGHT))) {
    return { error: `weight must be a number from 0 to ${MAX_WEIGHT}` };
  }
  if (!weight.omit) fields.weight = weight.value;

  if (body.savedAt !== undefined && body.savedAt !== null) {
    if (typeof body.savedAt !== 'string' || Number.isNaN(Date.parse(body.savedAt))) {
      return { error: 'savedAt must be a date string' };
    }
    fields.savedAt = body.savedAt;
  }
  return { fields };
}

module.exports = { MAX_REPS, MAX_WEIGHT, parseSetFields };
