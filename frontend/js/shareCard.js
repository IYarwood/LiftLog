// "Share workout as image" (browser ES module; the pure parts are also imported
// by backend/test/share-card.test.js).
//
//   buildShareModel(session, history, username) -> what goes on the card
//   shareCaption(model)                         -> the one-line share text
//   layoutCard(model, measure)                  -> a draw list + canvas height
//   drawCard(ctx, layout)                       -> paints the draw list
//   renderShareImage(model)                     -> { blob } PNG (browser only)
//
// The card is 1080 wide and exactly as tall as its content (a typical
// 6-exercise workout is close to 4:5). It never clips: a row with more than
// SETS_PER_LINE sets wraps onto a second line and the image grows taller. Ported from the designer's mockup
// (liftlog-share-mockups/src/workout.js + card.css, drawn there at 360x450 x3).

// ─── Pure logic ──────────────────────────────────────────────────────────────
const sameName = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0);

// Estimated 1RM (Epley) — "best set" is the set with the highest one.
export const e1rm = (w, r) => w * (1 + r / 30);

// Index of the best set: highest e1RM among weighted sets; if nothing in the
// exercise has a weight (bodyweight work), the set with the most reps.
// First one wins a tie. -1 if there is nothing to pick.
export function bestSetIndex(sets) {
  let best = -1, bestVal = -1;
  const weighted = sets.some(s => s.weight > 0 && s.reps > 0);
  sets.forEach((s, i) => {
    const v = weighted ? (s.weight > 0 && s.reps > 0 ? e1rm(s.weight, s.reps) : -1) : s.reps;
    if (v > bestVal) { best = i; bestVal = v; }
  });
  return bestVal > 0 ? best : -1;
}

// Heaviest weight logged for this exercise (any casing) in earlier workouts,
// or null if it was never done before. Same rule as the app's "all-time PR"
// (exerciseStats in index.html): the max weight of any set.
export function priorMaxWeight(exName, session, history) {
  const t = new Date(session.startedAt).getTime();
  let max = null;
  for (const s of history || []) {
    if (!s || s.id === session.id || !s.finishedAt) continue;
    if (!(new Date(s.startedAt).getTime() < t)) continue;
    for (const ex of s.exercises || []) {
      if (!sameName(ex.name, exName)) continue;
      for (const set of ex.sets || []) {
        const w = num(set.weight);
        if (w > 0 && (max === null || w > max)) max = w;
      }
    }
  }
  return max;
}

// Index of the personal-record set: this workout's heaviest set when it beats
// every earlier workout's heaviest set (most reps at that weight, first on a
// tie). An exercise done for the first time is not a PR — there is nothing to
// beat, and marking every set of a first workout amber would be noise. -1 if none.
export function prSetIndex(sets, priorMax) {
  if (priorMax === null || priorMax === undefined) return -1;
  let idx = -1;
  sets.forEach((s, i) => {
    if (!(s.weight > priorMax) || !(s.reps > 0)) return;
    if (idx === -1 || s.weight > sets[idx].weight || (s.weight === sets[idx].weight && s.reps > sets[idx].reps)) idx = i;
  });
  return idx;
}

export function fmtWeight(w) {
  if (!(w > 0)) return 'BW';
  return String(Math.round(w * 100) / 100);
}

