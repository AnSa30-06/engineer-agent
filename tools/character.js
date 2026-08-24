/**
 * THE ANCHOR — the single canonical definition of the engineer.
 *
 * This file is generated ONCE and is the only place the character exists.
 * Every animation frame in assets/engineer/ is derived from these primitives,
 * so proportions, face, hairstyle, clothing, laptop, telephone and palette
 * cannot drift between states. There is no second character design anywhere.
 *
 * Anchor-first pipeline (AI Game Sprite Generator methodology):
 *   1. anchor locks palette + proportions + line weight   <- this file
 *   2. whole animation strips render on one unified canvas <- generate-sprites.js
 *   3. normalize (uniform cell, transparent padding)
 *   4. global scale (one factor for every pose)
 *
 * Character: "Kai" — compact software engineer, dark tied-back ponytail,
 * round glasses, teal hoodie, laptop, coral desk telephone.
 */

// ---------------------------------------------------------------------------
// PALETTE — locked. Nothing outside this object may introduce a colour.
// ---------------------------------------------------------------------------
const P = {
  ink: '#241F2B',
  skin: '#F4C89E',
  skinShade: '#DFAB7E',
  hair: '#2E2A33',
  hairHi: '#4A4353',
  hoodie: '#2F7D6B',
  hoodieHi: '#3FA189',
  hoodieShade: '#215A4D',
  pants: '#2B3245',
  pantsHi: '#3A4359',
  shoe: '#F0EBE3',
  sole: '#3A3F52',
  lapBody: '#C9CFD8',
  lapEdge: '#9AA3B0',
  lapScreen: '#161E29',
  lapGlow: '#5BE3B0',
  phone: '#E4572E',
  phoneDark: '#B23D1C',
  cord: '#3A3F52',
  desk: '#8A6242',
  deskDark: '#68482F',
  chair: '#39405A',
  chairDark: '#2A3045',
  lens: '#DCEBF5',
  mug: '#EDE7DD',
  mugRim: '#CFC7BA',
  door: '#7A5638',
  doorDark: '#573C26',
  doorKnob: '#E8C46A',
  ring: '#FFD466',
  alert: '#E4572E',
};

const STROKE = 2.2; // line weight — locked by the anchor

// ---------------------------------------------------------------------------
// tiny svg helpers
// ---------------------------------------------------------------------------
const n = (v) => Math.round(v * 100) / 100;
const outline = (fill) => `fill="${fill}" stroke="${P.ink}" stroke-width="${STROKE}" stroke-linejoin="round" stroke-linecap="round"`;
const flat = (fill) => `fill="${fill}"`;

const ell = (cx, cy, rx, ry, attrs) => `<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(rx)}" ry="${n(ry)}" ${attrs}/>`;
const rect = (x, y, w, h, r, attrs) => `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${n(r)}" ${attrs}/>`;
const path = (d, attrs) => `<path d="${d}" ${attrs}/>`;
const line = (x1, y1, x2, y2, col, w) =>
  `<path d="M${n(x1)} ${n(y1)} L${n(x2)} ${n(y2)}" fill="none" stroke="${col}" stroke-width="${n(w)}" stroke-linecap="round"/>`;
const g = (transform, body) => `<g transform="${transform}">${body}</g>`;

/** Two-segment limb drawn as a rounded polyline. Shared by every arm and leg. */
function limb(ax, ay, bx, by, cx, cy, colour, width) {
  return (
    `<path d="M${n(ax)} ${n(ay)} Q${n(bx)} ${n(by)} ${n(cx)} ${n(cy)}" fill="none" ` +
    `stroke="${P.ink}" stroke-width="${n(width + STROKE)}" stroke-linecap="round"/>` +
    `<path d="M${n(ax)} ${n(ay)} Q${n(bx)} ${n(by)} ${n(cx)} ${n(cy)}" fill="none" ` +
    `stroke="${colour}" stroke-width="${n(width)}" stroke-linecap="round"/>`
  );
}

// ---------------------------------------------------------------------------
// HEAD — face, hair, ponytail, glasses. Identical geometry in every state.
// ---------------------------------------------------------------------------
/**
 * @param o.turn  -1 (away/left) .. 0 (front) .. 1 (toward laptop/right)
 * @param o.tilt  degrees
 * @param o.eyes  'open' | 'closed' | 'happy' | 'wide' | 'up'
 * @param o.mouth 'closed' | 'open' | 'smile' | 'flat' | 'o'
 * @param o.brow  -1 worried | 0 neutral | 1 raised
 */
