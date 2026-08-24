/**
 * Build-time sprite generation. Runs ONCE (npm run sprites), never at runtime.
 *
 * Anchor-first pipeline:
 *   character.js is the single anchor -> every pose below reuses its primitives
 *   -> each animation state renders as ONE strip on a unified canvas
 *   -> strips are sliced into uniform 256x256 cells (normalize)
 *   -> one global scale factor is applied to every cell
 *   -> assets/engineer/<state>/NNN.png + manifest.json
 *
 * There is exactly one character-generation event: the anchor. No pose here may
 * introduce geometry or colour that is not already in character.js.
 */
const fs = require('fs');
const pathMod = require('path');
const sharp = require('sharp');
const C = require('./character');

const CELL = 256;         // normalized cell
const SUPERSAMPLE = 2;    // render 2x then globally scale down
const SCALE = 1.34;       // ONE global scale factor, every pose, every state
const VIEW_DESK = [132, 150];     // framing centre for the seated workstation
const VIEW_ROOM = [78, 156];      // framing centre for the entrance
const OUT = pathMod.join(__dirname, '..', 'assets', 'engineer');

// --- scene anchors (one layout, shared by every seated state) ---------------
const TORSO = [116, 132];
const HEAD = [0, -33];
const DESK = [128, 178];
const CHAIR = [112, 160];
const LAPTOP = [152, 178];
const PHONE = [74, 178];
const MUG = [196, 176];

const t = (p, body) => C.g(`translate(${p[0]} ${p[1]})`, body);

/** Seated engineer. Every seated state routes through this one function. */
function seated(o = {}) {
  const bob = o.bob ?? 0;
  const lean = o.lean ?? 0;
  let s = '';
  s += C.seatedLegs();
  s += C.torso();
  // far arm first so it sits behind the torso
  if (o.farArm) s += C.arm(-12, -4, o.farArm[0] * 0.6 - 6, o.farArm[1] * 0.6, o.farArm[0], o.farArm[1]);
  s += t([HEAD[0], HEAD[1]], C.head(o.head || {}));
  if (o.nearArm) s += C.arm(12, -4, o.nearArm[0] * 0.6 + 6, o.nearArm[1] * 0.6, o.nearArm[0], o.nearArm[1]);
  if (o.handset) s += C.g(`translate(${o.handset[0]} ${o.handset[1]}) rotate(${o.handset[2] || 0})`, C.phone('hand'));
  return C.g(`translate(${TORSO[0] + lean} ${TORSO[1] + bob})`, s);
}

/** Standing engineer, used by the entrance and the sit-down transition. */
function standing(o = {}) {
  let s = '';
  s += o.walk !== undefined ? C.walkLegs(o.walk) : C.standLegs();
  s += C.torso();
  if (o.farArm) s += C.arm(-12, -4, o.farArm[0] * 0.6 - 6, o.farArm[1] * 0.6, o.farArm[0], o.farArm[1]);
  s += t([HEAD[0], HEAD[1]], C.head(o.head || {}));
  if (o.nearArm) s += C.arm(12, -4, o.nearArm[0] * 0.6 + 6, o.nearArm[1] * 0.6, o.nearArm[0], o.nearArm[1]);
  return C.g(`translate(${o.x} ${o.y})`, s);
}

/** Desk + chair + props. `omit` hides a prop that the pose is holding. */
function workstation(o = {}) {
  let s = '';
  s += t(CHAIR, C.chair());
  s += o.body || '';
  s += t(DESK, C.desk());
  s += t(LAPTOP, C.laptop(o.lid ?? 1, o.glow ?? true, o.code ?? 0));
  if (o.phone === 'hidden') s += t(PHONE, C.phoneBase());
  else s += t(PHONE, C.phone('desk', o.ring ?? 0));
  s += t(MUG, C.mug());
  return s;
}

// natural walking arm swing, reused by the entrance
const swing = (ph) => ({
  farArm: [-20 + Math.sin(ph * Math.PI * 2 + Math.PI) * 7, 28],
  nearArm: [20 + Math.sin(ph * Math.PI * 2) * 7, 28],
});

