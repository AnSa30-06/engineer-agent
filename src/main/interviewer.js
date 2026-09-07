/**
 * The interviewer (sections 11-14).
 *
 * This is NOT the coding agent. Its only job is to find out what is missing
 * that would materially improve what the coding agent builds, ask about that,
 * and then hand over a structured spec.
 *
 * It is explicitly told to track what it does not know rather than guess, and
 * not to pick technologies the user has no opinion about — those are the
 * coding agent's call.
 */
const fs = require('fs');
const path = require('path');
const { Session } = require('./llm');
const config = require('./config');
const memory = require('./memory');

const EMPTY_SPEC = {
  goal: '',
  requirements: [],
  constraints: [],
  platform: '',
  uiRequirements: [],
  integrations: [],
  decisions: [],
  acceptanceCriteria: [],
  openQuestions: [],
  unknowns: [],
};

const SYSTEM = `You are a fast, friendly software project interviewer talking OUT LOUD to someone who is probably not an engineer.

Your one question is: "what information is missing that would materially improve what the engineer builds?" Ask about that, and nothing else.

You do not build anything and you have no tools. A separate engineer does the building, after you hand over. So when the user says "go ahead and build it" or "run it and check", that is not a request for YOU to act — it is them telling you the interview is over. Set done=true and sign off. Never say you need permission, and never say you cannot do something: you were not being asked to do it.

Rules:
- ONE short question per turn. Natural, spoken English. No lists, no numbered options, no jargon.
- Only ask what actually changes the result. Never interrogate. Most projects need 2-5 questions total, and simple ones need fewer.
- Do NOT design the software. Do NOT propose an architecture. Do NOT choose languages, frameworks, libraries or databases unless the user has a preference or the choice genuinely changes what they get — those are the building engineer's decisions.
- Never pretend to know something you were not told. If you assumed it, it goes in "unknowns", not "requirements".
- If the user did not answer your last question, do not ask it again. Put it in "unknowns", let the engineer decide it, and move on to something else or finish.
- Fill "decisions" only with things the USER actually decided.
- When you have enough to build something genuinely useful, set done=true and make reply a short, warm sign-off meaning "got it, I'll build it now". Do not read the spec back to them.
- If the user asks you to just get on with it, set done=true immediately and work with what you have, recording the gaps in "unknowns".

Return JSON exactly:
{
  "reply": "what you say out loud next (one short question, or the sign-off)",
  "done": false,
  "add": { }
}

"add" is what THIS turn learned — nothing else. The spec so far is kept for you and everything in it is carried forward automatically, so never restate it. Omit any field you have nothing new for, and omit "add" entirely on a turn that taught you nothing.

Fields "add" may contain:
  "goal": one sentence in the user's own terms (send it only to set or correct it)
  "platform": only if the user stated one
  "requirements", "constraints", "uiRequirements", "integrations": only items NOT already listed
  "decisions": what the user explicitly chose this turn
  "acceptanceCriteria": how we will know it is done
  "openQuestions": things still worth asking later
  "unknowns": things you are assuming because nobody said

Keep it short. Repeating what the spec already holds only slows the reply down.`;

class Interview {
  constructor(existingSpec) {
    // A carried-over spec from an earlier handoff is model output too, so it is
    // validated on the way in rather than trusted (section 22).
    this.spec = normalise({ ...EMPTY_SPEC, ...(existingSpec || {}) });
    this.transcript = [];
    this.questionsAsked = 0;
    // One process for the whole interview. A fresh query() per turn costs ~10s
    // of startup; a warm session turn costs ~2.5s (measured).
    // What he already knows about this person, from previous sessions. It goes
    // in the SYSTEM prompt rather than the turn so it is stated once and cannot
    // be crowded out by a long conversation.
    const known = memory.brief();
    this.session = new Session({
      system: [
        SYSTEM,
        known && `\nYou have worked with this person before.\n\n${known}`,
        '\nReply with a single JSON object and nothing else. No prose, no markdown fence.',
      ].filter(Boolean).join('\n'),
    });
  }

  /** Spawn the process before the user has said anything, so turn 1 is warm. */
  warm() {
    try { this.session.start(); } catch { /* falls back to a cold turn */ }
    return this;
  }

