/**
 * Where does startup actually go?
 *
 * warmUp() runs synchronously between "ENTERING" and the first log line, and on
 * a loaded machine that gap has been measured at over 100 seconds. This times
 * each piece of it separately so the fix targets the real cost.
 *
 *   node tests/bench-startup.js
 */
const t0 = Date.now();
const mark = (label, from) => {
  const now = Date.now();
  console.log(`  ${String(now - from).padStart(6)} ms   ${label}`);
  return now;
};

let t = t0;
const config = require('./../src/main/config');
t = mark('require config', t);
const llm = require('./../src/main/llm');
t = mark('require llm (loads the Agent SDK)', t);
const memory = require('./../src/main/memory');
t = mark('require memory', t);
const { Interview } = require('./../src/main/interviewer');
t = mark('require interviewer', t);
const tts = require('./../src/main/tts');
t = mark('require tts', t);

console.log('');
t = Date.now();
const issues = llm.preflight();
t = mark(`llm.preflight()  [${issues.length} issue(s)]`, t);

const rt = llm.runtime();
t = mark(`llm.runtime()  -> ${rt.pathToClaudeCodeExecutable ? 'explicit CLI path' : 'SDK resolves its own'}`, t);

console.log('');
console.log('--- warmUp() piece by piece ---');
t = Date.now();
llm.utility().start();
t = mark('llm.utility().start()   [spawns the narration agent]', t);

const iv = new Interview(null);
t = mark('new Interview()         [reads memory, builds the prompt]', t);

iv.warm();
t = mark('interview.warm()        [spawns the interviewer agent]', t);

const tSpeak = Date.now();
tts.speak('ok').then(
  () => { mark('tts.speak("ok")         [Edge TTS round trip]', tSpeak); done(); },
  (e) => { mark(`tts.speak FAILED: ${e.message}`, tSpeak); done(); }
);

function done() {
  console.log('');
  console.log(`  TOTAL to a usable engineer: ${Date.now() - t0} ms`);
  console.log('');
  console.log('Note: the two agent spawns are what warmUp pays for. If they dominate,');
  console.log('the fix is to stop blocking the entrance on them, not to make them faster.');
  try { iv.close(); } catch { /* already gone */ }
  process.exit(0);
}

setTimeout(() => { console.log('\n  (timed out after 180s)'); process.exit(1); }, 180000);