// ---------------------------------------------------------------------------
// STATES — each entry returns the full 256x256 scene for one frame.
// ---------------------------------------------------------------------------
const blink = (i, every, at) => (i % every === at ? 'closed' : 'open');

const STATES = {
  // 1-6: door opens, engineer walks in, heads for the workstation
  entrance: Array.from({ length: 12 }, (_, i) => () => {
    const doorOpen = Math.min(1, i / 3.2);
    const walkT = Math.max(0, (i - 3) / 8);
    const x = 34 + walkT * 82;
    const ph = (i - 3) / 4;
    let s = C.rect(-20, 196, 300, 4, 2, C.flat('#5A4632'));
    s += t([44, 196], C.door(doorOpen));
    if (i >= 3) {
      s += standing({
        x, y: 138, walk: ph,
        head: { turn: 0.5, eyes: i === 7 ? 'closed' : 'open', mouth: 'smile' },
        ...swing(ph),
      });
    }
    return s;
  }),

  // engineer arrives and lowers himself into the chair
  sit: Array.from({ length: 6 }, (_, i) => () => {
    const k = i / 5;
    return workstation({
      lid: 0, glow: false,
      body: k < 0.55
        ? standing({
            x: 116, y: 138 + k * 14,
            head: { turn: 0.45, eyes: 'open', mouth: 'smile' },
            farArm: [-22, 22], nearArm: [22, 22],
          })
        : seated({
            bob: (1 - k) * 10,
            head: { turn: 0.45, eyes: 'open', mouth: 'smile' },
            farArm: [-24, 20], nearArm: [24, 20],
          }),
    });
  }),

  // reaches out and lifts the lid
  laptop_open: Array.from({ length: 5 }, (_, i) => () => {
    const k = i / 4;
    return workstation({
      lid: k, glow: k > 0.5, code: i,
      body: seated({
        head: { turn: 0.55, eyes: 'open', mouth: k > 0.6 ? 'smile' : 'closed' },
        farArm: [-24, 22],
        nearArm: [26 + k * 6, 30 - k * 14],
      }),
    });
  }),

  idle: Array.from({ length: 6 }, (_, i) => () =>
    workstation({
      code: i,
      body: seated({
        bob: Math.sin((i / 6) * Math.PI * 2) * 1.4,
        head: { turn: 0.4, tilt: Math.sin((i / 6) * Math.PI * 2) * 1.5, eyes: blink(i, 6, 4), mouth: 'closed' },
        farArm: [-24, 25], nearArm: [24, 27],
      }),
    })),

  // attentive: leans toward the user, brows up, hand near ear
  listening: Array.from({ length: 6 }, (_, i) => () =>
    workstation({
      code: i,
      body: seated({
        lean: -2,
        bob: Math.sin((i / 6) * Math.PI * 2) * 1.2,
        head: { turn: -0.15, tilt: -3, eyes: blink(i, 6, 5), mouth: 'closed', brow: 1 },
        farArm: [-25, 23], nearArm: [25, 25],
      }),
    })),

  thinking: Array.from({ length: 6 }, (_, i) => () =>
    workstation({
      code: i,
      body: seated({
        head: { turn: 0.1, tilt: -6, eyes: 'up', mouth: 'flat', brow: -1 },
        farArm: [-24, 25],
        nearArm: [7 + Math.sin((i / 6) * Math.PI * 2) * 1.5, -22],
      }),
    })),

  working: Array.from({ length: 8 }, (_, i) => () => {
    const a = Math.sin((i / 8) * Math.PI * 2) * 3;
    const b = Math.sin((i / 8) * Math.PI * 2 + Math.PI) * 3;
    return workstation({
      code: i,
      body: seated({
        bob: Math.sin((i / 8) * Math.PI * 4) * 0.9,
        head: { turn: 0.6, tilt: 4, eyes: blink(i, 8, 6), mouth: 'closed' },
        farArm: [22, 42 + a], nearArm: [34, 44 + b],
      }),
    });
  }),

  // natural micro-breaks while the agent is still running
  working_idle: Array.from({ length: 8 }, (_, i) => () => {
    const k = i / 7;
    const stretch = k < 0.5;
    return workstation({
      code: i,
      body: seated({
        lean: stretch ? 3 : 0,
        head: { turn: stretch ? 0.2 : 0.6, tilt: stretch ? -8 : 4, eyes: stretch ? 'closed' : 'open', mouth: stretch ? 'o' : 'closed' },
        farArm: stretch ? [-20, -18] : [22, 42],
        nearArm: stretch ? [22, -22] : [34, 44],
      }),
    });
  }),

  // 10-11: the telephone rings and the engineer notices it
  phone_ring: Array.from({ length: 6 }, (_, i) => () =>
    workstation({
      code: i,
      ring: (i + 1) / 6,
      body: seated({
        head: { turn: i > 1 ? -0.5 : 0.5, tilt: i > 1 ? -4 : 3, eyes: i > 1 ? 'wide' : 'open', mouth: i > 2 ? 'o' : 'closed', brow: 1 },
        farArm: [-24, 25], nearArm: [28, 38],
      }),
    })),

  // 12: reaches for the handset and brings it to his ear
  phone_pickup: Array.from({ length: 5 }, (_, i) => () => {
    const k = i / 4;
    const hx = -42 + k * 16;
    const hy = 46 - k * 74;
    return workstation({
      code: i, phone: 'hidden',
      body: seated({
        head: { turn: -0.4, tilt: -3, eyes: 'open', mouth: 'closed' },
        farArm: [hx, hy],
        nearArm: [26, 29],
        handset: [hx, hy, -18 - k * 8],
      }),
    });
  }),

  // 14-15: finishes the call and puts the handset back
  phone_hangup: Array.from({ length: 4 }, (_, i) => () => {
    const k = i / 3;
    const hx = -26 - k * 16;
    const hy = -28 + k * 74;
    return workstation({
      code: i, phone: k > 0.85 ? 'desk' : 'hidden',
      body: seated({
        head: { turn: -0.2 + k * 0.7, tilt: 0, eyes: 'open', mouth: k > 0.6 ? 'smile' : 'closed' },
        farArm: [hx, hy],
        nearArm: [26, 29],
        handset: k > 0.85 ? null : [hx, hy, -26 + k * 26],
      }),
    });
  }),

  // 19-20: stops typing, leans back, satisfied
  complete: Array.from({ length: 6 }, (_, i) => () => {
    const k = i / 5;
    return workstation({
      code: 0,
      lid: 1 - k * 0.35,
      body: seated({
        lean: k * 4,
        head: { turn: 0.45 - k * 0.4, tilt: -k * 6, eyes: k > 0.6 ? 'happy' : 'open', mouth: k > 0.5 ? 'smile' : 'closed' },
        farArm: [-18 - k * 6, 26 - k * 4],
        nearArm: [30 - k * 12, 42 - k * 14],
      }),
    });
  }),

  // 32: something failed — visibly, not silently
  error: Array.from({ length: 5 }, (_, i) => () =>
    workstation({
      code: i, glow: false,
      body: seated({
        lean: -1,
        head: { turn: 0.2, tilt: 5, eyes: i % 4 === 3 ? 'closed' : 'open', mouth: 'flat', brow: -1 },
        farArm: [-24, 25],
        nearArm: [8, -20],
      }),
    }) + C.g(`translate(196 96)`,
      C.path('M-9 -13 l18 0 l-9 -13 z', C.outline(C.P.alert)) +
      C.line(0, -12, 0, -5, '#FFFFFF', 2.6) +
      C.ell(0, -1.6, 1.4, 1.4, C.flat('#FFFFFF'))),
  ),
};

