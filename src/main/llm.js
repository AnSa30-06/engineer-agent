/**
 * Thin wrapper over the Claude Agent SDK for plain, tool-less model calls
 * (the interviewer and the narrator). The real coding agent lives in coder.js
 * and uses the same runtime settings from here.
 */
const path = require('path');
const { query } = require('@anthropic-ai/claude-agent-sdk');
const config = require('./config');

const FAST = 'claude-haiku-4-5-20251001'; // interviewer + narrator
const STRONG = 'claude-sonnet-5';         // the coding agent

/**
 * Electron's process.execPath is the app binary, not node. ELECTRON_RUN_AS_NODE
 * makes it behave as node so the SDK can spawn its bundled CLI from inside the
 * packaged .exe — no separate Node or Claude Code install on the user's machine.
 */
function runtime() {
  const env = { ...process.env };
  const key = config.apiKey();
  env.CLAUDE_CODE_ENTRYPOINT = 'engineer-agent';

  if (key) {
    // Self-contained: our own key, our own config directory. This is the path a
    // packaged build takes on a machine that has never seen Claude Code, and it
    // also isolates us from a broken plugin config in the user's profile.
    env.ANTHROPIC_API_KEY = key;
    const dir = path.join(config.paths.dir, 'claude');
    try { require('fs').mkdirSync(dir, { recursive: true }); } catch { /* fall back to default */ }
    env.CLAUDE_CONFIG_DIR = dir;
  }
  // Otherwise inherit the machine's existing Claude Code login (no key needed).

  const opts = { env };
  if (process.versions.electron) {
    env.ELECTRON_RUN_AS_NODE = '1';
    opts.executable = process.execPath;
    opts.executableArgs = [];
  }
  const cli = resolveCli();
  if (cli) opts.pathToClaudeCodeExecutable = cli;
  return opts;
}

let cliChoice;
/**
 * Which agent CLI to run.
 *
 * Normally: none of our business — the SDK carries and resolves its own, which
 * is why the packaged app needs neither Node nor Claude Code installed.
 *
 * The exception: when we inherit the machine's Claude Code login we also
 * inherit its config, and a malformed file there stops the SDK's CLI from
 * starting at all. An installed `claude` of a different version may tolerate
 * it, so we fall back to that rather than fail on damage we did not cause.
 *
 * ENGINEER_CLAUDE_CLI overrides both ('system', or a path) for diagnosis.
 */
function resolveCli() {
  if (cliChoice !== undefined) return cliChoice;
  if (process.env.ENGINEER_CLAUDE_CLI) {
    cliChoice = process.env.ENGINEER_CLAUDE_CLI === 'system' ? systemClaude() : process.env.ENGINEER_CLAUDE_CLI;
    return cliChoice;
  }
  cliChoice = (preflight().length && systemClaude()) || nativeCli();
  return cliChoice;
}

/**
 * The SDK ships its CLI as a native binary in a per-platform package and finds
 * it with existsSync. That check passes for a path inside app.asar, but an
 * archived file has no real path for the OS to execute, so the spawn then fails
 * with "exists but failed to launch". electron-builder keeps a real copy under
 * app.asar.unpacked (see asarUnpack); this points the SDK at that one.
 *
 * Returns null when there is nothing to correct — in development the SDK
 * resolves the same binary by itself.
 */
function nativeCli() {
  const fs = require('fs');
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const rel = path.join('@anthropic-ai', `claude-agent-sdk-${process.platform}-${process.arch}`, exe);
  let sdkDir;
  try { sdkDir = path.dirname(require.resolve('@anthropic-ai/claude-agent-sdk')); } catch { return null; }

  const ARCHIVE = `app.asar${path.sep}`;
  for (const root of [path.join(sdkDir, 'node_modules'), path.join(sdkDir, '..', '..')]) {
    const p = path.join(root.replace(ARCHIVE, `app.asar.unpacked${path.sep}`), rel);
    if (!p.includes(ARCHIVE) && fs.existsSync(p)) return p;
  }
  return null;
}

