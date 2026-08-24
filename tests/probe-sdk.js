// Probe: which Claude CLI can this machine actually run the Agent SDK through?
const { query } = require('@anthropic-ai/claude-agent-sdk');
const { execSync } = require('child_process');

function systemClaude() {
  try {
    const p = execSync('where claude', { encoding: 'utf8' }).split(/\r?\n/).find((x) => x.trim());
    return p && p.trim();
  } catch { return null; }
}

async function tryOne(label, opts) {
  process.stdout.write(`${label.padEnd(28)} `);
  try {
    for await (const m of query({
      prompt: 'Reply with exactly: PONG',
      options: { model: 'claude-haiku-4-5-20251001', allowedTools: [], maxTurns: 1, settingSources: [], ...opts },
    })) {
      if (m.type === 'result') { console.log(`${m.subtype}: ${JSON.stringify(m.result)}`); return m.subtype === 'success'; }
    }
    console.log('no result');
  } catch (e) {
    console.log(`FAILED: ${e.message}`);
  }
  return false;
}

(async () => {
  const sys = systemClaude();
  console.log(`system claude: ${sys || '(none on PATH)'}\n`);
  const a = await tryOne('bundled SDK cli', {});
  const b = sys ? await tryOne('system claude binary', { pathToClaudeCodeExecutable: sys }) : false;
  console.log(`\nusable: ${[a && 'bundled', b && 'system'].filter(Boolean).join(', ') || 'NONE'}`);
  process.exit(a || b ? 0 : 1);
})();