// Mouth-variant states: rendered twice, closed and open (section 8).
// Only these three states ever speak, so only these three pay for two sets.
const TALK_STATES = {
  talking: (mouth, i) =>
    workstation({
      code: i,
      body: seated({
        bob: Math.sin((i / 4) * Math.PI * 2) * 1.3,
        head: { turn: -0.1, tilt: Math.sin((i / 4) * Math.PI * 2) * 2.5, eyes: blink(i, 4, 3), mouth },
        farArm: [-25, 23],
        nearArm: [22 + Math.sin((i / 4) * Math.PI * 2) * 5, 20],
      }),
    }),
  phone_talk_mouth: (mouth, i) =>
    workstation({
      code: i, phone: 'hidden',
      body: seated({
        bob: Math.sin((i / 4) * Math.PI * 2) * 1.2,
        head: { turn: -0.35, tilt: -2 + Math.sin((i / 4) * Math.PI * 2) * 2, eyes: blink(i, 4, 3), mouth },
        farArm: [-26, -28],
        nearArm: [18, 30],
        handset: [-26, -28, -26],
      }),
    }),
  // 21: the spoken completion summary, laptop half closed
  summary: (mouth, i) =>
    workstation({
      code: 0, lid: 0.6,
      body: seated({
        lean: 2,
        head: { turn: -0.15, tilt: Math.sin((i / 4) * Math.PI * 2) * 2, eyes: i % 4 === 3 ? 'happy' : 'open', mouth: mouth === 'closed' ? 'smile' : 'open' },
        farArm: [-25, 23],
        nearArm: [24 + Math.sin((i / 4) * Math.PI * 2) * 5, 18],
      }),
    }),
};

