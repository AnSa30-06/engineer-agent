/**
 * Configuration: a single JSON file under %APPDATA%\engineer-agent\.
 *
 * Secrets are never committed and never hard-coded. ANTHROPIC_API_KEY from the
 * environment always wins over the stored value, so you can run the app without
 * ever writing a key to disk.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const DIR = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'engineer-agent');
const FILE = path.join(DIR, 'config.json');

const DEFAULTS = {
  // 'ask' | 'standard' | 'autonomous'  (section 16)
  permissionMode: 'standard',
  projectDir: path.join(os.homedir(), 'EngineerProjects'),
  voice: 'en-US-AndrewNeural',
  ttsRate: '+6%',
  micDeviceId: '',
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

const paths = { dir: DIR, file: FILE, handoffs: path.join(DIR, 'handoffs'), logs: path.join(DIR, 'logs') };

module.exports = { load, save, apiKey, paths, DEFAULTS };