function head(o = {}) {
  const turn = o.turn ?? 0.35;
  const tilt = o.tilt ?? 0;
  const eyes = o.eyes ?? 'open';
  const mouth = o.mouth ?? 'closed';
  const brow = o.brow ?? 0;

  const dx = turn * 4.5;          // features shift with the head turn
  const R = 21;                    // skull radius — anchor proportion

  let s = '';

  // ponytail (behind the skull, on the trailing side) — the silhouette cue
  const px = -R * 0.85 - turn * 5;
  s += path(
    `M${n(px)} ${n(-4)} q${n(-11 - turn * 3)} 5 ${n(-8)} 17 q2 8 7 6 q-4 -12 3 -20 z`,
    outline(P.hair)
  );
  s += ell(px - 2.5, -5, 5.2, 5.2, outline(P.hair));

  // skull
  s += ell(0, 0, R, R * 0.97, outline(P.skin));

  // ear on the trailing side
  s += ell(-R * 0.9 + turn * 2, 2, 4, 5.4, outline(P.skin));

  // hair cap + fringe, drawn over the skull
  s += path(
    `M${n(-R - 0.6)} ${n(-1)} a${R + 0.6} ${R + 0.6} 0 0 1 ${n(2 * R + 1.2)} 0 ` +
      `q-3 -4 -8 -3 q-5 -7 -14 -5 q-9 2 -11 8 z`,
    outline(P.hair)
  );
  s += path(`M${n(-4 + dx)} ${n(-19)} q9 3 14 12 q1 -12 -8 -15 z`, flat(P.hairHi));

  // glasses
  const lensR = 7.2;
  const lx = -8.5 + dx, rx = 8.5 + dx;
  s += ell(lx, 1.5, lensR, lensR * 0.88, `fill="${P.lens}" fill-opacity="0.55" stroke="${P.ink}" stroke-width="${STROKE}"`);
  s += ell(rx, 1.5, lensR, lensR * 0.88, `fill="${P.lens}" fill-opacity="0.55" stroke="${P.ink}" stroke-width="${STROKE}"`);
  s += line(lx + lensR, 1.5, rx - lensR, 1.5, P.ink, STROKE);
  s += line(rx + lensR, 1.5, R - 2 + dx * 0.3, 2.5, P.ink, STROKE);

  // eyes
  if (eyes === 'closed') {
    s += path(`M${n(lx - 3.4)} ${n(1.8)} q3.4 3.2 6.8 0`, `fill="none" stroke="${P.ink}" stroke-width="${STROKE}" stroke-linecap="round"`);
    s += path(`M${n(rx - 3.4)} ${n(1.8)} q3.4 3.2 6.8 0`, `fill="none" stroke="${P.ink}" stroke-width="${STROKE}" stroke-linecap="round"`);
  } else if (eyes === 'happy') {
    s += path(`M${n(lx - 3.4)} ${n(3)} q3.4 -4.2 6.8 0`, `fill="none" stroke="${P.ink}" stroke-width="${STROKE}" stroke-linecap="round"`);
    s += path(`M${n(rx - 3.4)} ${n(3)} q3.4 -4.2 6.8 0`, `fill="none" stroke="${P.ink}" stroke-width="${STROKE}" stroke-linecap="round"`);
  } else {
    const ry = eyes === 'wide' ? 3.5 : 2.9;
    const rxx = eyes === 'wide' ? 2.8 : 2.4;
    const look = eyes === 'up' ? -1.4 : 0;
    s += ell(lx + 0.5, 1.8 + look, rxx, ry, flat(P.ink));
    s += ell(rx + 0.5, 1.8 + look, rxx, ry, flat(P.ink));
    s += ell(lx + 1.3, 0.7 + look, 0.9, 1.1, flat('#FFFFFF'));
    s += ell(rx + 1.3, 0.7 + look, 0.9, 1.1, flat('#FFFFFF'));
  }

  // brows
  const by = brow === 1 ? -8.5 : brow === -1 ? -6.2 : -7.2;
  const bt = brow === -1 ? 2.2 : 0;
  s += line(lx - 4, by + bt, lx + 3.5, by - 0.6, P.ink, STROKE);
  s += line(rx - 3.5, by - 0.6, rx + 4, by + bt, P.ink, STROKE);

  // mouth — the whole lip-sync system is these two shapes
  const mx = dx * 0.8;
  if (mouth === 'open') {
    s += ell(mx, 11.5, 4.2, 4.6, outline('#8C4A47'));
    s += ell(mx, 13.6, 2.6, 1.8, flat('#E08D86'));
  } else if (mouth === 'o') {
    s += ell(mx, 11.5, 2.8, 3.2, outline('#8C4A47'));
  } else if (mouth === 'smile') {
    s += path(`M${n(mx - 5)} ${n(9.5)} q5 5.5 10 0`, `fill="none" stroke="${P.ink}" stroke-width="${STROKE}" stroke-linecap="round"`);
  } else if (mouth === 'flat') {
    s += line(mx - 4, 11.5, mx + 4, 11.5, P.ink, STROKE);
  } else {
    s += path(`M${n(mx - 4)} ${n(10.8)} q4 3.2 8 0`, `fill="none" stroke="${P.ink}" stroke-width="${STROKE}" stroke-linecap="round"`);
  }

  // cheek
  s += ell(-14 + dx, 7.5, 3.2, 2, `fill="${P.skinShade}" fill-opacity="0.65"`);

  return g(`rotate(${n(tilt)})`, s);
}

