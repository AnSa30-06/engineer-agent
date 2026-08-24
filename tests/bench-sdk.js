/**
 * Where do the ~10 seconds of a tool-less model call actually go?
 * Isolates CLI startup from generation, and tests whether one persistent
 * session can amortise it across a conversation.
 *
 *   node tests/bench-sdk.js
 */
const { execFileSync } = require('child_process');
const { query } = require('@anthropic-ai/claude-agent-sdk');
const { runtime, FAST } = require('../src/main/llm');

const ms = (t) => `${Math.round(t)}ms`;
const bench = async (label, fn) => {
  const t0 = performance.now();
  let note = '';
  try { note = (await fn()) || ''; } catch (e) { note = `ERR ${e.message.slice(0, 60)}`; }
  console.log(`  ${label.padEnd(46)} ${ms(performance.now() - t0).padStart(9)}  ${note}`);
};

async function once(extra) {
  let out = '';
  for await (const m of query({
    prompt: 'Reply with exactly: OK',
    options: { ...runtime(), model: FAST, allowedTools: [], maxTurns: 1, settingSources: [], ...extra },
  })) {
    if (m.type === 'result') out = String(m.result || '').trim();
  }
  return out;
}

(async () => {
  console.log('\n=== how much is just starting the CLI? ===');
  const cli = runtime().pathToClaudeCodeExecutable;
  await bench('claude --version (bare process start)', () => {
    execFileSync(process.execPath, [cli, '--version'], { encoding: 'utf8', timeout: 60000 });
    return 'process spawn + init only';
  });

  console.log('\n=== one-shot query(), varying what the CLI loads ===');
  await bench('baseline', () => once({}));
  await bench('mcp disabled', () => once({ strictMcpConfig: true, mcpServers: {} }));
  await bench('mcp disabled + no plugins', () => once({ strictMcpConfig: true, mcpServers: {}, plugins: [] }));

  console.log('\n=== one persistent session, three turns (streaming input) ===');
  const turns = ['Reply with exactly: ONE', 'Reply with exactly: TWO', 'Reply with exactly: THREE'];
  let idx = 0;
  let resolveNext;
  const gate = () => new Promise((r) => { resolveNext = r; });

  async function* input() {
    for (const t of turns) {
      yield { type: 'user', message: { role: 'user', content: t }, parent_tool_use_id: null, session_id: '' };
      await gate();
    }
  }

  const t0 = performance.now();
  const marks = [];
  let last = t0;
  try {
    for await (const m of query({
      prompt: input(),
      options: { ...runtime(), model: FAST, allowedTools: [], settingSources: [], strictMcpConfig: true, mcpServers: {} },
    })) {
      if (m.type === 'result') {
        const now = performance.now();
        marks.push({ n: ++idx, dt: now - last, text: String(m.result || '').trim().slice(0, 20) });
        last = now;
        if (idx >= turns.length) break;
        resolveNext && resolveNext();
      }
    }
  } catch (e) {
    console.log(`  streaming input failed: ${e.message.slice(0, 120)}`);
  }
  for (const m of marks) {
    console.log(`  turn ${m.n} ${(m.n === 1 ? '(includes startup)' : '(warm)').padEnd(38)} ${ms(m.dt).padStart(9)}  "${m.text}"`);
  }
  if (marks.length > 1) {
    const warm = marks.slice(1).reduce((a, m) => a + m.dt, 0) / (marks.length - 1);
    console.log(`\n  warm turn average: ${ms(warm)}  <- this is what a reused session costs`);
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
