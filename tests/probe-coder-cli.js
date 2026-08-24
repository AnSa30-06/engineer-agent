/**
 * Does the coding agent survive a real tool-using task on each available CLI?
 * A trivial no-tool call passes on both, so this exercises the path that fails.
 *
 *   node tests/probe-coder-cli.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

async function trial(label, cli) {
  // resolveCli caches, and config/llm are required at module load, so each
  // trial runs in a fresh child process with the override set.
  const { execFileSync } = require('child_process');
  const dir = path.join(os.tmpdir(), `engineer-cli-${label}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  const script = `
    const coder = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'main', 'coder.js'))});
    const core  = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'main', 'core.js'))});
    core.bus.on('log', (e) => { if (e.kind === 'agent_stderr') console.log('STDERR:', e.technical.slice(0,200)); });
    const events = [];
    const b = coder.run({
      brief: 'Create a file called hello.txt containing exactly HELLO. Then read it back to confirm. Nothing else.',
      projectDir: ${JSON.stringify(dir)},
      permissionMode: 'autonomous',
      onEvent: (ev) => events.push(ev.kind),
    });
    b.promise.then((f) => {
      console.log(JSON.stringify({ outcome: f.outcome, errors: f.errors, files: f.filesTouched.length, cmds: f.commandsRun, events }));
      process.exit(0);
    });
  `;
  const t0 = Date.now();
  let out;
  try {
    out = execFileSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      timeout: 300000,
      env: { ...process.env, ENGINEER_CLAUDE_CLI: cli },
    });
  } catch (e) {
    out = `${e.stdout || ''}${e.stderr || ''}`;
  }
  const line = out.split('\n').filter((l) => l.trim().startsWith('{')).pop();
  const stderr = out.split('\n').filter((l) => l.startsWith('STDERR:')).slice(0, 2);
  const made = fs.existsSync(path.join(dir, 'hello.txt'));
  console.log(`\n${label}  (${Math.round((Date.now() - t0) / 1000)}s)`);
  console.log(`  result: ${line || '(no result) ' + out.slice(-300).replace(/\s+/g, ' ')}`);
  console.log(`  hello.txt created: ${made}`);
  for (const s of stderr) console.log(`  ${s.slice(0, 200)}`);
}

(async () => {
  const bundled = require('../src/main/llm.js').runtime().pathToClaudeCodeExecutable;
  await trial('bundled', bundled);
  await trial('system', 'system');
})();
