/**
 * Where does the turnaround time actually go?
 *
 * Measures each leg of "user stops talking" -> "engineer starts talking":
 *   silence detection -> transcription -> interviewer -> speech synthesis
 *
 *   node tests/bench-latency.js
 */
const tts = require('../src/main/tts');
const { ask, FAST } = require('../src/main/llm');
const { Interview } = require('../src/main/interviewer');

const ms = (t) => `${Math.round(t)}ms`;
const time = async (label, fn) => {
  const t0 = performance.now();
  const out = await fn();
  const dt = performance.now() - t0;
  console.log(`  ${label.padEnd(38)} ${ms(dt).padStart(8)}`);
  return { dt, out };
};

(async () => {
  console.log('\n=== interviewer (Agent SDK, one subprocess per call) ===');
  const llmTimes = [];
  for (let i = 0; i < 3; i++) {
    const r = await time(`ask() cold #${i + 1}`, () => ask('Say exactly: OK', { model: FAST }));
    llmTimes.push(r.dt);
  }

  console.log('\n=== a real interviewer turn (JSON spec + reply) ===');
  const iv = new Interview();
  const turn = await time('Interview.turn()', () => iv.turn('can you build me a calculator?'));
  console.log(`     -> "${turn.out.reply}"`);

  console.log('\n=== speech synthesis ===');
  const short = 'Got it, I will build it now.';
  const long = turn.out.reply;
  const a = await time(`speak() short (${short.length} chars)`, () => tts.speak(short));
  const b = await time(`speak() reply (${long.length} chars)`, () => tts.speak(long));
  console.log(`     short: ${a.out.audio.length} bytes, reply: ${b.out.audio.length} bytes`);

  const warm = await time('speak() again (connection reuse?)', () => tts.speak(short));

  console.log('\n=== budget for one turn ===');
  const stt = 1500;   // measured separately in the renderer
  const silence = 900;
  const total = silence + stt + turn.dt + b.dt;
  console.log(`  silence detection (VAD hold)           ${ms(silence).padStart(8)}`);
  console.log(`  transcription (whisper base.en fp32)   ~${ms(stt).padStart(7)}`);
  console.log(`  interviewer                            ${ms(turn.dt).padStart(8)}`);
  console.log(`  speech synthesis                       ${ms(b.dt).padStart(8)}`);
  console.log(`  ${'TOTAL before he starts talking'.padEnd(38)} ${ms(total).padStart(8)}`);
  console.log(`\n  (llm cold-call spread: ${llmTimes.map((t) => ms(t)).join(', ')})`);
  console.log(`  (tts warm call: ${ms(warm.dt)})`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