// ---------------------------------------------------------------------------
// BODY
// ---------------------------------------------------------------------------
function torso() {
  let s = '';
  s += path(
    `M-17 -2 q0 -12 17 -12 q17 0 17 12 l3 30 q-20 5 -40 0 z`,
    outline(P.hoodie)
  );
  s += path(`M-8 -13 q8 9 16 0 q-2 8 -8 8 q-6 0 -8 -8 z`, flat(P.hoodieShade)); // hood collar
  s += path(`M11 -8 q7 3 8 12 l1 14 q-6 2 -8 -2 z`, flat(P.hoodieHi));
  s += line(0, 4, 0, 20, P.hoodieShade, 1.8); // zip
  s += ell(-9, 22, 5, 3.2, `fill="${P.hoodieShade}" fill-opacity="0.7"`); // pocket
  return s;
}

function seatedLegs() {
  let s = '';
  // thighs forward, shins down — seated at the desk
  s += limb(-7, 26, 4, 34, 20, 34, P.pants, 11);
  s += limb(7, 27, 16, 35, 26, 36, P.pants, 11);
  s += limb(20, 34, 24, 44, 22, 54, P.pants, 9.5);
  s += limb(26, 36, 30, 46, 28, 55, P.pants, 9.5);
  s += rect(15, 53, 15, 7, 3.2, outline(P.shoe));
  s += rect(21, 55, 15, 7, 3.2, outline(P.shoe));
  s += rect(15, 58, 15, 2.6, 1.2, flat(P.sole));
  s += rect(21, 60, 15, 2.6, 1.2, flat(P.sole));
  return s;
}

/** phase 0..1 around the walk cycle */
function walkLegs(phase) {
  const a = Math.sin(phase * Math.PI * 2);
  const b = Math.sin(phase * Math.PI * 2 + Math.PI);
  let s = '';
  s += limb(-3, 26, -3 + a * 8, 40, -2 + a * 15, 54, P.pants, 10.5);
  s += rect(-9 + a * 15, 53, 16, 7, 3.2, outline(P.shoe));
  s += limb(3, 26, 3 + b * 8, 40, 4 + b * 15, 54, P.pants, 10.5);
  s += rect(-3 + b * 15, 53, 16, 7, 3.2, outline(P.shoe));
  return s;
}

function standLegs() {
  let s = '';
  s += limb(-4, 26, -5, 40, -5, 54, P.pants, 10.5);
  s += limb(5, 26, 6, 40, 6, 54, P.pants, 10.5);
  s += rect(-12, 53, 16, 7, 3.2, outline(P.shoe));
  s += rect(-1, 53, 16, 7, 3.2, outline(P.shoe));
  return s;
}

/** hand: a — shoulder, b — elbow control point, c — hand position */
function arm(sx, sy, ex, ey, hx, hy) {
  return limb(sx, sy, ex, ey, hx, hy, P.hoodie, 9) + ell(hx, hy, 4.4, 4.4, outline(P.skin));
}

// ---------------------------------------------------------------------------
// PROPS
// ---------------------------------------------------------------------------
/**
 * lid: 0 = shut (lid lying flat on the base), 1 = fully open.
 * The lid is a quad interpolated between "upright panel" and "flat slab" — a
 * rotation reads wrong in this near-side view, an interpolated quad reads right.
 */
function laptop(lid = 1, glow = true, code = 0) {
  const k = Math.max(0, Math.min(1, lid));
  let s = '';
  s += path(`M-26 0 l52 0 l5 7 l-62 0 z`, outline(P.lapBody)); // base
  s += rect(-24, -4, 48, 4, 1.6, outline(P.lapEdge));          // keyboard deck

  // lid corners: open (-23,-35)..(23,-4)   shut (-26,-9)..(26,-4)
  const topY = -4 - 31 * k - 5 * (1 - k);
  const halfW = 23 * k + 26 * (1 - k);
  s += path(
    `M${n(-halfW)} ${n(topY)} L${n(halfW)} ${n(topY)} L23 -4 L-23 -4 z`,
    outline(P.lapBody)
  );
  if (k > 0.3) {
    const iw = halfW - 3.5, it = topY + 3.5;
    s += path(`M${n(-iw)} ${n(it)} L${n(iw)} ${n(it)} L19.5 -7 L-19.5 -7 z`, flat(P.lapScreen));
    if (glow) {
      const rows = Math.max(1, Math.round((-7 - it) / 5));
      for (let i = 0; i < rows; i++) {
        const w = 7 + ((i * 7 + code * 5) % 20);
        s += rect(-iw + 2.5, it + 2 + i * 5, w, 2.2, 1,
          `fill="${P.lapGlow}" fill-opacity="${0.35 + (i % 2) * 0.4}"`);
      }
    }
  }
  return s;
}

