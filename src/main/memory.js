/**
 * What he remembers between sessions.
 *
 * Until now he forgot everything the moment the app closed: what he built, where
 * he put it, and every preference you had already told him. Across the "build
 * your own Jarvis" corpus this is the single most repeated requirement — the
 * one thing every version of the idea promises — and it was the clearest real
 * gap in ours.
 *
 * Deliberately small. It is a short list of finished builds and a short list of
 * settled preferences, not a transcript archive and not a vector store: it has
 * to fit in a prompt on every turn, so growth is capped rather than trimmed
 * later.
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');

// ENGINEER_MEMORY_FILE is a test seam: the suite must never read or write the
// real memory, and a test that did would also be order-dependent.
const FILE = process.env.ENGINEER_MEMORY_FILE || path.join(config.paths.dir, 'memory.json');

const MAX_BUILDS = 12;        // keeps the prompt small; oldest fall off first
const MAX_PREFERENCES = 20;
const MAX_TEXT = 300;         // one remembered line is a sentence, not an essay

const EMPTY = { version: 1, builds: [], preferences: [] };

let cache = null;

const str = (v) => (typeof v === 'string' ? v.trim().slice(0, MAX_TEXT) : '');

/** Anything on disk is data we wrote, but a hand-edited file must not crash him. */
function normalise(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const builds = (Array.isArray(o.builds) ? o.builds : [])
    .map((b) => ({
      goal: str(b && b.goal),
      dir: str(b && b.dir),
      outcome: str(b && b.outcome) || 'unknown',
      files: Number.isFinite(b && b.files) ? b.files : 0,
      at: str(b && b.at),
    }))
    .filter((b) => b.goal)
    .slice(-MAX_BUILDS);
  const preferences = (Array.isArray(o.preferences) ? o.preferences : [])
    .map(str)
    .filter(Boolean)
    .slice(-MAX_PREFERENCES);
  return { version: 1, builds, preferences };
}

function load() {
  if (cache) return cache;
  try { cache = normalise(JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch { cache = { ...EMPTY }; }
  return cache;
}

function save(next) {
  cache = normalise(next);
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(cache, null, 2));
  } catch { /* a read-only disk must not stop him working */ }
  return cache;
}

/** Record a finished build. Called when the agent stops, success or not. */
function rememberBuild({ goal, dir, outcome, files }) {
  const m = load();
  const builds = [...m.builds, {
    goal: str(goal),
    dir: str(dir),
    outcome: str(outcome) || 'unknown',
    files: Number.isFinite(files) ? files : 0,
    at: new Date().toISOString().slice(0, 10),
  }].filter((b) => b.goal).slice(-MAX_BUILDS);
  return save({ ...m, builds });
}

/**
 * Record something the user settled, so he stops asking it again. Deduped
 * case-insensitively — the interviewer will happily re-derive the same
 * preference every session otherwise, and twelve copies of "prefers Python"
 * would crowd out everything else.
 */
function rememberPreferences(lines) {
  const m = load();
  const seen = new Set(m.preferences.map((p) => p.toLowerCase()));
  const preferences = [...m.preferences];
  for (const line of Array.isArray(lines) ? lines : []) {
    const clean = str(line);
    if (!clean || seen.has(clean.toLowerCase())) continue;
    seen.add(clean.toLowerCase());
    preferences.push(clean);
  }
  return save({ ...m, preferences: preferences.slice(-MAX_PREFERENCES) });
}

/**
 * What the interviewer is told at the start of a conversation. Empty string on
 * a first run, so a new user's prompt carries no dead scaffolding.
 */
function brief() {
  const m = load();
  const parts = [];
  if (m.builds.length) {
    const recent = m.builds.slice(-5).reverse()
      .map((b) => `- ${b.goal} (${b.outcome}${b.files ? `, ${b.files} file${b.files === 1 ? '' : 's'}` : ''}, ${b.at})`);
    parts.push(`Things you have already built for this person:\n${recent.join('\n')}`);
  }
  if (m.preferences.length) {
    parts.push(`What they have already told you — do NOT ask about these again:\n${m.preferences.map((p) => `- ${p}`).join('\n')}`);
  }
  return parts.join('\n\n');
}

/** Test seam: drop the in-process copy so a fresh read hits disk. */
function reset() { cache = null; }

module.exports = { load, save, rememberBuild, rememberPreferences, brief, reset, FILE, MAX_BUILDS, MAX_PREFERENCES };