  /**
   * One conversational turn.
   * @returns {Promise<{reply: string, done: boolean, spec: object}>}
   */
  async turn(userText) {
    this.transcript.push({ role: 'user', text: userText, at: Date.now() });

    // The session already remembers the conversation, so only the new turn and
    // the authoritative spec go across — smaller prompt, faster reply.
    const prompt = [
      `Spec so far:\n${JSON.stringify(this.spec)}`,
      `Questions already asked: ${this.questionsAsked}`,
      `User just said: ${userText}`,
      this.questionsAsked >= 5
        ? 'You have asked enough. Unless something critical is genuinely missing, set done=true now.'
        : 'What do you say next?',
    ].join('\n');

    let out;
    try {
      out = parseJSON(await this.session.send(prompt));
    } catch (first) {
      // Measured 2026-08-24: told "go ahead and build it, and run it once to
      // check", the model answered in prose ("I need your permission to write
      // files") — it has no tools, so it reported that as an obstacle instead
      // of returning JSON. The old behaviour asked the user to repeat himself,
      // he repeated himself, and it failed again: the conversation could not
      // recover on its own. One corrective retry breaks that loop.
      try {
        out = parseJSON(await this.session.send(
          'That was not JSON. You are the interviewer: you have no tools and are not being asked to build or run anything — the engineer does that after you hand over. '
          + 'Reply again to the same turn, as a single JSON object and nothing else.'));
      } catch (second) {
        return {
          reply: "Sorry, I missed that — could you say it once more?",
          done: false,
          spec: this.spec,
          error: `${first.message} | retry: ${second.message}`,
        };
      }
    }

    // "spec" is tolerated for a model that restates everything anyway; merging
    // either shape is the same operation, so both are accepted.
    this.spec = merge(this.spec, out.add || out.spec);
    const reply = String(out.reply || '').trim() || 'Got it.';
    const done = Boolean(out.done);
    if (!done) this.questionsAsked++;
    this.transcript.push({ role: 'engineer', text: reply, at: Date.now() });
    return { reply, done, spec: this.spec };
  }

  /** The handoff packet (section 14). Persisted so it can be inspected later. */
  handoff(projectDir) {
    const packet = {
      version: 1,
      createdAt: new Date().toISOString(),
      projectDir,
      originalGoal: this.transcript.find((t) => t.role === 'user')?.text || this.spec.goal,
      spec: this.spec,
      transcript: this.transcript,
    };
    try {
      fs.mkdirSync(config.paths.handoffs, { recursive: true });
      packet.file = path.join(config.paths.handoffs, `handoff-${Date.now()}.json`);
      fs.writeFileSync(packet.file, JSON.stringify(packet, null, 2));
    } catch { /* an unwritable handoff must not stop the build */ }
    this.close();
    return packet;
  }

  /** The interview is over; let its process go. */
  close() {
    try { this.session.close(); } catch { /* already gone */ }
  }
}

/** Model output is text until proven otherwise. */
function parseJSON(text) {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a === -1 || b === -1) throw new Error(`model did not return JSON: ${String(text).slice(0, 200)}`);
  return JSON.parse(text.slice(a, b + 1));
}

const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()) : []);

const LISTS = ['requirements', 'constraints', 'uiRequirements', 'integrations',
  'decisions', 'acceptanceCriteria', 'openQuestions', 'unknowns'];

/**
 * Fold one turn's findings into the spec.
 *
 * The interviewer sends only what it just learned rather than the whole spec
 * every turn. That is a latency fix, not a style one: re-emitting the spec cost
 * several hundred output tokens per turn, and the user is waiting out loud for
 * the one sentence at the top of it. Carrying the spec forward is therefore
 * our job here, and the model is told it happens automatically.
 */
function merge(spec, add) {
  const out = normalise(spec);
  if (!add || typeof add !== 'object') return out;
  const patch = normalise(add);
  if (patch.goal) out.goal = patch.goal;
  if (patch.platform) out.platform = patch.platform;
  for (const key of LISTS) {
    const seen = new Set(out[key].map((v) => v.toLowerCase()));
    for (const item of patch[key]) {
      if (seen.has(item.toLowerCase())) continue;   // a re-sent item is not a new one
      seen.add(item.toLowerCase());
      out[key].push(item);
    }
  }
  return out;
}

/** Validate model output before it becomes application state (section 22). */
function normalise(s) {
  return {
    goal: typeof s.goal === 'string' ? s.goal : '',
    platform: typeof s.platform === 'string' ? s.platform : '',
    requirements: arr(s.requirements),
    constraints: arr(s.constraints),
    uiRequirements: arr(s.uiRequirements),
    integrations: arr(s.integrations),
    decisions: arr(s.decisions),
    acceptanceCriteria: arr(s.acceptanceCriteria),
    openQuestions: arr(s.openQuestions),
    unknowns: arr(s.unknowns),
  };
}

/** The brief the coding agent actually receives — not the raw voice transcript. */
function briefFor(packet) {
  const s = packet.spec;
  const section = (title, items) => (items.length ? `\n## ${title}\n${items.map((i) => `- ${i}`).join('\n')}` : '');
  return [
    `# What to build\n${s.goal || packet.originalGoal}`,
    `\nThe user said, in their own words: "${packet.originalGoal}"`,
    s.platform ? `\n## Platform\n${s.platform}` : '',
    section('Requirements', s.requirements),
    section('The user decided', s.decisions),
    section('Constraints', s.constraints),
    section('How it should look and feel', s.uiRequirements),
    section('Integrations', s.integrations),
    section('Acceptance criteria — it is done when', s.acceptanceCriteria),
    section('Assumed, because nobody said (do not treat as settled)', s.unknowns),
    section('Still open', s.openQuestions),
    `\n## Working directory\n${packet.projectDir}`,
  ].filter(Boolean).join('\n');
}

module.exports = { Interview, briefFor, merge, EMPTY_SPEC };
