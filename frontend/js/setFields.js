// Client-side rules for set values (browser ES module, no dependencies; also
// imported by backend/test/set-fields-client.test.js).
// Same limits as the server (backend/src/validation/setFields.js): sets.reps is
// an INTEGER, sets.weight is NUMERIC(6,2).

export const MAX_REPS = 9999;
export const MAX_WEIGHT = 9999.99;
export const SET_LIMITS_MSG = `Reps: whole number 0–${MAX_REPS}. Weight: 0–${MAX_WEIGHT} lb.`;

const isBlank = (val) => val === '' || val === null || val === undefined ||
  (typeof val === 'string' && !val.trim());

// A typed value as the server should get it. The set inputs are type="text"
// (inputmode numeric/decimal), so this sees exactly what was typed — a
// type="number" input reports "" for text it can't parse (e.g. "225," on an
// iPhone with a comma keyboard), which looked like a cleared field. A single
// comma followed by at most 2 digits is a decimal comma ("225,5" → "225.5",
// "225," → "225."); anything else is left alone (so "1,000" stays invalid
// rather than silently becoming 1).
export function normalizeSetInput(val) {
  if (typeof val !== 'string') return val;
  const t = val.trim();
  return /^\d*,\d{0,2}$/.test(t) && t !== ',' ? t.replace(',', '.') : t;
}

// Plain decimal digits only (after normalizeSetInput): "225", "225.5", "225.",
// ".5". Number() alone would also take "1e3", "0x10", "0b11", "+5", "-5".
const PLAIN_DECIMAL = /^\d*\.?\d*$/;

// A typed value as a number: null if blank, NaN if not a plain number.
export function setFieldNumber(val) {
  if (isBlank(val)) return null;
  if (typeof val === 'number') return val;
  const t = normalizeSetInput(String(val));
  return PLAIN_DECIMAL.test(t) && /\d/.test(t) ? Number(t) : NaN;
}

export const WEIGHT_FORMAT_MSG = 'Use a number like 225 or 225.5.';
export const REPS_FORMAT_MSG = 'Reps must be a whole number, like 8.';

// '' if `val` is OK for `field` (blank is OK: it means "not entered yet"),
// otherwise a message for the user.
export function setFieldError(field, val) {
  if (isBlank(val)) return '';
  const n = setFieldNumber(val);
  if (Number.isNaN(n)) return field === 'reps' ? REPS_FORMAT_MSG : WEIGHT_FORMAT_MSG;
  if (field === 'reps') {
    return Number.isInteger(n) && n >= 0 && n <= MAX_REPS ? '' : `Reps must be a whole number from 0 to ${MAX_REPS}.`;
  }
  const r = Math.round(n * 100) / 100;
  return Number.isFinite(n) && r >= 0 && r <= MAX_WEIGHT ? '' : `Weight must be from 0 to ${MAX_WEIGHT} lb.`;
}

// All of a set's errors as one line ('' if none).
export function setErrorText(s) {
  return [setFieldError('reps', s.reps), setFieldError('weight', s.weight)].filter(Boolean).join(' ');
}

// What to save for a field the user just changed:
//   valid value → that value (normalized: "225,5" is sent as "225.5");
//   blank       → null (the user emptied the field: clears it on the server);
//   invalid     → undefined: send NOTHING. The stored value is kept as it is
//                 (typing "1,000" over a stored 225.5 must not wipe it), and
//                 the caller unschedules any earlier keystroke still queued
//                 for the field (typing "22555" must not leave "2255" queued).
//                 The field stays red and FINISH refuses until it's fixed.
export function fieldSaveValue(field, val) {
  if (isBlank(val)) return null;
  if (setFieldError(field, val)) return undefined;
  return normalizeSetInput(val);
}

// Queue typed values for a set on a save queue (js/saveQueue.js). Each field
// replaces that field's queued save — valid → its value, blank → null (clear)
// — except an INVALID value: it sends nothing and takes any earlier keystroke
// for the field out of the queue (unschedule), so the stored value stays as it
// is. Both schedule and unschedule bump the field's version, so an older
// in-flight save of it that fails is not retried.
export function queueSetFields(queue, key, target, typed) {
  const send = {}, skip = [];
  for (const [field, val] of Object.entries(typed)) {
    const v = fieldSaveValue(field, val);
    if (v === undefined) skip.push(field); else send[field] = v;
  }
  if (skip.length) queue.unschedule(key, skip);
  if (Object.keys(send).length) queue.schedule(key, target, send);
}
