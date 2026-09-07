/**
 * Configuration: a single JSON file in the per-user application data directory
 * — %APPDATA%\engineer-agent\ on Windows, ~/Library/Application Support/
 * engineer-agent/ on macOS.
 *
 * Secrets are never committed and never hard-coded. ANTHROPIC_API_KEY from the
 * environment always wins over the stored value, so you can run the app without
 * ever writing a key to disk.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Where Electron would put userData, worked out without importing Electron:
 * the test suite requires this module under plain node, so `app.getPath` is not
 * available here. These are the same locations Electron itself uses.
 */
function appDataRoot(platform = process.platform) {
  if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
  if (platform === 'win32') return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

/**
 * Where large regenerable files belong — a cache, not settings.
 *
 * Separate from appDataRoot because on Windows that is the ROAMING profile, and
 * a 322 MB binary does not belong in something that may follow a user between
 * machines.
 */
function cacheRoot(platform = process.platform) {
  if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches');
  if (platform === 'win32') return process.env.LOCALAPPDATA || appDataRoot(platform);
  return process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
}

const DIR = path.join(appDataRoot(), 'engineer-agent');
const CACHE = path.join(cacheRoot(), 'engineer-agent');
const FILE = path.join(DIR, 'config.json');

const DEFAULTS = {
  // 'ask' | 'standard' | 'autonomous'  (section 16)
  permissionMode: 'standard',
  projectDir: path.join(os.homedir(), 'EngineerProjects'),
  voice: 'en-US-AndrewNeural',
  ttsRate: '+6%',
  micDeviceId: '',
  // Said while he is idle, this is how you get his attention. Once he is in a
  // conversation it is not needed again. Empty string disables the gate.
  wakeWord: 'engineer',
  sttModel: 'onnx-community/moonshine-base-ONNX',
  // how long the telephone rings before the question becomes a pending decision
  ringSeconds: 25,
  spriteScale: 1,
  apiKey: '',
};

/**
 * Settings that were the default once and have since been superseded. A stored
 * value only ever came from us, so carrying it forward would quietly keep an
 * existing user on the old behaviour — here, a speech model seven times slower
 * than the current one.
 */
const SUPERSEDED = {
  sttModel: ['Xenova/whisper-base.en', 'Xenova/whisper-small.en'],
};

let cache = null;

function load() {
  if (cache) return cache;
  let stored = {};
  try { stored = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { /* first run */ }

  for (const [key, old] of Object.entries(SUPERSEDED)) {
    if (old.includes(stored[key])) delete stored[key];
  }
  cache = { ...DEFAULTS, ...stored };
  return cache;
}

function save(patch) {
  cache = { ...load(), ...patch };
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(cache, null, 2));
  return cache;
}

/** Environment beats stored config, so a key never has to be written to disk. */
const apiKey = () => process.env.ANTHROPIC_API_KEY || load().apiKey || '';

const paths = { dir: DIR, file: FILE, handoffs: path.join(DIR, 'handoffs'), logs: path.join(DIR, 'logs'), cache: CACHE };

module.exports = { load, save, apiKey, paths, appDataRoot, cacheRoot, DEFAULTS };