/** state: 'desk' | 'lifted' | 'ear'; ring: 0..1 shake amount */
function phone(state = 'desk', ring = 0) {
  const shake = ring ? Math.sin(ring * Math.PI * 6) * 2.6 : 0;
  let s = '';
  if (state === 'desk') {
    s += g(`translate(${n(shake)} 0) rotate(${n(shake * 0.8)})`,
      rect(-11, -4, 22, 9, 2.6, outline(P.phone)) +
      rect(-13, -9, 26, 6, 2.6, outline(P.phoneDark)) +
      ell(-9, -6, 2.4, 2, flat(P.phone)) +
      ell(9, -6, 2.4, 2, flat(P.phone)));
    if (ring) {
      s += path(`M-19 -14 q-4 -4 -4 -9`, `fill="none" stroke="${P.ring}" stroke-width="2.4" stroke-linecap="round"`);
      s += path(`M19 -14 q4 -4 4 -9`, `fill="none" stroke="${P.ring}" stroke-width="2.4" stroke-linecap="round"`);
      s += path(`M-24 -20 q-5 -5 -5 -12`, `fill="none" stroke="${P.ring}" stroke-width="2" stroke-linecap="round" opacity="0.7"`);
      s += path(`M24 -20 q5 -5 5 -12`, `fill="none" stroke="${P.ring}" stroke-width="2" stroke-linecap="round" opacity="0.7"`);
    }
  } else {
    // handset alone
    s += rect(-4.5, -11, 9, 22, 4, outline(P.phoneDark));
    s += ell(0, -11.5, 6.4, 4.6, outline(P.phone));
    s += ell(0, 11.5, 6.4, 4.6, outline(P.phone));
    s += ell(0, -11.5, 2.6, 1.8, flat(P.phoneDark));
  }
  return s;
}

/** the cradle the handset leaves behind while it is at the engineer's ear */
function phoneBase() {
  return rect(-11, -4, 22, 9, 2.6, outline(P.phone));
}

function desk() {
  let s = '';
  s += rect(-70, 0, 148, 8, 2.4, outline(P.desk));
  s += rect(-62, 8, 7, 34, 2, outline(P.deskDark));
  s += rect(64, 8, 7, 34, 2, outline(P.deskDark));
  return s;
}

function chair() {
  let s = '';
  s += rect(-16, -46, 9, 46, 4, outline(P.chairDark)); // backrest
  s += rect(-18, 0, 34, 7, 3, outline(P.chair));       // seat
  s += rect(-3, 7, 6, 16, 2, outline(P.chairDark));    // stem
  s += path(`M-16 25 l32 0 l-4 5 l-24 0 z`, outline(P.chairDark));
  return s;
}

function mug() {
  return (
    ell(0, 0, 6, 3, outline(P.mugRim)) +
    path(`M-6 0 l1.5 11 q4.5 2 9 0 l1.5 -11 z`, outline(P.mug)) +
    path(`M6 2 q6 1 4 6 q-1 2 -4 1.5`, `fill="none" stroke="${P.ink}" stroke-width="${STROKE}"`)
  );
}

/** open: 0 shut .. 1 fully open */
function door(open = 0) {
  const w = 54 * (1 - open * 0.92);
  let s = '';
  s += rect(-27, -76, 54, 76, 2, flat('#171320'));                // the room beyond
  s += rect(-27, -76, Math.max(w, 3), 76, 2, outline(P.door));    // leaf swings away
  if (w > 16) s += ell(-27 + w - 7, -38, 2.8, 2.8, outline(P.doorKnob));
  s += rect(-33, -82, 66, 7, 2, outline(P.doorDark));             // lintel
  s += rect(-33, -82, 7, 82, 2, outline(P.doorDark));             // jambs
  s += rect(26, -82, 7, 82, 2, outline(P.doorDark));
  return s;
}

module.exports = {
  P, STROKE,
  head, torso, seatedLegs, walkLegs, standLegs, arm, limb,
  laptop, phone, phoneBase, desk, chair, mug, door,
  g, rect, ell, path, line, outline, flat, n,
};
