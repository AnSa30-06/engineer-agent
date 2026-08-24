/**
 * Live test of the interviewer and the narration layer (sections 11-13, 19, 25).
 *
 *   node tests/conversation-live.js
 */
const { Interview, briefFor } = require('../src/main/interviewer');
const narrator = require('../src/main/narrator');

const results = [];
const check = (name, ok, extra = '') => {
  results.push([name, ok]);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `\n        ${extra}` : ''}`);
};

(async () => {
  console.log('--- the interview ---');
  const iv = new Interview();
  const script = [
    'hey, can you build me a calculator?',
    'just something on my windows laptop, nothing fancy',
    'plus minus times divide is fine, and it should look dark',
    "that's everything, go for it",
  ];

  let done = false;
  let turns = 0;
  for (const said of script) {
    if (done) break;
    turns++;
    const t = await iv.turn(said);
    console.log(`  user:     ${said}`);
    console.log(`  engineer: ${t.reply}`);
    done = t.done;
  }

  check('the interviewer asked at least one question before starting', turns > 1);
  check('the interview reached a conclusion', done, `done after ${turns} turns`);
  check('it did not interrogate endlessly', turns <= 5, `${turns} turns`);
  check('a goal was captured', Boolean(iv.spec.goal), iv.spec.goal);
  check('requirements were captured', iv.spec.requirements.length > 0, iv.spec.requirements.join('; '));
  check('what the user chose was recorded separately from what was assumed',
    Array.isArray(iv.spec.decisions) && Array.isArray(iv.spec.unknowns),
    `decisions: ${iv.spec.decisions.join('; ') || '(none)'} | assumed: ${iv.spec.unknowns.join('; ') || '(none)'}`);

  const last = iv.transcript[iv.transcript.length - 1].text;
  check('the sign-off is short and not a technical plan', last.length < 220, last);

  const packet = iv.handoff('C:\\tmp\\calc');
  check('the handoff packet was persisted for inspection', Boolean(packet.file), packet.file);
  const brief = briefFor(packet);
  check('the brief carries the structured spec, not just the transcript',
    brief.includes(iv.spec.goal) && brief.includes('Working directory'));

  console.log('\n--- the closing summary ---');
  const goodFacts = {
    projectDir: 'C:\\tmp\\calc', filesTouched: ['calculator.js', 'test.js'],
    testsRun: 1, testsPassed: 1, testsFailed: 0, built: true, errors: 0, outcome: 'success',
  };
  const good = await narrator.summarise({ spec: iv.spec, facts: goodFacts, transcript: 'Built the calculator, all tests pass.' });
  console.log(`  success case: "${good}"`);
  check('the success summary is short enough to speak', good.split(/\s+/).length < 90, `${good.split(/\s+/).length} words`);
  check('the success summary avoids jargon',
    !/\bnpm\b|\.js\b|jest|--|\bcommit\b|\bAPI\b/i.test(good));

  const badFacts = { ...goodFacts, testsRun: 3, testsPassed: 1, testsFailed: 2, errors: 2, outcome: 'success' };
  const bad = await narrator.summarise({ spec: iv.spec, facts: badFacts, transcript: 'Two tests are still failing.' });
  console.log(`  failure case: "${bad}"`);
  check('a run with failing tests is NOT reported as everything working',
    /not|fail|problem|issue|couldn|still|but|didn/i.test(bad), bad);

  // Measured failure: an agent wrote a file, never executed it, and its own
  // closing note claimed "I tested it with hello and got olleh". The spoken
  // summary must not repeat a claim the run does not support (section 36).
  const unrunFacts = {
    projectDir: 'C:\\tmp\\calc', filesTouched: ['calculator.js'],
    commandsRun: 0, testsRun: 0, testsPassed: 0, testsFailed: 0, built: false, errors: 0, outcome: 'success',
  };
  const unrun = await narrator.summarise({
    spec: iv.spec,
    facts: unrunFacts,
    transcript: 'I tested the calculator with a few sums and everything passed, so it works exactly as asked.',
  });
  console.log(`  never-executed case: "${unrun}"`);
  // Phrasing varies run to run ("never actually ran it", "no commands were
  // executed", "it's unverified"), so match the shape: a negation sitting close
  // to a run/test/verify word.
  check('it says plainly that the code was never run',
    /\b(never|not|no|none|haven'?t|hasn'?t|didn'?t|zero|nothing|un)\w*\b[^.!?]{0,70}\b(run|ran|execut\w*|test\w*|verif\w*|built)\b/i.test(unrun), unrun);
  // Two shapes count, and the model picks freely between them: admitting the
  // outcome is unknown, or asking the user to check before relying on it.
  // Matching a fixed phrase list fails honest wordings like "we don't know if
  // it works" — the thing being tested is the stance, not the vocabulary.
  check('it hands the uncertainty to the user instead of asserting success',
    /can'?t (confirm|promise|say|tell)|do(?:n'?t| not) know|not sure|no guarantee|unverified|needs? to be (?:verified|tested|checked|run)|you'?ll need to|you should|before you (?:use|rely|trust)|run it yourself/i.test(unrun), unrun);

  console.log('\n--- rewriting a technical question for a non-engineer ---');
  const q = await narrator.humaniseQuestion(
    'Should persistence use SQLite via better-sqlite3, or flat JSON serialised to disk?',
    ['SQLite', 'JSON']
  );
  console.log(`  "${q}"`);
  check('the question loses its jargon', !/sqlite3|serialis|persistence layer/i.test(q));
  check('the question stays a single short question', q.length < 240 && !q.includes('\n'));

  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n${failed ? 'FAIL' : 'PASS'}: interviewer + narration (${results.length - failed}/${results.length})`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log(`FAIL: ${e.stack}`); process.exit(1); });
