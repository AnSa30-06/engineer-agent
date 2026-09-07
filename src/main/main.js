/**
 * Application entry point and orchestration.
 *
 * Two windows: a transparent frameless overlay holding only the engineer, and a
 * small control/log panel that opens on demand. The desktop stays usable
 * because the overlay is only as large as the character.
 */
const { app, BrowserWindow, ipcMain, screen, dialog, Tray, Menu, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const core = require('./core');
const config = require('./config');
const tts = require('./tts');
const narrator = require('./narrator');
const coder = require('./coder');
const llm = require('./llm');
const memory = require('./memory');
const { Interview, briefFor } = require('./interviewer');

const SPRITE_W = 340;
const SPRITE_H = 300;
const ASSETS = path.join(__dirname, '..', '..', 'assets');

let spriteWin = null;
let panelWin = null;
let tray = null;

// --- session state ---------------------------------------------------------
let interview = null;      // active Interview, or null
let build = null;          // active coder run handle, or null
let lastPacket = null;     // last handoff, for follow-up questions
let engaged = false;       // has he been addressed yet? gates the wake word
let ringTimer = null;
let speechSeq = 0;
const speechWaiters = new Map();

const cfg = () => config.load();

// ---------------------------------------------------------------------------
// windows
// ---------------------------------------------------------------------------
function spriteBounds() {
  const area = screen.getPrimaryDisplay().workArea;
  return {
    x: Math.round(area.x + area.width - SPRITE_W - 12),
    y: Math.round(area.y + area.height - SPRITE_H - 8),
    width: SPRITE_W,
    height: SPRITE_H,
  };
}

function createSprite() {
  spriteWin = new BrowserWindow({
    ...spriteBounds(),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,          // section 4: the engineer is not draggable
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,       // no task window around the sprite
    alwaysOnTop: true,
    hasShadow: false,
    focusable: true,
    show: false,
    title: 'Engineer',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  spriteWin.setAlwaysOnTop(true, 'screen-saver');
  // visibleOnFullScreen is macOS-only and ignored elsewhere. Without it the
  // engineer vanishes the moment the user enters a fullscreen Space, which for
  // an overlay that is meant to always be there reads as the app crashing.
  spriteWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  wireConsole(spriteWin, 'sprite');
  spriteWin.loadFile(path.join(__dirname, '..', 'sprite', 'index.html'));
  spriteWin.once('ready-to-show', () => {
    spriteWin.show();
    const b = spriteWin.getBounds();
    core.log({ kind: 'boot', human: null, technical: `sprite window shown at ${b.x},${b.y} ${b.width}x${b.height} visible=${spriteWin.isVisible()} display=${JSON.stringify(screen.getPrimaryDisplay().workArea)}` });
  });
  spriteWin.on('closed', () => { spriteWin = null; });
}

function createPanel(show = true) {
  if (panelWin) {
    if (show) { panelWin.show(); panelWin.focus(); }
    return panelWin;
  }
  const area = screen.getPrimaryDisplay().workArea;
  panelWin = new BrowserWindow({
    width: 460,
    height: 620,
    x: Math.round(area.x + area.width - 460 - 24),
    y: Math.round(area.y + area.height - 620 - SPRITE_H - 4),
    frame: false,
    resizable: true,
    minWidth: 380,
    minHeight: 380,
    skipTaskbar: false,
    show: false,
    backgroundColor: '#14151b',
    title: 'Engineer — controls',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  wireConsole(panelWin, 'panel');
  panelWin.loadFile(path.join(__dirname, '..', 'panel', 'index.html'));
  panelWin.once('ready-to-show', () => { if (show) panelWin.show(); });
  panelWin.on('closed', () => { panelWin = null; });
  return panelWin;
}

/** Renderer errors must be visible, not swallowed. */
function wireConsole(win, tag) {
  win.webContents.on('console-message', (e) => {
    const level = e.level === 'error' ? 'error' : e.level === 'warning' ? 'warn' : 'info';
    if (level === 'info') return;   // keep the log readable
    core.log({ kind: 'renderer', level, human: null, technical: `[${tag}] ${e.message} (${e.sourceId}:${e.lineNumber})` });
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    core.log({ kind: 'error', level: 'error', human: 'Part of the app stopped unexpectedly.', technical: `[${tag}] render process gone: ${d.reason}` });
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    core.log({ kind: 'error', level: 'error', human: null, technical: `[${tag}] failed to load: ${code} ${desc}` });
  });
}

const toSprite = (ch, payload) => spriteWin && !spriteWin.isDestroyed() && spriteWin.webContents.send(ch, payload);
const toPanel = (ch, payload) => panelWin && !panelWin.isDestroyed() && panelWin.webContents.send(ch, payload);

// ---------------------------------------------------------------------------
// speech
// ---------------------------------------------------------------------------
/**
 * Synthesise and play a line, resolving when the audio has actually finished.
 * The renderer drives the mouth from the audio amplitude (section 8).
 */
const { splitForSpeech } = require('./speech-split');

async function say(text, { state = 'SPEAKING' } = {}) {
  const line = String(text || '').trim();
  if (!line) return;
  const previous = core.getState();
  core.setState(state);
  core.log({ kind: 'engineer_said', human: line, technical: `tts: ${cfg().voice}` });

  const opts = { voice: cfg().voice, rate: cfg().ttsRate };
  const chunks = splitForSpeech(line);
  const id = ++speechSeq;
  const done = new Promise((resolve) => speechWaiters.set(id, resolve));
  let spoke = false;

  try {
    // Synthesise every piece at once, then hand them over strictly in order:
    // he starts talking as soon as the FIRST piece is ready.
    const jobs = chunks.map((c) => tts.speak(c, opts));
    toSprite('speak-begin', { id, total: chunks.length, caption: chunks[0], captions: chunks });
    for (let i = 0; i < jobs.length; i++) {
      let audio = null;
      try { audio = (await jobs[i]).audio; } catch (e) {
        core.log({ kind: 'error', level: 'warn', human: null, technical: `TTS chunk ${i + 1}/${chunks.length} failed: ${e.message}` });
      }
      if (audio && audio.length) spoke = true;
      toSprite('speak-chunk', { id, seq: i, audio: audio && audio.length ? audio.toString('base64') : null });
    }
  } catch (e) {
    core.log({ kind: 'error', level: 'error', human: "I couldn't speak just then, so here it is in writing.", technical: `TTS failed: ${e.message}` });
  }

  if (spoke) {
    await done;
  } else {
    // Section 32: he still "says" it — on screen — and the log records why.
    speechWaiters.delete(id);
    toSprite('caption', { text: line, sticky: true });
    await new Promise((r) => setTimeout(r, Math.min(6000, 400 + line.length * 45)));
  }
  if (core.getState() === state) core.setState(previous === 'SPEAKING' ? 'IDLE' : previous);
}

function stopSpeaking() {
  toSprite('stop-audio', {});
  for (const [id, resolve] of speechWaiters) { resolve(); speechWaiters.delete(id); }
}

// ---------------------------------------------------------------------------
// startup sequence (section 23)
// ---------------------------------------------------------------------------
async function startupSequence() {
  core.setState('ENTERING');
  warmUp();   // the entrance animation is free time; spend it on slow starts
  core.log({ kind: 'info', human: 'Your engineer is arriving.', technical: `assets: ${ASSETS}` });
}

async function afterEntrance() {
  core.setState('IDLE');
  const dir = cfg().projectDir;
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* reported on use */ }
  core.log({ kind: 'info', human: `Ready. Working folder: ${dir}`, technical: `projectDir=${dir} permissionMode=${cfg().permissionMode}` });
  await say("Hi, I'm your engineer. Tell me what you'd like me to build.");
  core.setState('LISTENING');
  toSprite('listen', { on: true });
}

// ---------------------------------------------------------------------------
// conversation -> handoff -> build
// ---------------------------------------------------------------------------
/**
 * Keep an interview process warm and waiting. Spawning one costs ~8s and a warm
 * turn costs ~2.5s, so it is created while the engineer is still walking in and
 * re-created as soon as the previous one is handed off (measured).
 */
function ensureInterview() {
  if (!interview) interview = new Interview(lastPacket ? lastPacket.spec : null).warm();
  return interview;
}

/** Spend the entrance animation getting everything that is slow ready. */
function warmUp() {
  try { llm.utility().start(); } catch { /* narration falls back to a cold call */ }
  ensureInterview();
  // The first Edge TTS call pays for DNS and the TLS handshake; burn that now.
  tts.speak('ok').catch(() => {});
}

/**
 * Does this utterance address him?
 *
 * The microphone is open in a room, and a conversation about lunch should not
 * start a build. Once he is engaged the wake word is dropped — making someone
 * say a name before every sentence of a conversation they are already having
 * is the thing that makes voice assistants tiring.
 */
function addressedToHim(said) {
  const wake = String(cfg().wakeWord || '').trim().toLowerCase();
  if (!wake) return true;                       // wake word disabled in settings
  if (!engaged) return said.toLowerCase().includes(wake);
  return true;
}

async function handleUserSpeech(text) {
  const said = String(text || '').trim();
  if (!said) return;

  if (!addressedToHim(said)) {
    core.log({ kind: 'ignored', human: null, technical: `not addressed to him (no wake word): ${said.slice(0, 80)}` });
    return;
  }
  engaged = true;
  core.log({ kind: 'user_said', human: said, technical: 'stt' });

  // A pending phone question takes priority: this utterance is the answer.
  const waiting = core.pendingDecisions();
  if (core.getState() === 'ON_CALL' && waiting.length) {
    answerCurrentCall(said);
    return;
  }

  if (build && !build.finished) {
    // Mid-build chatter: acknowledge without derailing the agent.
    await say("I'm still building. I'll let you know the moment I'm done.");
    return;
  }

  toSprite('listen', { on: false });
  core.setState('THINKING');
  ensureInterview();

  let turn;
  try {
    turn = await interview.turn(said);
  } catch (e) {
    core.setState('ERROR');
    core.log({ kind: 'error', level: 'error', human: "I couldn't think that through just now.", technical: e.stack });
    await say("Sorry, something went wrong on my end. Could you say that again?");
    core.setState('LISTENING');
    toSprite('listen', { on: true });
    return;
  }

  // A turn that fell back to "say that again" must not look like a normal turn.
  if (turn.error) {
    core.log({ kind: 'error', level: 'error', human: null, technical: `interviewer turn failed: ${turn.error}` });
  }
  core.log({ kind: 'spec', human: null, technical: `spec: ${JSON.stringify(turn.spec)}` });
  await say(turn.reply, { state: 'SPEAKING' });

  if (turn.done) {
    await startBuild();
  } else {
    core.setState('LISTENING');
    toSprite('listen', { on: true });
  }
}

async function startBuild() {
  core.setState('HANDOFF');
  const dir = cfg().projectDir;
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {
    core.setState('ERROR');
    core.log({ kind: 'error', level: 'error', human: "I can't use that project folder.", technical: e.message });
    await say("I can't write to the project folder. Could you pick a different one in my controls?");
    return;
  }

  const packet = interview.handoff(dir);
  lastPacket = packet;
  interview = null;

  // What the user actually decided is worth keeping past this session — it is
  // the difference between being asked your language preference once and being
  // asked it every time. Only "decisions" are stored: the spec's assumptions
  // and open questions are the model's guesses, not the user's answers.
  memory.rememberPreferences(packet.spec.decisions);
  core.log({
    kind: 'handoff',
    human: `Starting work: ${packet.spec.goal || packet.originalGoal}`,
    technical: `handoff written to ${packet.file || '(not persisted)'}`,
  });

  const gate = narrator.createGate();
  core.setState('WORKING');

  build = coder.run({
    brief: briefFor(packet),
    projectDir: dir,
    permissionMode: cfg().permissionMode,
    onEvent: (ev) => onAgentEvent(ev, gate),
  });
  build.finished = false;

  const facts = await build.promise;
  build.finished = true;
  await finishBuild(packet, facts);
}

/** Every progress event here came from a tool call that really ran. */
function onAgentEvent(ev, gate) {
  const line = narrator.describe(ev);
  core.log({
    kind: ev.kind,
    level: line ? line.level : 'info',
    human: line ? line.human : null,
    technical: ev.technical || ev.command || ev.file || null,
  });

  if (ev.kind === 'running_test') core.setState('TESTING');
  else if (ev.kind === 'error') core.setState('ERROR');
  else if (['writing_file', 'editing_file', 'running_command', 'building', 'installing_dependency', 'reading_file', 'test_passed', 'test_failed'].includes(ev.kind)) {
    if (core.getState() !== 'PHONE_RINGING' && core.getState() !== 'ON_CALL' && core.getState() !== 'WAITING_FOR_USER') {
      core.setState('WORKING');
    }
  }

  if (line && gate(ev, line) && core.getState() !== 'ON_CALL' && core.getState() !== 'PHONE_RINGING') {
    say(line.human).catch(() => {});
  }
}

async function finishBuild(packet, facts) {
  if (facts.outcome === 'interrupted') {
    core.setState('IDLE');
    core.log({ kind: 'interrupted', level: 'warn', human: 'Work stopped.', technical: 'cancelled by user' });
    await say("Okay, I've stopped. Tell me when you want me to carry on.");
    core.setState('LISTENING');
    toSprite('listen', { on: true });
    return;
  }

  // Section 25: only call it complete when the run actually says so.
  const clean = facts.outcome === 'success' && facts.testsFailed === 0;
  core.setState(clean ? 'COMPLETED' : 'ERROR');
  core.log({
    kind: clean ? 'completed' : 'error',
    level: clean ? 'success' : 'error',
    human: null,
    technical: `outcome=${facts.outcome} files=${facts.filesTouched.length} tests=${facts.testsRun} passed=${facts.testsPassed} failed=${facts.testsFailed} errors=${facts.errors}`,
  });

  // Remember the build whether it worked or not: "we tried this and it failed"
  // is more useful next session than silence.
  memory.rememberBuild({
    goal: packet.spec.goal || packet.originalGoal,
    dir: packet.projectDir,
    outcome: facts.outcome,
    files: facts.filesTouched.length,
  });

  const summary = await narrator.summarise({ spec: packet.spec, facts, transcript: facts.finalText });
  core.log({ kind: 'summary', level: clean ? 'success' : 'warn', human: summary, technical: facts.finalText ? facts.finalText.slice(0, 4000) : null });
  await say(summary, { state: 'COMPLETED' });

  core.setState('IDLE');
  // The job is done, so the next thing said to him starts a NEW conversation and
  // has to address him again. Without this the wake word only ever gates the
  // first sentence of the whole session.
  engaged = false;
  await say('If you want anything changed, just tell me.');
  core.setState('LISTENING');
  toSprite('listen', { on: true });
}

// ---------------------------------------------------------------------------
// the telephone (section 17)
// ---------------------------------------------------------------------------
let activeCall = null;

core.bus.on('decision', (decision) => {
  if (activeCall) return;             // one call at a time; the rest queue as pending
  activeCall = decision;
  core.setState('PHONE_RINGING');
  toSprite('ring', { on: true });

  clearTimeout(ringTimer);
  ringTimer = setTimeout(() => {
    // Not answered: never invent the answer, just park it (section 17).
    if (!activeCall) return;
    toSprite('ring', { on: false });
    activeCall = null;
    core.setState('WAITING_FOR_USER');
    core.log({
      kind: 'pending', level: 'warn',
      human: `Still waiting on you: ${decision.question}`,
      technical: `decision #${decision.id} unanswered after ${cfg().ringSeconds}s — parked as pending`,
    });
  }, Math.max(5, cfg().ringSeconds) * 1000);
});

core.bus.on('decision-resolved', () => {
  clearTimeout(ringTimer);
  toSprite('ring', { on: false });
  activeCall = null;
  if (core.pendingDecisions().length === 0 && build && !build.finished) core.setState('WORKING');
});

/** User picked up the phone. */
async function answerCall() {
  const decision = activeCall || core.pendingDecisions()[0];
  if (!decision) return;
  clearTimeout(ringTimer);
  activeCall = decision;
  toSprite('ring', { on: false });
  core.setState('ON_CALL');
  if (build) build.pause();

  const spoken = await narrator.humaniseQuestion(decision.question, decision.options);
  await say(spoken, { state: 'ON_CALL' });
  core.setState('ON_CALL');
  toSprite('listen', { on: true });
}

function answerCurrentCall(answer) {
  const decision = activeCall || core.pendingDecisions()[0];
  if (!decision) return;
  toSprite('listen', { on: false });
  core.answerDecision(decision.id, answer);
  if (build) build.resume();
  say('Got it, thanks.').catch(() => {});
}

// ---------------------------------------------------------------------------
// bus -> windows
// ---------------------------------------------------------------------------
core.bus.on('state', (e) => { toSprite('state', e); toPanel('state', e); });
core.bus.on('log', (e) => toPanel('log', e));

// Section 32: every run leaves a diagnostic trail on disk.
let logStream = null;
function openLogFile() {
  try {
    fs.mkdirSync(config.paths.logs, { recursive: true });
    const file = path.join(config.paths.logs, `session-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
    logStream = fs.createWriteStream(file, { flags: 'a' });
    core.bus.on('log', (e) => {
      if (!logStream) return;
      logStream.write(`${new Date(e.at).toISOString()} [${e.level}] ${e.kind} :: ${e.human || ''}${e.technical ? ` :: ${e.technical}` : ''}\n`);
    });
    core.bus.on('state', (e) => logStream && logStream.write(`${new Date(e.at).toISOString()} [state] ${e.previous} -> ${e.state}\n`));
    return file;
  } catch { return null; }
}
core.bus.on('decision', (d) => toPanel('decision', d));
core.bus.on('decision-resolved', (d) => toPanel('decision-resolved', d));

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.handle('bootstrap', () => ({
  state: core.getState(),
  config: cfg(),
  log: core.history(),
  pending: core.pendingDecisions(),
  assetsPath: ASSETS,
  // fetch() cannot read file:// in a renderer, so the manifest is handed over here
  manifest: readManifest(),
  paths: config.paths,
  // shown on the dial, so which brain is running is visible rather than folklore
  models: { fast: llm.FAST, strong: llm.STRONG },
}));

function readManifest() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ASSETS, 'engineer', 'manifest.json'), 'utf8'));
  } catch (e) {
    core.log({ kind: 'error', level: 'error', human: 'My artwork is missing, so I cannot show myself.', technical: `manifest unreadable: ${e.message}` });
    return { cell: 256, states: {} };
  }
}

ipcMain.on('sprite-ready', () => { startupSequence(); selfTest(); });

/**
 * Test seam (section 33): ENGINEER_SCRIPT is a JSON array of things "the user
 * said", fed in whenever he starts listening. It drives the whole flow —
 * conversation, handoff, build, summary — without a microphone.
 */
function scriptedInput() {
  const raw = process.env.ENGINEER_SCRIPT;
  if (!raw) return;
  let lines;
  try { lines = JSON.parse(raw); } catch { return; }
  let i = 0;
  core.bus.on('state', ({ state }) => {
    if (state !== 'LISTENING' || i >= lines.length) return;
    const text = lines[i++];
    setTimeout(() => { core.log({ kind: 'scripted', human: null, technical: `scripted input: ${text}` }); handleUserSpeech(text); }, 900);
  });
}

/**
 * Test seam (section 33). A GDI screen grab cannot see a Chromium transparent
 * window — it is composited through DirectComposition — so the only way to
 * check the overlay really is see-through is to capture the page with its alpha
 * channel intact. ENGINEER_SELF_TEST=<png path> writes that capture and exits.
 */
function selfTest() {
  const out = process.env.ENGINEER_SELF_TEST;
  if (!out || !spriteWin) return;
  setTimeout(async () => {
    try {
      const img = await spriteWin.webContents.capturePage();
      fs.writeFileSync(out, img.toPNG());
      const b = spriteWin.getBounds();
      const area = screen.getPrimaryDisplay().workArea;
      fs.writeFileSync(`${out}.json`, JSON.stringify({ bounds: b, workArea: area, state: core.getState() }));
      core.log({ kind: 'selftest', human: null, technical: `self test capture written to ${out}` });
    } catch (e) {
      core.log({ kind: 'error', level: 'error', human: null, technical: `self test failed: ${e.message}` });
    } finally {
      app.exit(0);
    }
  }, Number(process.env.ENGINEER_SELF_TEST_DELAY) || 6000);
}
ipcMain.on('entrance-done', () => { afterEntrance(); });
ipcMain.on('speech-ended', (_e, { id }) => {
  const resolve = speechWaiters.get(id);
  if (resolve) { speechWaiters.delete(id); resolve(); }
});
ipcMain.on('barge-in', () => {
  if (core.getState() !== 'SPEAKING') return;
  core.log({ kind: 'barge_in', human: null, technical: 'user spoke over him; stopping' });
  stopSpeaking();
});
ipcMain.on('user-said', (_e, { text }) => { handleUserSpeech(text); });
ipcMain.on('toggle-panel', () => {
  if (panelWin && panelWin.isVisible()) panelWin.hide();
  else createPanel(true);
});
ipcMain.on('stt-status', (_e, s) => {
  core.log({ kind: 'stt', level: s.level || 'info', human: s.human || null, technical: s.technical || null });
});

ipcMain.on('answer-decision', (_e, { id, answer }) => {
  const ok = core.answerDecision(id, answer);
  if (ok && build) build.resume();
  if (activeCall && activeCall.id === id) { activeCall = null; toSprite('ring', { on: false }); }
});
ipcMain.on('answer-call', () => { answerCall(); });
ipcMain.on('say', (_e, { text }) => { handleUserSpeech(text); });

ipcMain.on('control', (_e, { action }) => {
  switch (action) {
    case 'stop-speaking': stopSpeaking(); break;
    case 'pause':
      if (build && !build.finished) { build.pause(); core.log({ kind: 'paused', level: 'warn', human: 'Paused. He will stop at the next safe point.', technical: 'agent paused' }); }
      break;
    case 'resume':
      if (build && !build.finished) { build.resume(); core.log({ kind: 'resumed', human: 'Carrying on.', technical: 'agent resumed' }); }
      break;
    case 'cancel':
      stopSpeaking();
      if (build && !build.finished) { build.resume(); build.cancel(); }
      else { interview = null; core.setState('IDLE'); }
      break;
    default: break;
  }
});

ipcMain.handle('set-config', (_e, patch) => {
  const next = config.save(patch);
  toSprite('config', next);
  toPanel('config', next);
  core.log({ kind: 'config', human: null, technical: `config: ${JSON.stringify({ ...patch, apiKey: patch.apiKey ? '***' : undefined })}` });
  return next;
});

ipcMain.handle('pick-dir', async () => {
  const win = panelWin || spriteWin;
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], title: 'Choose the folder the engineer may work in' });
  if (r.canceled || !r.filePaths[0]) return null;
  const next = config.save({ projectDir: r.filePaths[0] });
  toPanel('config', next);
  core.log({ kind: 'config', human: `Project folder set to ${r.filePaths[0]}`, technical: `projectDir=${r.filePaths[0]}` });
  return next.projectDir;
});

ipcMain.handle('list-voices', async () => {
  try { return await tts.listVoices(); }
  catch (e) { core.log({ kind: 'error', level: 'warn', human: null, technical: `voice list failed: ${e.message}` }); return []; }
});

ipcMain.on('open-path', (_e, { which }) => {
  const target = which === 'project' ? cfg().projectDir : config.paths.dir;
  shell.openPath(target).catch(() => {});
});

ipcMain.on('quit', () => app.quit());

// ---------------------------------------------------------------------------
// tray — the only chrome, because a frameless overlay needs a way to quit
// ---------------------------------------------------------------------------
function createTray() {
  const icon = nativeImage.createFromPath(path.join(ASSETS, 'engineer', 'canonical', '000.png')).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('Engineer');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Controls & log', click: () => createPanel(true) },
    { label: 'Open project folder', click: () => shell.openPath(cfg().projectDir) },
    { type: 'separator' },
    { label: 'Stop talking', click: () => stopSpeaking() },
    { label: 'Cancel current task', click: () => { if (build && !build.finished) { build.resume(); build.cancel(); } } },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
  tray.on('click', () => createPanel(true));
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) app.quit();

app.whenReady().then(() => {
  const logFile = openLogFile();
  core.log({ kind: 'boot', human: null, technical: `engineer-agent starting — electron ${process.versions.electron}, log ${logFile}` });

  // skipTaskbar has no effect on macOS, so without this the engineer gets a
  // Dock icon and an app menu — a whole application around a character who is
  // supposed to be the only thing on screen. Hiding the Dock icon also makes
  // this an accessory app, which is what an overlay should be.
  if (process.platform === 'darwin') app.dock?.hide();

  for (const issue of llm.preflight()) {
    core.log({
      kind: 'error', level: 'error',
      human: 'A Claude Code settings file on this machine is damaged, so I will not be able to build anything until it is fixed or you add an API key in my settings.',
      technical: `malformed JSON in ${issue.file} (${issue.bytes} bytes): ${issue.error}`,
    });
  }
  scriptedInput();
  createSprite();
  createPanel(false);
  createTray();

  screen.on('display-metrics-changed', () => spriteWin && spriteWin.setBounds(spriteBounds()));

  process.on('uncaughtException', (e) => {
    core.setState('ERROR');
    core.log({ kind: 'error', level: 'error', human: 'Something went wrong inside the app.', technical: e.stack || String(e) });
  });
  process.on('unhandledRejection', (e) => {
    core.log({ kind: 'error', level: 'error', human: null, technical: `unhandled: ${(e && e.stack) || e}` });
  });
});

app.on('window-all-closed', (e) => { e.preventDefault(); });  // tray keeps it alive
app.on('before-quit', () => { if (build && !build.finished) { build.resume(); build.cancel(); } });