function systemClaude() {
  try {
    const out = require('child_process').execSync(process.platform === 'win32' ? 'where claude' : 'which claude', {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    const p = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    return p && require('fs').existsSync(p) ? p : null;
  } catch { return null; }
}

/**
 * Cheap startup check. When we inherit the machine's Claude Code login we also
 * inherit its config files, and the agent CLI refuses to start if any of them
 * is malformed — which surfaces as an opaque "exited with code 1". Parsing them
 * here turns that into something the user can act on (section 32).
 */
function preflight() {
  const issues = [];
  if (config.apiKey()) return issues;   // our own config dir, nothing inherited
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(require('os').homedir(), '.claude');
  for (const rel of ['plugins/known_marketplaces.json', 'plugins/installed_plugins.json', 'settings.json']) {
    const file = path.join(dir, rel);
    let raw;
    try { raw = require('fs').readFileSync(file, 'utf8'); } catch { continue; }
    try { JSON.parse(raw); } catch (e) { issues.push({ file, error: e.message, bytes: raw.length }); }
  }
  return issues;
}

/**
 * A conversation that keeps ONE agent process alive across turns.
 *
 * Measured on this machine: a fresh query() costs ~9-10s of which only ~0.3s is
 * generation — the rest is spawning and initialising the CLI. Reusing a single
 * streaming-input session drops a warm turn to ~2.5s. Since the interviewer
 * takes several turns in a row, this is the single biggest latency win in the
 * app, so the conversation owns a session rather than calling ask() per turn.
 */
class Session {
  constructor({ system, model = FAST } = {}) {
    this.system = system;
    this.model = model;
    this.queue = [];        // pending user messages waiting to be yielded
    this.waiting = null;    // resolver for the generator's next pull
    this.pending = null;    // resolver for the caller awaiting a result
    this.started = false;
    this.closed = false;
    // With a key we can talk to the API directly — one HTTPS request instead of
    // a CLI subprocess, which is roughly 2.5s -> 1s per turn. Without one we
    // borrow the machine's Claude Code login, and that only works via the CLI.
    this.direct = Boolean(config.apiKey());
    this.history = [];
  }

  /** Spawn the process now so the first real turn is already warm. */
  start() {
    if (this.started) return this;
    this.started = true;
    if (this.direct) return this;   // nothing to spawn
    const self = this;

    async function* input() {
      while (!self.closed) {
        if (self.queue.length) {
          yield self.queue.shift();
        } else {
          await new Promise((r) => { self.waiting = r; });
        }
      }
    }

    this.iterator = query({
      prompt: input(),
      options: {
        ...runtime(),
        model: this.model,
        systemPrompt: this.system,
        allowedTools: [],
        permissionMode: 'dontAsk',
        settingSources: [],
      },
    });

    this.pump = (async () => {
      try {
        for await (const msg of this.iterator) {
          if (msg.type === 'result') {
            const text = msg.subtype === 'success' ? String(msg.result || '') : '';
            const done = this.pending;
            this.pending = null;
            done && done({ text, error: msg.subtype === 'success' ? null : msg.subtype });
          }
        }
      } catch (e) {
        // Keep the reason: without it a dead session reports only that it is
        // dead, which is useless when it died before the first turn.
        this.failure = e.message;
        const done = this.pending;
        this.pending = null;
        done && done({ text: '', error: e.message });
      }
      this.closed = true;
    })();
    return this;
  }

  /** One HTTPS round trip, keeping the conversation in memory on our side. */
  async sendDirect(text, timeout) {
    this.history.push({ role: 'user', content: text });
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': config.apiKey(),
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 1024,
        system: this.system,
        messages: this.history,
      }),
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) {
      this.history.pop();
      throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const body = await res.json();
    const out = (body.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    this.history.push({ role: 'assistant', content: out || '(empty)' });
    if (this.history.length > 40) this.history.splice(0, this.history.length - 40);
    return out;
  }

  /** Send one turn and wait for its reply. Turns are serialised. */
  async send(text, { timeout = 60000 } = {}) {
    if (!this.started) this.start();
    if (this.direct) return this.sendDirect(text, timeout);
    if (this.closed) throw new Error(`conversation ended${this.failure ? `: ${this.failure}` : ''}`);
    while (this.pending) await new Promise((r) => setTimeout(r, 25));

    const result = new Promise((resolve) => { this.pending = resolve; });
    this.queue.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' });
    if (this.waiting) { const w = this.waiting; this.waiting = null; w(); }

    const timer = new Promise((resolve) => setTimeout(() => resolve({ text: '', error: 'timeout' }), timeout));
    const out = await Promise.race([result, timer]);
    if (out.error) throw new Error(`conversation turn failed: ${out.error}`);
    return out.text.trim();
  }

  close() {
    this.closed = true;
    if (this.waiting) { const w = this.waiting; this.waiting = null; w(); }
    try { this.iterator?.return?.(); } catch { /* already gone */ }
  }
}

/**
 * One shared, always-warm session for the short narration jobs (rewriting a
 * question for the user, writing the closing summary). Each message carries its
 * own instructions, so they do not interfere.
 */
let utilitySession = null;
function utility() {
  if (!utilitySession || utilitySession.closed) {
    utilitySession = new Session({
      system: 'You do small writing jobs. Each message is a self-contained task with its own instructions. Follow them exactly and reply with nothing else. Ignore earlier messages.',
    }).start();
  }
  return utilitySession;
}

/** One-shot text completion with no tools. */
async function ask(prompt, { system, model = FAST, maxTurns = 1, signal } = {}) {
  let out = '';
  const iterator = query({
    prompt,
    options: {
      ...runtime(),
      model,
      systemPrompt: system,
      allowedTools: [],
      permissionMode: 'dontAsk',
      maxTurns,
      abortController: signal ? signalToController(signal) : undefined,
      settingSources: [],
    },
  });
  for await (const msg of iterator) {
    if (msg.type === 'assistant') {
      for (const block of msg.message.content) if (block.type === 'text') out += block.text;
    }
    if (msg.type === 'result') {
      if (msg.subtype === 'success' && typeof msg.result === 'string' && msg.result.trim()) out = msg.result;
    }
  }
  return out.trim();
}

function signalToController(signal) {
  const c = new AbortController();
  if (signal.aborted) c.abort();
  else signal.addEventListener('abort', () => c.abort(), { once: true });
  return c;
}

/** Same, but the reply is parsed as JSON. Model output never reaches app state unparsed. */
async function askJSON(prompt, opts = {}) {
  const text = await ask(prompt, {
    ...opts,
    system: `${opts.system || ''}\n\nReply with a single JSON object and nothing else. No prose, no markdown fence.`.trim(),
  });
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error(`model did not return JSON: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(start, end + 1));
}

module.exports = { ask, askJSON, runtime, preflight, Session, utility, FAST, STRONG };
