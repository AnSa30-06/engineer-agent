/**
 * The whole internal architecture: one event bus, one state machine, one log.
 *
 * Everything else (sprite, panel, TTS, agents) subscribes here. Nothing calls
 * anything else directly, which is what keeps the sprite decoupled from the
 * coding agent — the agent emits events, the sprite reacts to state.
 */
const { EventEmitter } = require('events');

const STATES = [
  'STARTING', 'ENTERING', 'IDLE', 'LISTENING', 'THINKING', 'SPEAKING',
  'PHONE_RINGING', 'ON_CALL', 'HANDOFF', 'WORKING', 'TESTING',
  'WAITING_FOR_USER', 'COMPLETED', 'ERROR',
];

/** Agent activity kinds. The narrator and the sprite both key off these. */
const EVENTS = [
  'started', 'reading_file', 'writing_file', 'editing_file', 'deleting_file',
  'running_command', 'running_test', 'test_failed', 'test_passed',
  'installing_dependency', 'searching', 'thinking', 'waiting_for_user',
  'building', 'completed', 'error', 'interrupted',
];

const bus = new EventEmitter();
bus.setMaxListeners(40);

// --- state machine ---------------------------------------------------------
let state = 'STARTING';
let previous = null;

function getState() {
  return state;
}

/**
 * The single writer for application state. LLM output never reaches this —
 * only validated events do (see coder.js / interviewer.js).
 */
function setState(next, detail) {
  if (!STATES.includes(next)) throw new Error(`unknown state: ${next}`);
  if (next === state) return state;
  previous = state;
  state = next;
  bus.emit('state', { state, previous, detail: detail || null, at: Date.now() });
  return state;
}

const priorState = () => previous;

// --- log -------------------------------------------------------------------
// One record carries both views (section 20): `human` is what gets shown and
// possibly spoken, `technical` is the real command/file/error behind it.
const entries = [];
let seq = 0;

function log({ kind = 'info', human, technical = null, level = 'info' }) {
  const entry = {
    id: ++seq,
    at: Date.now(),
    kind,
    level,                       // info | warn | error | success
    human: human || null,
    technical,
  };
  entries.push(entry);
  if (entries.length > 2000) entries.splice(0, entries.length - 2000);
  bus.emit('log', entry);
  return entry;
}

const history = (limit = 400) => entries.slice(-limit);

// --- pending decisions (section 17) ----------------------------------------
// A question the agent genuinely needs answered. It is NEVER auto-answered:
// if the user does not pick up, it waits here until they do.
const pending = new Map();
let decisionSeq = 0;

function askUser({ question, options = [], context = null, onAnswer }) {
  const id = ++decisionSeq;
  const decision = {
    id,
    question,
    options,
    context,
    asked: Date.now(),
    answered: null,
    answer: null,
    onAnswer,
  };
  pending.set(id, decision);
  log({
    kind: 'waiting_for_user',
    level: 'warn',
    human: question,
    technical: `decision #${id} raised${options.length ? ` — options: ${options.join(' | ')}` : ''}`,
  });
  bus.emit('decision', publicDecision(decision));
  return decision;
}

function answerDecision(id, answer) {
  const d = pending.get(Number(id));
  if (!d || d.answered) return false;
  d.answered = Date.now();
  d.answer = answer;
  pending.delete(d.id);
  log({ kind: 'decision_answered', level: 'success', human: `You answered: ${answer}`, technical: `decision #${d.id} -> ${answer}` });
  bus.emit('decision-resolved', publicDecision(d));
  try { d.onAnswer && d.onAnswer(answer); } catch (e) { log({ kind: 'error', level: 'error', human: 'Something went wrong passing your answer along.', technical: e.stack }); }
  return true;
}

const publicDecision = (d) => ({ id: d.id, question: d.question, options: d.options, context: d.context, asked: d.asked, answered: d.answered, answer: d.answer });
const pendingDecisions = () => [...pending.values()].map(publicDecision);

module.exports = {
  bus, STATES, EVENTS,
  getState, setState, priorState,
  log, history,
  askUser, answerDecision, pendingDecisions,
};
