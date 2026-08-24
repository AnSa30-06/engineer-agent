/**
 * The real coding agent (sections 15-18).
 *
 * This is Claude Code running headless through the official Agent SDK — it
 * reads, writes, edits and deletes files, runs commands, installs dependencies,
 * runs tests, fixes what it broke and uses git. Nothing here simulates work,
 * and every progress event below is emitted from a tool call that actually
 * happened.
 *
 * Permission policy lives entirely in canUseTool so that a restrictive mode is
 * genuinely enforced rather than announced (section 16).
 */
const path = require('path');
const { query } = require('@anthropic-ai/claude-agent-sdk');
const { runtime, STRONG } = require('./llm');
const core = require('./core');

// --- classification of real tool calls into progress events (section 18) ----
const TOOL_EVENT = {
  Read: 'reading_file', NotebookRead: 'reading_file',
  Write: 'writing_file',
  Edit: 'editing_file', MultiEdit: 'editing_file', NotebookEdit: 'editing_file',
  Glob: 'searching', Grep: 'searching', WebSearch: 'searching', WebFetch: 'searching',
  TodoWrite: 'thinking', Task: 'thinking',
};

// `node test.js` is how an agent most often runs a plain test file. Missing it
// made a real run report zero tests while tests were in fact passing (measured).
const RE_TEST = /\b(npm|pnpm|yarn)\s+(run\s+)?test\b|\b(jest|vitest|pytest|mocha|phpunit|rspec)\b|\bgo\s+test\b|\bcargo\s+test\b|\bdotnet\s+test\b|\b(node|python3?|deno|bun)\s+[^|&]*\btests?[\w.-]*/i;
const RE_BUILD = /\b(npm|pnpm|yarn)\s+(run\s+)?build\b|\btsc\b|\bwebpack\b|\bvite\s+build\b|\bcargo\s+build\b|\bmake\b|\bdotnet\s+build\b|\bgo\s+build\b/i;
const RE_INSTALL = /\b(npm|pnpm|yarn)\s+(i|install|add)\b|\bpip3?\s+install\b|\bcargo\s+add\b|\bgo\s+get\b|\bdotnet\s+add\b/i;

/** Operations that deserve a phone call rather than a silent yes. */
const RE_CONSEQUENTIAL =
  /\brm\s+-[rf]|\brmdir\b|\bdel\s+\/|Remove-Item|\bformat\b|\bmkfs\b|\bdd\s+if=|\bgit\s+push\b|\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-[a-z]*f|\bnpm\s+publish\b|\bshutdown\b|\breg\s+delete\b|\bcurl\b.*\|\s*(ba)?sh|\bsudo\b|\bnpx\b.*--yes/i;

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const DELETE_HINT = /\b(rm|del|unlink|Remove-Item)\b/i;

function classifyBash(cmd = '') {
  if (RE_TEST.test(cmd)) return 'running_test';
  if (RE_BUILD.test(cmd)) return 'building';
  if (RE_INSTALL.test(cmd)) return 'installing_dependency';
  if (DELETE_HINT.test(cmd)) return 'deleting_file';
  return 'running_command';
}

