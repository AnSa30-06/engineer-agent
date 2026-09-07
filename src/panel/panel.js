/* Control panel: progress log (simple / detailed), pending decisions,
   settings, and the interruption controls. */

const $ = (id) => document.getElementById(id);
const logEl = $('log');
const stateEl = $('state');
const dotEl = $('dot');

let mode = 'human';
let entries = [];
let pending = [];
let config = {};

const STATE_COLOUR = {
  ERROR: '#FF7A63', WAITING_FOR_USER: '#FFC65C', PHONE_RINGING: '#FFC65C',
  ON_CALL: '#FFC65C', COMPLETED: '#5BE3B0', WORKING: '#7FB4FF', TESTING: '#7FB4FF',
};

const PRETTY = {
  STARTING: 'starting up', ENTERING: 'arriving', IDLE: 'ready', LISTENING: 'listening',
  THINKING: 'thinking', SPEAKING: 'talking', PHONE_RINGING: 'phone ringing',
  ON_CALL: 'on the phone', HANDOFF: 'getting started', WORKING: 'building',
  TESTING: 'testing', WAITING_FOR_USER: 'waiting for you', COMPLETED: 'finished', ERROR: 'hit a problem',
};

const time = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function visible(e) {
  return mode === 'tech' ? (e.technical || e.human) : e.human;
}

function render() {
  const atBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 40;
  logEl.classList.toggle('tech', mode === 'tech');
  logEl.replaceChildren(
    ...entries.filter(visible).map((e) => {
      const row = document.createElement('div');
      row.className = `entry ${e.level}`;
      const t = document.createElement('time');
      t.textContent = time(e.at);
      const m = document.createElement('div');
      m.className = 'msg';
      if (mode === 'tech') {
        const k = document.createElement('div');
        k.className = 'kind';
        k.textContent = e.kind;
        m.appendChild(k);
        m.appendChild(document.createTextNode(e.technical || e.human));
      } else {
        m.textContent = e.human;
      }
      row.append(t, m);
      return row;
    })
  );
  if (atBottom) logEl.scrollTop = logEl.scrollHeight;
}

function renderDecisions() {
  $('decisions').classList.toggle('hidden', pending.length === 0);
  $('decision-list').replaceChildren(
    ...pending.map((d) => {
      const box = document.createElement('div');
      box.className = 'decision';
      const q = document.createElement('p');
      q.textContent = d.question;
      box.appendChild(q);

      if (d.options && d.options.length) {
        const opts = document.createElement('div');
        opts.className = 'opts';
        for (const o of d.options) {
          const b = document.createElement('button');
          b.textContent = o;
          b.onclick = () => window.engineer.answerDecision(d.id, o);
          opts.appendChild(b);
        }
        box.appendChild(opts);
      }

      const row = document.createElement('div');
      row.className = 'row';
      const input = document.createElement('input');
      input.placeholder = 'Or answer in your own words…';
      const send = document.createElement('button');
      send.textContent = 'Answer';
      const submit = () => { if (input.value.trim()) window.engineer.answerDecision(d.id, input.value.trim()); };
      send.onclick = submit;
      input.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
      row.append(input, send);
      box.appendChild(row);
      return box;
    })
  );
}

function applyState(state) {
  stateEl.textContent = PRETTY[state] || state.toLowerCase();
  dotEl.style.background = STATE_COLOUR[state] || '#5BE3B0';
  $('pause').classList.toggle('hidden', state === 'WORKING' ? false : false);
}

function fillConfig(c) {
  config = c;
  $('projectDir').value = c.projectDir || '';
  $('permissionMode').value = c.permissionMode || 'standard';
  $('ringSeconds').value = c.ringSeconds ?? 25;
  $('apiKey').value = c.apiKey || '';
  const v = $('voice');
  if (!v.options.length) {
    const o = document.createElement('option');
    o.value = c.voice; o.textContent = c.voice;
    v.appendChild(o);
  }
  v.value = c.voice;
}

