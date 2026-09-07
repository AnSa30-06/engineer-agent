/**
 * Sprite renderer: plays pre-generated frames, drives the mouth from real audio
 * amplitude, and owns nothing else. It subscribes to application state — it
 * never decides state (section 18/22).
 *
 * No image generation happens here or anywhere else at runtime.
 */
import { createSTT } from './stt.js';

const canvas = document.getElementById('sprite');
const ctx = canvas.getContext('2d');
const bubble = document.getElementById('bubble');
const bubbleText = document.getElementById('bubble-text');
const callBox = document.getElementById('call');
const answerBtn = document.getElementById('answer');
const hud = document.getElementById('hud');
const hudState = document.querySelector('#hud-state b');
const hudModel = document.getElementById('hud-model');

// The dial's tick ring, drawn once. Building it here rather than writing 36
// <line> elements into the HTML by hand keeps the markup readable.
(function ticks() {
  const g = document.getElementById('hud-ticks');
  if (!g) return;
  const NS = 'http://www.w3.org/2000/svg';
  for (let i = 0; i < 36; i++) {
    const a = (i / 36) * Math.PI * 2;
    const long = i % 3 === 0;
    const r1 = 52, r2 = long ? 58 : 55.5;
    const l = document.createElementNS(NS, 'line');
    l.setAttribute('x1', (60 + Math.cos(a) * r1).toFixed(2));
    l.setAttribute('y1', (60 + Math.sin(a) * r1).toFixed(2));
    l.setAttribute('x2', (60 + Math.cos(a) * r2).toFixed(2));
    l.setAttribute('y2', (60 + Math.sin(a) * r2).toFixed(2));
    g.appendChild(l);
  }
})();

let manifest = null;
let missingReported = 0;
function reportMissing(src) {
  if (missingReported++ > 3) return;   // one report is enough to diagnose
  window.engineer.sttStatus({ level: 'error', human: 'My artwork did not load.', technical: `image failed to load: ${src}` });
}
let assetsPath = '';
const cache = new Map();          // "state/000" -> HTMLImageElement

// ---------------------------------------------------------------------------
// animation
// ---------------------------------------------------------------------------
/** appState -> [sequence of clips]; the last clip loops. */
const SEQUENCES = {
  STARTING: ['idle'],
  ENTERING: ['entrance!', 'sit!', 'laptop_open!'],
  IDLE: ['idle'],
  LISTENING: ['listening'],
  THINKING: ['thinking'],
  SPEAKING: ['talking'],
  PHONE_RINGING: ['phone_ring'],
  ON_CALL: ['phone_pickup!', 'phone_talk'],
  HANDOFF: ['laptop_open!', 'working'],
  WORKING: ['working'],
  TESTING: ['working'],
  WAITING_FOR_USER: ['idle'],
  COMPLETED: ['complete!', 'summary'],
  ERROR: ['error'],
};

const FPS = { entrance: 9, sit: 7, laptop_open: 7, working: 11, phone_ring: 9, default: 8 };

let queue = [];
let clip = null;        // {name, once, frames, mouth}
let frame = 0;
let acc = 0;
let last = performance.now();
let onQueueEmpty = null;
let idleMix = 0;        // occasional natural break while working
let painted = false;

function clipInfo(name) {
  const meta = manifest.states[name];
  if (!meta) return null;
  return { name, frames: meta.frames, mouth: !!meta.mouth };
}

function play(sequence, done) {
  queue = sequence.map((s) => ({ name: s.replace('!', ''), once: s.endsWith('!') }));
  onQueueEmpty = done || null;
  next();
}

function next() {
  const item = queue.shift();
  if (!item) { clip = null; return; }
  const info = clipInfo(item.name);
  if (!info) { next(); return; }
  clip = { ...info, once: item.once };
  frame = 0;
  acc = 0;
}

