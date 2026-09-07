/**
 * "What is wrong with me?" — the checks, in one place.
 *
 * Every check here exists because the thing it looks for actually went wrong
 * and cost time to diagnose: a malformed plugin config that surfaced only as
 * "exited with code 1", a 322 MB agent binary on a slow drive that made every
 * turn take half a minute, a full system drive that made the app exit silently,
 * a speech model that had not finished loading while the user was already
 * talking.
 *
 * Two rules for anything added here:
 *   1. A finding must say what to DO about it, not only that it is wrong.
 *   2. Never report "ok" for something that was not actually measured. A check
 *      that cannot run reports `unknown`, which is not the same as passing.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('./config');
const llm = require('./llm');

/** Above this, a spawn is slow enough that the user will feel it every turn. */
const SLOW_SPAWN_MS = 5000;
const DISK_WARN_GB = 5;
const DISK_FAIL_GB = 1.5;

const finding = (name, status, detail, fix = null) => ({ name, status, detail, fix });

// --- graders, kept pure so they can be tested without the machine ------------

function gradeDisk(freeBytes, drive) {
  if (!Number.isFinite(freeBytes)) return finding('Disk space', 'unknown', `could not read free space on ${drive}`);
  const gb = freeBytes / 1024 ** 3;
  const detail = `${gb.toFixed(1)} GB free on ${drive}`;
  if (gb < DISK_FAIL_GB) {
    return finding('Disk space', 'fail', detail,
      'Free up space. Below about 2 GB this app fails to start at all, silently.');
  }
  if (gb < DISK_WARN_GB) {
    return finding('Disk space', 'warn', detail,
      'Getting tight. The agent and the speech model both need room to work.');
  }
  return finding('Disk space', 'ok', detail);
}

function gradeBinary(cliPath, ms, cacheRoot) {
  if (!cliPath) {
    return finding('Agent program', 'unknown', 'the SDK is resolving its own copy',
      'Normal. Only a problem if he cannot start at all.');
  }
  const local = path.parse(cliPath).root.toLowerCase() === path.parse(cacheRoot).root.toLowerCase();
  const where = local ? 'on your system drive' : `on ${path.parse(cliPath).root}`;
  const timing = Number.isFinite(ms) ? `, starts in ${(ms / 1000).toFixed(1)}s` : '';
  if (Number.isFinite(ms) && ms > SLOW_SPAWN_MS) {
    return finding('Agent program', 'warn', `${where}${timing}`,
      local
        ? 'Slower than expected. Antivirus scanning the program on every run is the usual cause.'
        : 'Running from another drive is slow. He keeps a local copy — if this persists, move the app to your system drive.');
  }
  return finding('Agent program', 'ok', `${where}${timing}`);
}

// --- the checks --------------------------------------------------------------

function credentialCheck() {
  if (config.apiKey()) return finding('Claude credential', 'ok', 'using an API key');
  const home = path.join(os.homedir(), '.claude');
  if (fs.existsSync(home)) return finding('Claude credential', 'ok', 'using the Claude Code login on this machine');
  return finding('Claude credential', 'fail', 'no API key and no Claude Code login found',
    'Paste an Anthropic API key in Settings, or sign in to Claude Code on this machine. He cannot think without one.');
}

function configFilesCheck() {
  const issues = llm.preflight();
  if (!issues.length) return finding('Agent configuration', 'ok', 'the files he inherits are readable');
  return finding('Agent configuration', 'fail',
    issues.map((i) => `${path.basename(i.file)}: ${i.error}`).join(' · '),
    'One of Claude Code\'s own files is corrupt. Repair or delete the file named above — he cannot start while it is malformed.');
}

function projectFolderCheck() {
  const dir = config.load().projectDir;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.engineer-write-test-${Date.now()}`);
    fs.writeFileSync(probe, 'x');
    fs.rmSync(probe, { force: true });
    return finding('Project folder', 'ok', dir);
  } catch (e) {
    return finding('Project folder', 'fail', `${dir} — ${e.message}`,
      'He writes everything here and can touch nothing else. Choose a folder you can write to, in Settings.');
  }
}

function assetsCheck() {
  const manifest = path.join(__dirname, '..', '..', 'assets', 'engineer', 'manifest.json');
  try {
    const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    const states = Object.keys(m.states || {}).length;
    if (!states) throw new Error('no states listed');
    return finding('Artwork', 'ok', `${states} animations loaded`);
  } catch (e) {
    return finding('Artwork', 'fail', e.message,
      'His drawings are missing. Run `npm run sprites`, or reinstall.');
  }
}

/** The renderer owns the microphone and the model, so it reports in. */
function speechCheck(speech) {
  if (!speech || !speech.model) {
    return finding('Speech recognition', 'unknown', 'nothing reported yet this session',
      'It reports once he starts listening. Type to him in the meantime.');
  }
  if (speech.error) {
    return finding('Speech recognition', 'fail', speech.error,
      'He cannot hear you. You can still type to him in the box below.');
  }
  if (!speech.ready) {
    return finding('Speech recognition', 'warn', `${speech.model} is still loading`,
      'The first thing you say is written down once it finishes. It is instant after that, and cached next launch.');
  }
  return finding('Speech recognition', 'ok', `${speech.model} ready`);
}

function versionsCheck() {
  let sdk = 'unknown';
  try {
    // The SDK's "exports" map does not expose ./package.json, so requiring it
    // throws ERR_PACKAGE_PATH_NOT_EXPORTED. Read the file beside the entry point.
    const dir = path.dirname(require.resolve('@anthropic-ai/claude-agent-sdk'));
    sdk = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
  } catch { /* not resolvable */ }
  return finding('Versions', 'ok',
    `electron ${process.versions.electron || 'n/a'} · node ${process.versions.node} · agent sdk ${sdk}`);
}

/** How long the agent program takes to answer. Capped — a hang must not hang us. */
function timeBinary(cliPath) {
  if (!cliPath) return null;
  const t = Date.now();
  try {
    require('child_process').execFileSync(cliPath, ['--version'],
      { timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] });
    return Date.now() - t;
  } catch {
    return null;
  }
}

function freeSpace(dir) {
  try {
    // statfsSync landed in Node 18.15; older runtimes simply report unknown.
    const s = fs.statfsSync(dir);
    return s.bavail * s.bsize;
  } catch { return NaN; }
}

/**
 * Run everything. `speech` is whatever the renderer last told us about the
 * microphone and the model — main.js keeps it.
 */
function run({ speech } = {}) {
  const cacheRoot = config.paths.cache;
  const cli = llm.runtime().pathToClaudeCodeExecutable || null;
  const drive = path.parse(cacheRoot).root || cacheRoot;

  return [
    credentialCheck(),
    configFilesCheck(),
    gradeBinary(cli, timeBinary(cli), cacheRoot),
    gradeDisk(freeSpace(cacheRoot), drive),
    projectFolderCheck(),
    speechCheck(speech),
    assetsCheck(),
    versionsCheck(),
  ];
}

module.exports = { run, gradeDisk, gradeBinary, speechCheck, SLOW_SPAWN_MS, DISK_WARN_GB, DISK_FAIL_GB };
