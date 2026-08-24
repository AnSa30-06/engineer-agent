/**
 * Live test of the real coding agent (sections 15, 16, 17, 18, 36).
 *
 * This is not a simulation: it hands the agent a brief in a scratch directory
 * and checks that files really appear, a command really runs, tests really pass,
 * and that the progress events we surface match what actually happened.
 *
 *   node tests/agent-live.js
 *
 * Needs a working Claude credential (an ANTHROPIC_API_KEY, or an existing
 * Claude Code login on this machine).
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const coder = require('../src/main/coder');
const core = require('../src/main/core');
const narrator = require('../src/main/narrator');
const { briefFor, EMPTY_SPEC } = require('../src/main/interviewer');

const DIR = path.join(os.tmpdir(), `engineer-live-${Date.now()}`);
fs.mkdirSync(DIR, { recursive: true });

const packet = {
  originalGoal: 'build me a little tip calculator I can run from the command line',
  projectDir: DIR,
  spec: {
    ...EMPTY_SPEC,
    goal: 'A small command-line tip calculator',
    platform: 'Node.js on Windows',
    requirements: [
      'a file tip.js that exports a function calculateTip(bill, percent) returning the tip amount rounded to 2 decimals',
      'running `node tip.js 50 20` prints the tip and the total',
      'a test file that checks the calculation, runnable with `node test.js`',
    ],
    decisions: ['plain Node, no dependencies'],
    acceptanceCriteria: [
      'node test.js runs and reports all checks passing',
      'node tip.js 50 20 prints a tip of 10',
    ],
  },
};

const events = [];
const seen = new Set();
const gate = narrator.createGate(0);
const narrated = [];

core.bus.on('log', () => {});

console.log(`project directory: ${DIR}`);
console.log(`brief:\n${briefFor(packet).split('\n').slice(0, 6).join('\n')}\n…\n`);

const started = Date.now();
const build = coder.run({
  brief: briefFor(packet),
  projectDir: DIR,
  permissionMode: 'autonomous',
  onEvent: (ev) => {
    events.push(ev);
    seen.add(ev.kind);
    const line = narrator.describe(ev);
    if (line && gate(ev, line)) narrated.push(line.human);
    const detail = ev.command || ev.file || '';
    console.log(`  [${String(Math.round((Date.now() - started) / 1000)).padStart(3)}s] ${ev.kind.padEnd(22)} ${String(detail).slice(0, 70)}`);
  },
});

const timeout = setTimeout(() => {
  console.log('\ntimed out after 15 minutes — cancelling');
  build.cancel();
}, 900000);

build.promise.then(async (facts) => {
  clearTimeout(timeout);
  console.log('\n--- what the agent actually did ---');
  console.log(`outcome        ${facts.outcome}`);
  console.log(`files touched  ${facts.filesTouched.length}`);
  console.log(`tests run      ${facts.testsRun} (passed ${facts.testsPassed}, failed ${facts.testsFailed})`);
  console.log(`errors seen    ${facts.errors}`);

  const onDisk = fs.existsSync(DIR) ? fs.readdirSync(DIR) : [];
  console.log(`on disk        ${onDisk.join(', ') || '(nothing)'}`);

  console.log('\n--- what the user would have heard ---');
  for (const n of narrated.slice(0, 12)) console.log(`  "${n}"`);

  // Independently verify the acceptance criteria rather than trusting the agent.
  const { execFileSync } = require('child_process');
  const runNode = (args) => {
    try {
      return { ok: true, out: execFileSync(process.execPath, args, { cwd: DIR, encoding: 'utf8', timeout: 60000 }) };
    } catch (e) {
      return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}` };
    }
  };

  const checks = [];
  checks.push(['agent finished successfully', facts.outcome === 'success']);
  checks.push(['it created real files', onDisk.length > 0]);
  checks.push(['tip.js exists', fs.existsSync(path.join(DIR, 'tip.js'))]);
  checks.push(['progress events reflect real work', seen.has('writing_file') || seen.has('editing_file')]);
  checks.push(['it ran commands itself', seen.has('running_command') || seen.has('running_test') || seen.has('building')]);
  checks.push(['narration stayed non-technical', narrated.every((n) => !/\.js\b|npm |node |src\//.test(n))]);

  if (fs.existsSync(path.join(DIR, 'tip.js'))) {
    const r = runNode(['tip.js', '50', '20']);
    console.log(`\n$ node tip.js 50 20\n${r.out.trim().slice(0, 400)}`);
    checks.push(['`node tip.js 50 20` runs and mentions a tip of 10', r.ok && /\b10(\.00?)?\b/.test(r.out)]);
  }
  const testFile = onDisk.find((f) => /^test.*\.js$/i.test(f));
  if (testFile) {
    const r = runNode([testFile]);
    console.log(`\n$ node ${testFile}\n${r.out.trim().slice(0, 500)}`);
    checks.push([`\`node ${testFile}\` passes`, r.ok]);
  }

  console.log('\n--- verification ---');
  let failed = 0;
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) failed++;
  }
  console.log(`\n${failed ? 'FAIL' : 'PASS'}: live coding agent (${DIR})`);
  process.exit(failed ? 1 : 0);
}).catch((e) => {
  clearTimeout(timeout);
  console.log(`\nFAIL: ${e.stack || e.message}`);
  process.exit(1);
});