function frameImage(state, index, mouthOpen) {
  const dir = clip && clip.mouth ? `${state}_${mouthOpen ? 'open' : 'closed'}` : state;
  const key = `${dir}/${String(index).padStart(3, '0')}`;
  let img = cache.get(key);
  if (!img) {
    img = new Image();
    img.onerror = () => reportMissing(img.src);
    img.src = `${assetsPath}/engineer/${dir}/${String(index).padStart(3, '0')}.png`;
    cache.set(key, img);
  }
  return img;
}

function tick(now) {
  requestAnimationFrame(tick);
  if (!clip || !manifest) return;

  const fps = FPS[clip.name] || FPS.default;
  acc += now - last;
  last = now;

  if (acc >= 1000 / fps) {
    acc = 0;
    frame++;
    if (frame >= clip.frames) {
      if (clip.once) {
        if (queue.length) { next(); }
        else { clip = null; const cb = onQueueEmpty; onQueueEmpty = null; cb && cb(); return; }
      } else {
        frame = 0;
        // section 7 item 18: idle naturally now and then while working
        if (clip.name === 'working' && Math.random() < 0.22) {
          idleMix = 1;
          clip = { ...clipInfo('working_idle'), once: true };
          queue.push({ name: 'working', once: false });
          frame = 0;
        } else if (idleMix) idleMix = 0;
      }
    }
  }

  const img = frameImage(clip.name, Math.min(frame, clip.frames - 1), mouthIsOpen());
  if (img.complete && img.naturalWidth) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    if (!painted) {
      painted = true;
      window.engineer.sttStatus({ level: 'warn', technical: `first frame painted: ${clip.name} ${img.naturalWidth}x${img.naturalHeight}` });
    }
  }
}
requestAnimationFrame(tick);

// ---------------------------------------------------------------------------
// audio + mouth (section 8)
// ---------------------------------------------------------------------------
let audioCtx = null;
let analyser = null;
let currentSource = null;
let currentSpeechId = null;
let amplitude = 0;

const MOUTH_THRESHOLD = 0.045;   // below this the mouth stays shut

function mouthIsOpen() {
  return amplitude > MOUTH_THRESHOLD;
}

function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new AudioContext();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    analyser.connect(audioCtx.destination);
  }
  return audioCtx;
}

function sampleAmplitude() {
  requestAnimationFrame(sampleAmplitude);
  if (!analyser || !currentSource) { amplitude = 0; return; }
  const buf = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
  // smooth so the mouth does not flicker on every frame
  amplitude = amplitude * 0.55 + Math.sqrt(sum / buf.length) * 0.45;
}
requestAnimationFrame(sampleAmplitude);

// A reply arrives as one or more pieces. They are played strictly in order and
// back to back, so he starts talking before the whole reply has been made.
let speech = null;   // { id, total, received, played, queue[], playing }

function beginSpeech({ id, total, caption, captions }) {
  stopAudio(false);
  currentSpeechId = id;
  speech = { id, total, received: 0, played: 0, queue: [], playing: false, captions: captions || [] };
  showBubble(caption);
}

async function addSpeechChunk({ id, seq, audio }) {
  if (!speech || speech.id !== id) return;
  speech.received++;
  if (audio) {
    try {
      const ac = ensureAudio();
      if (ac.state === 'suspended') await ac.resume();
      const bytes = Uint8Array.from(atob(audio), (c) => c.charCodeAt(0));
      speech.queue.push({ seq, buffer: await ac.decodeAudioData(bytes.buffer) });
      speech.queue.sort((a, b) => a.seq - b.seq);
    } catch (e) {
      window.engineer.sttStatus({ level: 'warn', technical: `audio decode failed: ${e.message}` });
      speech.played++;
    }
  } else {
    speech.played++;                     // this piece failed upstream; skip it
  }
  pumpSpeech();
}

function pumpSpeech() {
  if (!speech || speech.playing) { finishIfDrained(); return; }
  const next = speech.queue.shift();
  if (!next) { finishIfDrained(); return; }

  // The caption follows the audio: a long reply is spoken in pieces, so the
  // bubble shows the piece being said rather than a clipped version of it all.
  const line = speech.captions[next.seq];
  if (line) showBubble(line);

  const ac = ensureAudio();
  const src = ac.createBufferSource();
  src.buffer = next.buffer;
  src.connect(analyser);
  src.onended = () => {
    if (!speech) return;
    speech.playing = false;
    currentSource = null;
    amplitude = 0;
    speech.played++;
    pumpSpeech();
  };
  speech.playing = true;
  currentSource = src;
  src.start();
}

