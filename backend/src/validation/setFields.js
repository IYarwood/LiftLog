// Validation for PATCH /api/sessions/:id/exercises/:exId/sets/:setId.
// Values that the columns can't hold (sets.reps INTEGER, sets.weight
// NUMERIC(6,2)) must be a 400, not a database error (500) — the client retries
// 5xx saves, so a 500 for bad input would be retried forever.
// The frontend applies the same limits before sending (frontend/index.html).

const MAX_REPS = 9999;
const MAX_WEIGHT = 9999.99;   // NUMERIC(6,2): 4 digits before the point

// Absent/null/'' means "leave unchanged" (the route uses COALESCE).
// Numbers may arrive as numbers or numeric strings (raw <input> values).
function toNumber(v) {
  if (v === undefined || v === null) return { value: null };
  if (typeof v === 'string') {
    if (!v.trim()) return { value: null };
    const n = Number(v);
    return Number.isFinite(n) ? { value: n } : { bad: true };
  }
  if (typeof v === 'number' && Number.isFinite(v)) return { value: v };
  return { bad: true };
}

// Returns { reps, weight, savedAt } (each null = unchanged) or { error }.
function parseSetFields(body) {
  body = body || {};
  const reps = toNumber(body.reps);
  if (reps.bad || (reps.value !== null && !(Number.isInteger(reps.value) && reps.value >= 0 && reps.value <= MAX_REPS))) {
    return { error: `reps must be a whole number from 0 to ${MAX_REPS}` };
  }
  const weight = toNumber(body.weight);
  if (weight.value !== null) {
    // Postgres rounds to 2 decimals on insert, so check the rounded value
    // (9999.995 would round to 10000.00 and overflow).
    weight.value = Math.round(weight.value * 100) / 100;
  }
  if (weight.bad || (weight.value !== null && !(weight.value >= 0 && weight.value <= MAX_WEIGHT))) {
    return { error: `weight must be a number from 0 to ${MAX_WEIGHT}` };
  }
  let savedAt = null;
  if (body.savedAt !== undefined && body.savedAt !== null) {
    if (typeof body.savedAt !== 'string' || Number.isNaN(Date.parse(body.savedAt))) {
      return { error: 'savedAt must be a date string' };
    }
    savedAt = body.savedAt;
  }
  return { reps: reps.value, weight: weight.value, savedAt };
}

module.exports = { MAX_REPS, MAX_WEIGHT, parseSetFields };