const DAY = { weekday: 'long', month: 'short', day: 'numeric' };
const DAY_SHORT = { weekday: 'short', month: 'short', day: 'numeric' };
function fmtDay(iso, opts, now) {
  const d = new Date(iso);
  const o = d.getFullYear() === now.getFullYear() ? opts : { ...opts, year: 'numeric' };
  return d.toLocaleDateString('en-US', o);
}
export function fmtDuration(startIso, endIso) {
  if (!startIso || !endIso) return '';
  const mins = Math.round((new Date(endIso) - new Date(startIso)) / 60000);
  if (!(mins > 0)) return '';
  const h = Math.floor(mins / 60), m = mins % 60;
  return h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`;
}

// Everything the card and the caption need. Sets with neither reps nor weight
// are left out (an empty "+ add set" row), and so are exercises left empty.
export function buildShareModel(session, history, username, now = new Date()) {
  const exercises = [];
  for (const ex of session.exercises || []) {
    const sets = (ex.sets || [])
      .map(s => ({ weight: num(s.weight), reps: num(s.reps) }))
      .filter(s => s.weight > 0 || s.reps > 0);
    if (!sets.length) continue;
    const pr = prSetIndex(sets, priorMaxWeight(ex.name, session, history));
    exercises.push({ name: String(ex.name).trim(), sets, best: bestSetIndex(sets), pr });
  }
  const setCount = exercises.reduce((a, e) => a + e.sets.length, 0);
  const volume = exercises.reduce((a, e) => a + e.sets.reduce((b, s) => b + s.weight * s.reps, 0), 0);
  return {
    username: username || '',
    dateLong: fmtDay(session.startedAt, DAY, now),
    dateShort: fmtDay(session.startedAt, DAY_SHORT, now),
    duration: fmtDuration(session.startedAt, session.finishedAt),
    setCount,
    volume: Math.round(volume),
    exercises,
  };
}

// Is there anything to put on a card? (at least one set with reps or weight)
export function hasShareableSets(session) {
  return (session.exercises || []).some(ex => (ex.sets || []).some(s => num(s.reps) > 0 || num(s.weight) > 0));
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// "Sat, Nov 21 · 22 sets · new Bench Press PR 205×5"  (or "· 3 new PRs")
export function shareCaption(model) {
  const parts = [model.dateShort, plural(model.setCount, 'set')];
  const prs = model.exercises.filter(e => e.pr >= 0);
  if (prs.length === 1) {
    const s = prs[0].sets[prs[0].pr];
    parts.push(`new ${prs[0].name} PR ${fmtWeight(s.weight)}×${s.reps}`);
  } else if (prs.length > 1) {
    parts.push(`${prs.length} new PRs`);
  }
  return parts.join(' · ');
}

// Cache key for a rendered image. It covers the built model, not just this
// workout's sets: best/PR marks depend on the OTHER workouts too (an earlier
// one edited or deleted can add or remove a PR here), and on the username.
export function shareCacheKey(session, model) {
  return JSON.stringify([session.id, session.startedAt, model]);
}

export function shareFileName(session) {
  const d = new Date(session.startedAt);
  const p = (n) => String(n).padStart(2, '0');
  return `liftlog-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.png`;
}

// ─── Layout ──────────────────────────────────────────────────────────────────
export const W = 1080, SETS_PER_LINE = 5;
export const COLORS = {
  bg: '#080b0f', border: '#1e2530', accent: '#4af0b0', warn: '#f0a030',
  text: '#c8d8e8', text2: '#8299ac', ink: '#e8f0f7',
};
const DISP = "'Barlow Condensed'", MONO = "'JetBrains Mono'";
export const FONTS = {
  logo: `700 45px ${DISP}`,
  user: `400 30px ${MONO}`,
  date: `600 108px ${DISP}`,
  sub: `400 31.5px ${MONO}`,
  name: `500 51px ${DISP}`,
  badge: `500 25.5px ${MONO}`,
  weight: `600 57px ${DISP}`,
  reps: `400 28.5px ${MONO}`,
  key: `400 27px ${MONO}`,
};
// Every face the card uses, for document.fonts.load() before drawing.
export const FONT_LOADS = [...new Set(Object.values(FONTS))];

const PAD_X = 66, PAD_TOP = 66, PAD_BOT = 54;
const CONTENT_W = W - 2 * PAD_X;
const COL_W = 114;                       // one set column
const SETS_W = COL_W * SETS_PER_LINE;    // 570
const GAP = 30;
const NAME_W = CONTENT_W - SETS_W - GAP; // 348
const NAME_LH = 54;                      // line height for exercise names
const SET_LINE_H = 104;                  // weight + reps, one line of sets
const ROW_PAD = 19;                      // space above/below a row's content

// fontSize from a CSS font shorthand ("600 57px 'X'") -> 57
const sizeOf = (font) => Number(/([\d.]+)px/.exec(font)[1]);
function withSize(font, px) { return font.replace(/[\d.]+px/, `${px}px`); }

// Largest size <= the font's own that makes `text` fit `maxW`.
function fitFont(text, font, maxW, measure, spacing = 0) {
  let px = sizeOf(font);
  let f = font;
  while (px > 8 && measure(text, f, spacing) > maxW) { px -= 1; f = withSize(font, px); }
  return f;
}

// Greedy word wrap; a word wider than the line is broken by characters.
export function wrapText(text, font, maxW, measure) {
  const lines = [];
  let line = '';
  const push = (w) => {
    const cand = line ? `${line} ${w}` : w;
    if (measure(cand, font) <= maxW) { line = cand; return; }
    if (line) { lines.push(line); line = ''; }
    if (measure(w, font) <= maxW) { line = w; return; }
    let chunk = '';
    for (const ch of w) {
      if (chunk && measure(chunk + ch, font) > maxW) { lines.push(chunk); chunk = ''; }
      chunk += ch;
    }
    line = chunk;
  };
  String(text).split(/\s+/).filter(Boolean).forEach(push);
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

// measure(text, font, letterSpacing?) -> width in px. Returns
// { width, height, items } where items are drawn in order by drawCard().
// Item kinds: rect {x,y,w,h,r,color}, line {x1,x2,y,color}, text {text,x,y,font,color,align,spacing}
// (text y is the alphabetic baseline; `w` is the measured width, for tests).
export function layoutCard(model, measure) {
  const items = [];
  const text = (t, x, y, font, color, align = 'left', spacing = 0) => {
    const w = measure(t, font, spacing);
    items.push({ kind: 'text', text: t, x, y, font, color, align, spacing, w,
      left: align === 'center' ? x - w / 2 : align === 'right' ? x - w : x });
  };

  // Header: logo left, @username right, sharing one baseline.
  let y = PAD_TOP;
  const headBase = y + 45;
  text('LIFTLOG', PAD_X, headBase, FONTS.logo, COLORS.accent, 'left', 7.5);
  const logoW = measure('LIFTLOG', FONTS.logo, 7.5);
  if (model.username) {
    const u = '@' + model.username;
    text(u, W - PAD_X, headBase, fitFont(u, FONTS.user, CONTENT_W - logoW - 40, measure), COLORS.text2, 'right');
  }
  y = headBase + 6;

  // Date + summary line
  const dateFont = fitFont(model.dateLong, FONTS.date, CONTENT_W, measure);
  y += 50;
  text(model.dateLong, PAD_X, y + sizeOf(dateFont) * 0.86, dateFont, COLORS.ink);
  y += sizeOf(dateFont);
  const subParts = [model.duration, plural(model.setCount, 'set')];
  if (model.volume > 0) subParts.push(`${model.volume.toLocaleString('en-US')} lb lifted`);
  const sub = subParts.filter(Boolean).join(', ');
  const subFont = fitFont(sub, FONTS.sub, CONTENT_W, measure);
  y += 21;
  text(sub, PAD_X, y + sizeOf(subFont) * 0.8, subFont, COLORS.text2);
  y += sizeOf(subFont) * 1.2;

  // Rows
  y += 42;
  const rowsTop = y;
  const rows = model.exercises.map(ex => {
    const lines = wrapText(ex.name, FONTS.name, NAME_W, measure);
    // PR badge goes after the name, or on its own line if it doesn't fit.
    let badgeOnOwnLine = false;
    if (ex.pr >= 0) {
      const last = lines[lines.length - 1];
      badgeOnOwnLine = measure(last, FONTS.name) + 18 + badgeWidth(measure) > NAME_W;
    }
    const nameH = (lines.length + (badgeOnOwnLine ? 1 : 0)) * NAME_LH;
    const setLines = Math.ceil(ex.sets.length / SETS_PER_LINE);
    const setsH = setLines * SET_LINE_H;
    return { ex, lines, badgeOnOwnLine, nameH, setsH, natural: Math.max(nameH, setsH) + 2 * ROW_PAD };
  });
  // Each row is as tall as its content; the card is as tall as its rows.
  rows.forEach(r => { r.h = r.natural; });
  // One weight size for the whole card, so columns read as one grid.
  const weightFont = model.exercises.flatMap(ex => ex.sets.map(st => fmtWeight(st.weight)))
    .reduce((f, t) => fitFont(t, f, COL_W - 26, measure), FONTS.weight);

  items.push({ kind: 'line', x1: PAD_X, x2: W - PAD_X, y: rowsTop, color: COLORS.border });
  for (const r of rows) {
    const top = y, mid = y + r.h / 2;
    // name block, vertically centred
    let ny = mid - r.nameH / 2;
    r.lines.forEach((ln, i) => {
      text(ln, PAD_X, ny + NAME_LH * 0.78, FONTS.name, COLORS.ink);
      if (i === r.lines.length - 1 && r.ex.pr >= 0) {
        const bx = r.badgeOnOwnLine ? PAD_X : PAD_X + measure(ln, FONTS.name) + 18;
        const by = r.badgeOnOwnLine ? ny + NAME_LH : ny;
        badge(items, text, bx, by + (NAME_LH - 42) / 2, measure);
      }
      ny += NAME_LH;
    });
    // sets, SETS_PER_LINE per line, vertically centred
    let sy = mid - r.setsH / 2;
    r.ex.sets.forEach((s, i) => {
      const col = i % SETS_PER_LINE, line = Math.floor(i / SETS_PER_LINE);
      const cx = W - PAD_X - SETS_W + col * COL_W + COL_W / 2;
      const ly = sy + line * SET_LINE_H;
      const isPr = i === r.ex.pr, isTop = !isPr && r.ex.sets.length > 1 && i === r.ex.best;
      const wt = fmtWeight(s.weight);
      text(wt, cx, ly + 10 + 48, weightFont, isPr ? COLORS.warn : isTop ? COLORS.accent : COLORS.text, 'center');
      const rp = `×${s.reps}`;
      const rFont = fitFont(rp, FONTS.reps, COL_W - 6, measure);
      text(rp, cx, ly + 10 + 48 + 9 + 28, rFont, (isPr || isTop) ? COLORS.text : COLORS.text2, 'center');
    });
    y = top + r.h;
    items.push({ kind: 'line', x1: PAD_X, x2: W - PAD_X, y, color: COLORS.border });
  }

  // Key right under the rows, with only the markers that appear on this card.
  const keys = [];
  if (model.exercises.some(ex => ex.sets.length > 1 && ex.best >= 0 && ex.best !== ex.pr)) keys.push(['best set', COLORS.accent]);
  if (model.exercises.some(ex => ex.pr >= 0)) keys.push(['personal record', COLORS.warn]);
  let height = Math.ceil(y + PAD_BOT);
  if (keys.length) {
    const keyBase = y + 61;
    let kx = PAD_X;
    for (const [label, color] of keys) {
      items.push({ kind: 'rect', x: kx, y: keyBase - 20, w: 21, h: 21, r: 6, color });
      kx += 21 + 18;
      text(label, kx, keyBase, FONTS.key, COLORS.text2);
      kx += measure(label, FONTS.key) + 42;
    }
    height = Math.ceil(keyBase + 6 + PAD_BOT);
  }

  return { width: W, height, items };
}

function badgeWidth(measure) { return measure('PR', FONTS.badge) + 24; }
function badge(items, text, x, y, measure) {
  const w = badgeWidth(measure);
  items.push({ kind: 'rect', x, y, w, h: 42, r: 9, color: COLORS.warn });
  text('PR', x + w / 2, y + 30, FONTS.badge, COLORS.bg, 'center');
}

// ─── Drawing ─────────────────────────────────────────────────────────────────
export function drawCard(ctx, layout) {
  const { width, height } = layout;
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, width, height);
  const g = ctx.createLinearGradient(0, 0, 0, 420);
  g.addColorStop(0, 'rgba(74,240,176,0.07)');
  g.addColorStop(1, 'rgba(74,240,176,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, width, 420);
  ctx.textBaseline = 'alphabetic';
  for (const it of layout.items) {
    if (it.kind === 'rect') {
      ctx.fillStyle = it.color;
      roundRect(ctx, it.x, it.y, it.w, it.h, it.r);
      ctx.fill();
    } else if (it.kind === 'line') {
      ctx.fillStyle = it.color;
      ctx.fillRect(it.x1, Math.round(it.y) - 1.5, it.x2 - it.x1, 3);
    } else {
      ctx.font = it.font;
      ctx.fillStyle = it.color;
      if (it.spacing) {
        // Letter-spaced text drawn glyph by glyph (ctx.letterSpacing isn't in
        // every Safari we care about).
        ctx.textAlign = 'left';
        let x = it.left;
        for (const ch of it.text) { ctx.fillText(ch, x, it.y); x += ctx.measureText(ch).width + it.spacing; }
      } else {
        ctx.textAlign = it.align;
        ctx.fillText(it.text, it.x, it.y);
      }
    }
  }
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ─── Browser: fonts -> canvas -> PNG ─────────────────────────────────────────
// Waits for the self-hosted fonts first so the image never has fallback fonts;
// throws if they can't be loaded.
export async function renderShareImage(model) {
  if (document.fonts) {
    await Promise.all(FONT_LOADS.map(f => document.fonts.load(f, 'LIFTLOG@×0')));
    await document.fonts.ready;
    if (!FONT_LOADS.every(f => document.fonts.check(f, 'LIFTLOG@×0'))) throw new Error('share fonts not loaded');
  }
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const measure = (t, font, spacing = 0) => {
    ctx.font = font;
    return ctx.measureText(t).width + spacing * [...t].length;
  };
  const layout = layoutCard(model, measure);
  canvas.width = layout.width;
  canvas.height = layout.height;
  drawCard(ctx, layout);
  const blob = await new Promise((res, rej) => canvas.toBlob(b => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/png'));
  canvas.width = canvas.height = 0;   // free the bitmap now (iOS caps total canvas memory)
  return { blob, width: layout.width, height: layout.height };
}