// --- boot ------------------------------------------------------------------
(async function boot() {
  const info = await window.engineer.bootstrap();
  entries = info.log;
  pending = info.pending;
  fillConfig(info.config);
  applyState(info.state);
  render();
  renderDecisions();

  window.engineer.listVoices().then((voices) => {
    if (!voices.length) return;
    const v = $('voice');
    v.replaceChildren(...voices.map((x) => {
      const o = document.createElement('option');
      o.value = x.name;
      o.textContent = `${x.name.replace(/^en-[A-Z]{2}-/, '').replace(/Neural$/, '')} (${x.locale}, ${x.gender})`;
      return o;
    }));
    v.value = config.voice;
  });

  navigator.mediaDevices.enumerateDevices().then((devs) => {
    const mics = devs.filter((d) => d.kind === 'audioinput');
    const sel = $('mic');
    sel.replaceChildren(...[{ deviceId: '', label: 'System default' }, ...mics].map((d) => {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || 'Microphone';
      return o;
    }));
    sel.value = config.micDeviceId || '';
  }).catch(() => {});
})();

// --- events ----------------------------------------------------------------
window.engineer.onLog((e) => { entries.push(e); if (entries.length > 2000) entries.shift(); render(); });
window.engineer.onState(({ state }) => applyState(state));
window.engineer.onConfig(fillConfig);
window.engineer.onDecision((d) => { pending.push(d); renderDecisions(); });
window.engineer.onDecisionResolved((d) => { pending = pending.filter((p) => p.id !== d.id); renderDecisions(); });

for (const r of document.querySelectorAll('input[name=mode]')) {
  r.onchange = () => { mode = r.value; render(); };
}
for (const b of document.querySelectorAll('#tabs button')) {
  b.onclick = () => {
    document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
    $('tab-log').classList.toggle('hidden', b.dataset.tab !== 'log');
    $('tab-settings').classList.toggle('hidden', b.dataset.tab !== 'settings');
    $('tab-health').classList.toggle('hidden', b.dataset.tab !== 'health');
  };
}

$('clearfilter').onclick = () => { logEl.scrollTop = logEl.scrollHeight; };
$('hide').onclick = () => window.close();
$('quit').onclick = () => window.engineer.quit();
$('pickDir').onclick = () => window.engineer.pickDir();
$('openConfig').onclick = () => window.engineer.openPath('config');
$('openProject').onclick = () => window.engineer.openPath('project');

$('permissionMode').onchange = (e) => window.engineer.setConfig({ permissionMode: e.target.value });
$('voice').onchange = (e) => window.engineer.setConfig({ voice: e.target.value });
$('mic').onchange = (e) => window.engineer.setConfig({ micDeviceId: e.target.value });
$('ringSeconds').onchange = (e) => window.engineer.setConfig({ ringSeconds: Number(e.target.value) || 25 });
$('apiKey').onchange = (e) => window.engineer.setConfig({ apiKey: e.target.value.trim() });

const send = () => {
  const t = $('typed').value.trim();
  if (!t) return;
  $('typed').value = '';
  window.engineer.say(t);
};
$('send').onclick = send;
$('typed').onkeydown = (e) => { if (e.key === 'Enter') send(); };

$('stopSpeak').onclick = () => window.engineer.control('stop-speaking');

// --- health check -----------------------------------------------------------
const HEALTH_WORD = { ok: 'OK', warn: 'Check', fail: 'Problem', unknown: 'Not known' };

$('runDoctor').onclick = async () => {
  const btn = $('runDoctor');
  btn.disabled = true;
  // Timing the agent program means really starting it, which is the slow part.
  btn.textContent = 'Checking…';
  $('health').innerHTML = '';
  try {
    const findings = await window.engineer.runDoctor();
    $('health').innerHTML = '';
    for (const f of findings) {
      const row = document.createElement('div');
      row.className = `finding ${f.status}`;
      const name = document.createElement('b');
      name.textContent = f.name;
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = HEALTH_WORD[f.status] || f.status;
      const detail = document.createElement('div');
      detail.className = 'detail';
      detail.textContent = f.detail || '';
      row.append(tag, name, detail);
      if (f.fix) {
        const fix = document.createElement('div');
        fix.className = 'fix';
        fix.textContent = f.fix;
        row.append(fix);
      }
      $('health').append(row);
    }
  } catch (e) {
    $('health').textContent = `The check itself failed: ${e.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run the check';
  }
};
$('pause').onclick = () => { window.engineer.control('pause'); $('pause').classList.add('hidden'); $('resume').classList.remove('hidden'); };
$('resume').onclick = () => { window.engineer.control('resume'); $('resume').classList.add('hidden'); $('pause').classList.remove('hidden'); };
$('cancel').onclick = () => window.engineer.control('cancel');