// ---------------------------------------------------------------------------
// render: one unified strip canvas per state, then normalize + global scale
// ---------------------------------------------------------------------------
function strip(frames, view) {
  const w = CELL * frames.length;
  const [cx, cy] = view || VIEW_DESK;
  // normalize: every cell is framed by the same global scale, only the centre moves
  const fit = `translate(${CELL / 2} ${CELL / 2}) scale(${SCALE}) translate(${-cx} ${-cy})`;
  const cells = frames
    .map((f, i) => `<g transform="translate(${i * CELL} 0)"><g transform="${fit}">${f()}</g></g>`)
    .join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w * SUPERSAMPLE}" height="${CELL * SUPERSAMPLE}" ` +
    `viewBox="0 0 ${w} ${CELL}"><g shape-rendering="geometricPrecision">${cells}</g></svg>`
  );
}

async function emit(name, frames, view) {
  const dir = pathMod.join(OUT, name);
  fs.mkdirSync(dir, { recursive: true });

  // 1. unified strip canvas
  const svg = strip(frames, view);
  // 2. rasterize supersampled, then 3. global scale down to the normalized cell
  const raw = await sharp(Buffer.from(svg))
    .resize({ width: CELL * frames.length, height: CELL, fit: 'fill' })
    .png()
    .toBuffer();

  // 4. slice into uniform, transparently padded cells
  for (let i = 0; i < frames.length; i++) {
    await sharp(raw)
      .extract({ left: i * CELL, top: 0, width: CELL, height: CELL })
      .png({ compressionLevel: 9 })
      .toFile(pathMod.join(dir, String(i).padStart(3, '0') + '.png'));
  }
  return frames.length;
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  const manifest = { cell: CELL, states: {} };

  for (const [name, frames] of Object.entries(STATES)) {
    const view = name === 'entrance' ? VIEW_ROOM : VIEW_DESK;
    manifest.states[name] = { frames: await emit(name, frames, view), mouth: false };
    console.log(`  ${name.padEnd(16)} ${manifest.states[name].frames} frames`);
  }

  for (const [name, fn] of Object.entries(TALK_STATES)) {
    const base = name === 'phone_talk_mouth' ? 'phone_talk' : name;
    const count = 4;
    for (const mouth of ['closed', 'open']) {
      const frames = Array.from({ length: count }, (_, i) => () => fn(mouth, i));
      await emit(`${base}_${mouth}`, frames);
    }
    manifest.states[base] = { frames: count, mouth: true };
    console.log(`  ${base.padEnd(16)} ${count} frames x2 (mouth closed/open)`);
  }

  // the anchor sheet itself, kept for reference and for visual diffing
  await emit('canonical', [() => workstation({ body: seated({ head: { turn: 0.4 }, farArm: [-24, 25], nearArm: [24, 27] }) })]);
  manifest.states.canonical = { frames: 1, mouth: false };

  fs.writeFileSync(pathMod.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const total = Object.values(manifest.states).reduce((a, s) => a + s.frames * (s.mouth ? 2 : 1), 0);
  console.log(`\n${total} frames from 1 anchor -> ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