function finishIfDrained() {
  if (!speech || speech.playing) return;
  if (speech.received < speech.total || speech.queue.length) return;
  const id = speech.id;
  speech = null;
  endSpeech(id);
}

function endSpeech(id) {
  hideBubble();
  if (currentSpeechId === id) currentSpeechId = null;
  window.engineer.speechEnded(id);
}

function stopAudio(notify = true) {
  if (currentSource) {
    try { currentSource.onended = null; currentSource.stop(); } catch { /* already stopped */ }
    currentSource = null;
  }
  amplitude = 0;
  hideBubble();
  if (notify && currentSpeechId != null) { const id = currentSpeechId; currentSpeechId = null; window.engineer.speechEnded(id); }
}

// ---------------------------------------------------------------------------
// whose turn it is
// ---------------------------------------------------------------------------
/** Short two-note chime so you can hear the hand-over without watching. */
function earcon(up = true) {
  try {
    const ac = ensureAudio();
    if (ac.state === 'suspended') ac.resume();
    const now = ac.currentTime;
    const notes = up ? [660, 880] : [520, 390];
    notes.forEach((f, i) => {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = 'sine';
      osc.frequency.value = f;
      const t = now + i * 0.085;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.13, t + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
      osc.connect(gain);
      gain.connect(ac.destination);   // not through the analyser: never moves the mouth
      osc.start(t);
      osc.stop(t + 0.16);
    });
  } catch { /* a missing chime is not worth an error */ }
}

/**
 * Point the dial at a state. `mode` is kept as the caller's vocabulary so the
 * rest of the file did not have to change:
 *   'yours' -> LISTENING · 'hearing' -> LISTENING (with level) · 'busy' -> THINKING
 */
const HUD_MODE = {
  yours:   ['state-listening', 'LISTENING'],
  hearing: ['state-listening', 'HEARING YOU'],
  busy:    ['state-thinking', 'THINKING'],
};
const HUD_STATE = {
  STARTING: ['state-idle', 'STARTING'],
  ENTERING: ['state-idle', 'ARRIVING'],
  IDLE: ['state-idle', 'IDLE'],
  LISTENING: ['state-listening', 'LISTENING'],
  THINKING: ['state-thinking', 'THINKING'],
  SPEAKING: ['state-speaking', 'SPEAKING'],
  WORKING: ['state-working', 'WORKING'],
  RINGING: ['state-ringing', 'CALLING YOU'],
  ON_CALL: ['state-ringing', 'ON CALL'],
  COMPLETED: ['state-working', 'DONE'],
  ERROR: ['state-error', 'PROBLEM'],
};

function setHud(cls, label) {
  if (!hud) return;
  for (const c of [...hud.classList]) if (c.startsWith('state-')) hud.classList.remove(c);
  hud.classList.add(cls);
  if (hudState) hudState.textContent = label;
  if (cls !== 'state-listening') setLevel(0);
}

function setLevel(v) {
  if (hud) hud.style.setProperty('--level', String(Math.max(0, Math.min(1, v))));
}

/** @param mode 'yours' | 'hearing' | 'busy' | null */
function setTurn(mode, label) {
  const m = HUD_MODE[mode];
  if (m) setHud(m[0], label && mode === 'busy' ? 'THINKING' : m[1]);
}

let bubbleTimer = null;
function showBubble(text) {
  if (!text) return;
  clearTimeout(bubbleTimer);
  bubbleText.textContent = text;
  bubble.classList.remove('hidden');
}
function hideBubble() {
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => bubble.classList.add('hidden'), 400);
}

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------
let stt = null;
let models = {};

