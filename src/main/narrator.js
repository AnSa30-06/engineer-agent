/**
 * Turns real agent events into plain English (section 19).
 *
 * Rules first, model second. Routine events map through a lookup table — that
 * costs nothing, adds no latency, and structurally cannot invent progress that
 * did not happen. The model is used only for the closing summary, where real
 * judgement is needed.
 *
 * Nothing here ever claims success. Success lines only fire on events the agent
 * actually emitted.
 */
const { utility } = require('./llm');

/** Path -> something a non-engineer can hear without wincing. */
function friendlyName(file) {
  if (!file) return null;
  const base = String(file).split(/[\\/]/).pop().replace(/\.[a-z0-9]+$/i, '');
  const words = base.replace(/[-_.]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim();
  if (!words || words.length > 28 || /^(index|main|app|src|test|spec)$/i.test(words)) return null;
  return words.toLowerCase();
}

const pick = (a) => a[Math.floor(Math.random() * a.length)];

/**
 * @returns {{human: string, speak: boolean, level: string} | null}
 *          null means: log it, say nothing.
 */
function describe(ev) {
  const name = friendlyName(ev.file);
  switch (ev.kind) {
    case 'started':
      return { human: "Right, I'm starting on it now.", speak: true, level: 'info' };

    case 'reading_file':
    case 'searching':
      return { human: 'Having a look through the project.', speak: false, level: 'info' };

    case 'writing_file':
    case 'editing_file':
      return {
        human: name
          ? pick([`I'm putting the ${name} part together.`, `Working on the ${name} bit now.`])
          : "I'm writing some of it now.",
        speak: true, level: 'info',
      };

    case 'deleting_file':
      return { human: name ? `Clearing out the old ${name} file.` : 'Tidying up a file I no longer need.', speak: false, level: 'info' };

    case 'installing_dependency':
      return { human: "Installing the pieces it needs. This can take a moment.", speak: true, level: 'info' };

    case 'running_command':
      return { human: 'Running something to check my work.', speak: false, level: 'info' };

    case 'running_test':
      return { human: "I'm testing it now.", speak: true, level: 'info' };

    case 'test_passed':
      return { human: 'Good — the tests passed.', speak: true, level: 'success' };

    case 'test_failed':
      return { human: "The tests found a problem. I'm fixing it and running them again.", speak: true, level: 'warn' };

    case 'building':
      return { human: "I'm building it now.", speak: true, level: 'info' };

    case 'thinking':
      return { human: 'Thinking about how to do this.', speak: false, level: 'info' };

    case 'waiting_for_user':
      return { human: 'I need to ask you something before I carry on.', speak: false, level: 'warn' };

    case 'interrupted':
      return { human: "Okay, I've stopped where I was.", speak: true, level: 'warn' };

    case 'error':
      return { human: "Something went wrong. I'm looking at what happened.", speak: true, level: 'error' };

    case 'completed':
      return { human: "That's it — I've finished.", speak: false, level: 'success' };

    default:
      return null;
  }
}

/**
 * Speech gate: the engineer should not narrate every file he touches.
 * Important events always speak; routine ones speak at most every `gapMs`.
 */
function createGate(gapMs = 20000) {
  let last = 0;
  const always = new Set(['started', 'test_passed', 'test_failed', 'error', 'completed', 'interrupted', 'installing_dependency']);
  return (ev, line) => {
    if (!line || !line.speak) return false;
    const now = Date.now();
    if (always.has(ev.kind)) { last = now; return true; }
    if (now - last < gapMs) return false;
    last = now;
    return true;
  };
}

/**
 * The spoken closing summary (section 25). Short, non-technical, and honest
 * about failures — the facts come from the run, not from the model's optimism.
 */
async function summarise({ spec, facts, transcript }) {
  const ranNothing = !facts.commandsRun && !facts.testsRun && !facts.built;

  const system =
    'You are a friendly software engineer explaining finished work to someone who is NOT technical. ' +
    'Speak in first person, plainly, 2-4 short sentences, no jargon, no file paths, no command names, no lists. ' +
    'This will be read aloud, so write it as speech. ' +
    'If tests or the build did not pass, say so plainly instead of glossing over it. Never claim something works if the facts say otherwise. ' +
    'CRITICAL: the numbered facts are the only record of what actually happened. Never say you tested, ran, checked or tried anything unless the facts show it was run — ' +
    "the closing note is the agent's own words and may claim more than it did. If nothing was executed, say the code is written but you have not run it yet.";

  const prompt = [
    `What they asked for: ${spec.goal}`,
    spec.acceptanceCriteria?.length ? `What "done" meant: ${spec.acceptanceCriteria.join('; ')}` : '',
    `Where it was built: ${facts.projectDir}`,
    `Files created or changed: ${facts.filesTouched.length ? facts.filesTouched.slice(0, 20).join(', ') : 'none'}`,
    `Commands actually executed: ${facts.commandsRun || 0}.`,
    `Tests run: ${facts.testsRun}. Tests passed: ${facts.testsPassed}. Tests failed: ${facts.testsFailed}.`,
    `Build attempted: ${facts.built ? 'yes' : 'no'}. Errors seen: ${facts.errors}.`,
    ranNothing
      ? 'NOTHING WAS EXECUTED — the code was written but never run, so it is unverified. Say so.'
      : 'The work above was actually executed.',
    facts.outcome ? `How it ended: ${facts.outcome}` : '',
    transcript ? `The agent's own closing note (unverified claims possible): ${String(transcript).slice(0, 1500)}` : '',
    '',
    'Tell them how it went.',
  ].filter(Boolean).join('\n');

  try {
    // the shared warm session — a cold call here would add ~10s of silence
    return await utility().send(`${system}\n\n---\n${prompt}`);
  } catch {
    // never block completion on the narrator, and never overclaim in the fallback
    if (facts.testsFailed || facts.errors) {
      return `I've finished what I could, but not everything worked. Have a look at the log and I can pick it back up.`;
    }
    if (ranNothing) {
      return `It's written and it's in the folder we picked, but I haven't run it yet, so I can't promise it works.`;
    }
    return `It's done. I built what you asked for and checked it over, and it's in the folder we picked.`;
  }
}

/** Rewrite the agent's own question into something answerable by a non-engineer. */
async function humaniseQuestion(question, options) {
  const system =
    'Rewrite this software question so a non-technical person can answer it out loud. ' +
    'One short sentence, plain words, no jargon. Keep the actual choice intact. Return only the question.';
  try {
    const out = await utility().send(
      `${system}\n\n---\n${question}${options?.length ? `\nOptions: ${options.join(' | ')}` : ''}`
    );
    return out.split('\n')[0].slice(0, 240) || question;
  } catch {
    return question;
  }
}

module.exports = { describe, createGate, summarise, humaniseQuestion, friendlyName };