const inside = (dir, file) => {
  const rel = path.relative(dir, path.resolve(dir, file));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

const SYSTEM = `You are a professional software engineer working autonomously on the user's behalf.

Build what the brief asks for, properly and completely, in the working directory you were given. Write real, working code. Run it. Test it. Fix what fails. Do not stop at a scaffold and do not leave placeholders.

Rules:
- Stay inside the working directory. Never touch files elsewhere.
- Prefer the simplest thing that genuinely satisfies the brief. No speculative abstractions.
- Verify your work by actually running it — tests, a build, or executing the program.
- If something fails, read the error, fix it, and try again.
- When you genuinely need the user to make a decision that changes what gets built (and cannot reasonably decide it yourself), use the AskUserQuestion tool. Do not use it for things you can just decide.
- Never claim something works that you did not run.

When you are finished, end with a short plain-English note saying what you built, what you verified, and anything that did not work.`;

/**
 * Runs one build. Returns when the agent finishes, is cancelled, or fails.
 */
function run({ brief, projectDir, permissionMode, onEvent }) {
  const controller = new AbortController();
  const facts = {
    projectDir,
    filesTouched: [], commandsRun: 0, testsRun: 0, testsPassed: 0, testsFailed: 0,
    built: false, errors: 0, outcome: null, finalText: '',
  };

  let paused = false;
  let resumeWaiters = [];
  const waitWhilePaused = () =>
    paused ? new Promise((r) => resumeWaiters.push(r)) : Promise.resolve();

  const emit = (kind, detail = {}) => {
    if (kind === 'error') facts.errors++;
    onEvent({ kind, ...detail });
  };

  // Tool calls we have seen, so a tool_result can be matched back to its request.
  const inFlight = new Map();

  /** The permission gate. This is where the selected mode is actually enforced. */
  async function canUseTool(toolName, input) {
    await waitWhilePaused();
    if (controller.signal.aborted) return { behavior: 'deny', message: 'Cancelled by the user.' };

    // The agent explicitly wants the user — always a phone call, in every mode.
    if (toolName === 'AskUserQuestion') return handleAskUserQuestion(input);

    // Section 31: never modify arbitrary directories, whatever the mode.
    const target = input?.file_path || input?.path || input?.notebook_path;
    if (target && WRITE_TOOLS.has(toolName) && !inside(projectDir, target)) {
      core.log({
        kind: 'blocked', level: 'warn',
        human: 'I tried to touch a file outside the project folder, so I stopped myself.',
        technical: `blocked ${toolName} -> ${target} (outside ${projectDir})`,
      });
      return { behavior: 'deny', message: `Refused: ${target} is outside the working directory ${projectDir}. Stay inside it.` };
    }

    const cmd = input?.command || '';
    const consequential = toolName === 'Bash' && RE_CONSEQUENTIAL.test(cmd);
    const writes = WRITE_TOOLS.has(toolName) || toolName === 'Bash';

    if (permissionMode === 'autonomous') {
      if (consequential) return askPermission(toolName, cmd || target, input);
      return { behavior: 'allow', updatedInput: input };
    }
    if (permissionMode === 'standard') {
      if (consequential) return askPermission(toolName, cmd || target, input);
      return { behavior: 'allow', updatedInput: input };
    }
    // 'ask': anything that changes the machine goes past the user first
    if (writes) return askPermission(toolName, cmd || target, input);
    return { behavior: 'allow', updatedInput: input };
  }

  /** Raise a yes/no with the user via the telephone. Never auto-answers. */
  function askPermission(toolName, what, input) {
    emit('waiting_for_user', { question: `Permission for ${toolName}`, technical: `${toolName}: ${what}` });
    return new Promise((resolve) => {
      core.askUser({
        question: describePermission(toolName, what),
        options: ['Yes, go ahead', 'No, skip that'],
        context: { kind: 'permission', tool: toolName, detail: String(what || '').slice(0, 400) },
        onAnswer: (answer) => {
          const yes = /^\s*(y|yes|ok|okay|sure|go|do it|allow|approve|yep|yeah|fine|please)/i.test(String(answer));
          // The log must show what was actually permitted, not only what was attempted.
          core.log({
            kind: yes ? 'permitted' : 'declined',
            level: yes ? 'info' : 'warn',
            human: yes ? null : 'You said no, so I left that one alone.',
            technical: `${yes ? 'allowed' : 'denied'} ${toolName}: ${String(what || '').slice(0, 160)}`,
          });
          resolve(yes
            ? { behavior: 'allow', updatedInput: input }
            : { behavior: 'deny', message: `The user declined. Their words: "${answer}". Find another way or ask something else.` });
        },
      });
    });
  }

  function describePermission(toolName, what) {
    const s = String(what || '');
    if (toolName === 'Bash') return `I need to run this on your machine: ${s.slice(0, 160)}. Is that alright?`;
    return `I need to change ${path.basename(s) || 'a file'} in your project. Is that alright?`;
  }

  /** The agent asked a real question. Route it to the phone (section 17). */
  function handleAskUserQuestion(input) {
    const questions = Array.isArray(input?.questions) ? input.questions : [];
    if (!questions.length) return { behavior: 'allow', updatedInput: input };

    return new Promise((resolve) => {
      const answers = {};
      let i = 0;
      const next = () => {
        if (i >= questions.length) {
          resolve({ behavior: 'allow', updatedInput: { questions, answers } });
          return;
        }
        const q = questions[i++];
        const options = (q.options || []).map((o) => o.label);
        emit('waiting_for_user', { question: q.question, technical: `AskUserQuestion: ${q.question}` });
        core.askUser({
          question: q.question,
          options,
          context: { kind: 'question', header: q.header || '', detail: (q.options || []).map((o) => `${o.label}: ${o.description || ''}`).join('\n') },
          onAnswer: (answer) => { answers[q.question] = answer; next(); },
        });
      };
      next();
    });
  }

  const promise = (async () => {
    emit('started', {});
    let lastAssistantText = '';

    try {
      const iterator = query({
        prompt: brief,
        options: {
          ...runtime(),
          model: STRONG,
          cwd: projectDir,
          systemPrompt: { type: 'preset', preset: 'claude_code', append: SYSTEM },
          permissionMode: 'default',
          canUseTool,
          abortController: controller,
          maxTurns: 400,
          includePartialMessages: false,
          settingSources: [],
          // Without this, an agent crash reaches us only as "exited with code 1".
          stderr: (chunk) => {
            const text = String(chunk).trim();
            if (text) core.log({ kind: 'agent_stderr', level: 'warn', human: null, technical: text.slice(0, 800) });
          },
        },
      });

      for await (const msg of iterator) {
        if (controller.signal.aborted) break;
        await waitWhilePaused();

        if (msg.type === 'assistant') {
          for (const block of msg.message.content || []) {
            if (block.type === 'text' && block.text.trim()) lastAssistantText = block.text;
            if (block.type !== 'tool_use') continue;

            const name = block.name;
            const input = block.input || {};
            let kind = TOOL_EVENT[name];
            let detail = {};

            if (name === 'Bash') {
              kind = classifyBash(input.command);
              detail = { command: input.command, technical: input.command };
              facts.commandsRun++;
              if (kind === 'running_test') facts.testsRun++;
              if (kind === 'building') facts.built = true;
            } else if (input.file_path || input.path) {
              const f = input.file_path || input.path;
              detail = { file: f, technical: `${name} ${f}` };
              if (WRITE_TOOLS.has(name) && !facts.filesTouched.includes(f)) facts.filesTouched.push(f);
            } else {
              detail = { technical: `${name} ${JSON.stringify(input).slice(0, 200)}` };
            }

            if (kind) {
              inFlight.set(block.id, kind);
              emit(kind, detail);
            }
          }
        }

        if (msg.type === 'user') {
          for (const block of msg.message?.content || []) {
            if (block.type !== 'tool_result') continue;
            const kind = inFlight.get(block.tool_use_id);
            inFlight.delete(block.tool_use_id);
            const text = typeof block.content === 'string'
              ? block.content
              : (block.content || []).map((c) => c.text || '').join(' ');

            if (kind === 'running_test') {
              if (block.is_error || /\b\d+\s+failed|FAIL\b|failures?:\s*[1-9]/i.test(text)) {
                facts.testsFailed++;
                emit('test_failed', { technical: text.slice(0, 600) });
              } else {
                facts.testsPassed++;
                emit('test_passed', { technical: text.slice(0, 300) });
              }
            } else if (block.is_error) {
              emit('error', { technical: text.slice(0, 600) });
            }
          }
        }

        if (msg.type === 'result') {
          facts.outcome = msg.subtype;
          if (msg.subtype === 'success') {
            facts.finalText = typeof msg.result === 'string' ? msg.result : lastAssistantText;
            emit('completed', { technical: `result: ${msg.subtype}` });
          } else {
            emit('error', { technical: `agent stopped: ${msg.subtype}` });
          }
        }
      }
    } catch (e) {
      if (controller.signal.aborted) {
        facts.outcome = 'interrupted';
        emit('interrupted', { technical: String(e && e.message) });
      } else if (facts.outcome === 'success') {
        // The run already reported success; this is the agent process falling
        // over on its way out. Record it, but do not invent a failed build.
        core.log({
          kind: 'agent_shutdown', level: 'warn', human: null,
          technical: `agent process errored after reporting success: ${(e && e.message) || e}`,
        });
      } else {
        facts.outcome = 'error';
        emit('error', { technical: (e && e.stack) || String(e) });
      }
    }

    if (!facts.finalText) facts.finalText = lastAssistantText;
    return facts;
  })();

  return {
    promise,
    facts,
    cancel() { controller.abort(); },
    pause() { paused = true; },
    resume() {
      paused = false;
      const waiters = resumeWaiters;
      resumeWaiters = [];
      waiters.forEach((r) => r());
    },
    get paused() { return paused; },
  };
}

module.exports = { run, classifyBash, inside, RE_CONSEQUENTIAL, WRITE_TOOLS, TOOL_EVENT };