/** 'claude-haiku-4-5-20251001' -> 'HAIKU 4.5'. The dial has room for two words. */
function shortModel(id) {
  const m = String(id || '').match(/(opus|sonnet|haiku|fable)[-_]?(\d+(?:[-.]\d+)?)?/i);
  if (!m) return String(id || '').slice(0, 12).toUpperCase();
  return `${m[1]}${m[2] ? ' ' + m[2].replace('-', '.') : ''}`.toUpperCase();
}

let currentState = 'STARTING';
let listening = false;

function applyState(state) {
  currentState = state;
  const seq = SEQUENCES[state] || ['idle'];
  if (state === 'ENTERING') {
    play(seq, () => { window.engineer.entranceDone(); play(['idle']); });
  } else {
    play(seq);
  }
  callBox.classList.toggle('hidden', state !== 'PHONE_RINGING');

  // The dial follows application state directly, so it is never out of step
  // with what he is doing. PHONE_RINGING has no SEQUENCES entry of its own
  // name here, so it is mapped explicitly.
  const look = state === 'PHONE_RINGING' ? ['state-ringing', 'CALLING YOU'] : HUD_STATE[state];
  if (look) setHud(look[0], look[1]);

  // Which brain is answering. The coding agent is a different, stronger model
  // than the interviewer, and that is worth being able to see.
  if (hudModel && models.fast) {
    const working = ['HANDOFF', 'WORKING', 'TESTING', 'COMPLETED'].includes(state);
    hudModel.textContent = shortModel(working ? models.strong : models.fast);
  }
}

(async function boot() {
  const info = await window.engineer.bootstrap();
  models = info.models || {};
  assetsPath = `file:///${info.assetsPath.replace(/\\/g, '/')}`;
  manifest = await (await fetch(`${assetsPath}/engineer/manifest.json`)).json();

  // warm the cache so the entrance does not stutter on first paint
  for (const [name, meta] of Object.entries(manifest.states)) {
    const dirs = meta.mouth ? [`${name}_closed`, `${name}_open`] : [name];
    for (const d of dirs) {
      for (let i = 0; i < meta.frames; i++) {
        const key = `${d}/${String(i).padStart(3, '0')}`;
        const img = new Image();
        img.onerror = () => reportMissing(img.src);
        img.src = `${assetsPath}/engineer/${key}.png`;
        cache.set(key, img);
      }
    }
  }

  applyState('STARTING');

  stt = createSTT({
    onText: (text) => window.engineer.userSaid(text),
    onStatus: (s) => window.engineer.sttStatus(s),
    onLevel: (v) => { if (listening) setLevel(v); },
    onSpeechStart: () => { if (listening) setTurn('hearing', 'Listening…'); },
    onSpeechEnd: () => { listening = false; setTurn('busy', 'Got that…'); },
    // Barge-in. `amplitude` is his own playback level — the same number that
    // drives the mouth — so the gate rises while he is actually loud.
    getOutputLevel: () => amplitude,
    onBargeIn: () => window.engineer.bargeIn(),
    deviceId: info.config.micDeviceId,
    model: info.config.sttModel,
  });

  window.engineer.onState(({ state }) => applyState(state));
  window.engineer.onSpeakBegin((payload) => {
    beginSpeech(payload);
    // Watch for the user talking over him. Measure-only: nothing said while he
    // is speaking is ever transcribed, so his own voice cannot become input.
    if (stt) stt.watch().catch(() => {});
  });
  window.engineer.onSpeakChunk(addSpeechChunk);
  window.engineer.onStopAudio(() => stopAudio());
  window.engineer.onCaption(({ text }) => showBubble(text));
  window.engineer.onRing(({ on }) => callBox.classList.toggle('hidden', !on));
  window.engineer.onListen(({ on }) => {
    listening = on;
    if (on) {
      earcon(true);
      setTurn('yours', 'Your turn');
      stt.start();
    } else {
      stt.stop();
      setTurn(null);
    }
  });

  window.engineer.spriteReady();
})();

canvas.addEventListener('click', () => window.engineer.togglePanel());
answerBtn.addEventListener('click', (e) => { e.stopPropagation(); window.engineer.answerCall(); });
