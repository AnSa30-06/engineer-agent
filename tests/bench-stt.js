/**
 * Which speech model and backend should the app default to?
 * Measures load time, transcription time and accuracy on real speech.
 *
 *   npx electron tests/bench-stt.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const tts = require('../src/main/tts');

const PHRASE = 'Can you build me a small calculator app with a dark theme and keyboard support?';
const VENDOR = path.join(__dirname, '..', 'src', 'sprite', 'vendor');

const page = (mp3) => `<!doctype html>
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; connect-src 'self' file: blob: data: https://huggingface.co https://*.huggingface.co https://*.hf.co;">
<body><script type="module">
const V = "${`file:///${VENDOR.replace(/\\/g, '/')}/`}";
const t = await import(V + 'transformers.mjs');
t.env.allowLocalModels = false; t.env.useBrowserCache = true;
t.env.backends.onnx.wasm.wasmPaths = V; t.env.backends.onnx.wasm.numThreads = 1;

const bytes = Uint8Array.from(atob("${mp3}"), c => c.charCodeAt(0));
const ac = new AudioContext({ sampleRate: 16000 });
const samples = (await ac.decodeAudioData(bytes.buffer)).getChannelData(0);

let webgpu = false;
try { webgpu = !!(navigator.gpu && await navigator.gpu.requestAdapter()); } catch {}
window.report({ kind: 'info', webgpu, seconds: samples.length / 16000 });

const combos = [
  ['Xenova/whisper-tiny.en',  { dtype: 'fp32' }],
  // Moonshine takes variable-length audio instead of padding every clip to a
  // 30s window the way whisper does, which is where whisper's floor comes from.
  ['onnx-community/moonshine-tiny-ONNX', { dtype: 'fp32' }],
  ['onnx-community/moonshine-base-ONNX', { dtype: 'fp32' }],
];
if (webgpu) {
  combos.push(['onnx-community/moonshine-tiny-ONNX', { dtype: 'fp32', device: 'webgpu' }]);
}

for (const [name, opts] of combos) {
  const label = name.split('/')[1] + ' ' + (opts.device || 'wasm');
  try {
    const t0 = performance.now();
    const pipe = await t.pipeline('automatic-speech-recognition', name, opts);
    const loaded = performance.now() - t0;
    const runs = [];
    for (let i = 0; i < 3; i++) {
      const s = performance.now();
      var out = await pipe(samples, { chunk_length_s: 30 });
      runs.push(performance.now() - s);
    }
    window.report({ kind: 'result', label, loaded, runs, text: String(out.text || '').trim() });
  } catch (e) {
    window.report({ kind: 'result', label, error: e.message.slice(0, 90) });
  }
}
window.report({ kind: 'done' });
</script></body>`;

app.whenReady().then(async () => {
  const audio = (await tts.speak(PHRASE)).audio;
  const file = path.join(os.tmpdir(), 'engineer-bench-stt.html');
  fs.writeFileSync(file, page(audio.toString('base64')));

  const win = new BrowserWindow({
    show: false,
    webPreferences: { preload: path.join(__dirname, 'stt-preload.js'), contextIsolation: false, nodeIntegration: false },
  });

  const want = PHRASE.toLowerCase().replace(/[^a-z ]/g, '').split(/\s+/);
  ipcMain.on('report', (_e, r) => {
    if (r.kind === 'info') {
      console.log(`audio: ${r.seconds.toFixed(2)}s of speech`);
      console.log(`WebGPU available: ${r.webgpu}\n`);
      console.log('model / backend        load      run (median of 3)   accuracy');
      return;
    }
    if (r.kind === 'done') { console.log('\n(run times are for a ~5s utterance; whisper always pads to a 30s window)'); return app.exit(0); }
    if (r.error) { console.log(`${r.label.padEnd(22)} ERROR ${r.error}`); return; }
    const med = r.runs.sort((a, b) => a - b)[1];
    const got = r.text.toLowerCase().replace(/[^a-z ]/g, '').split(/\s+/);
    const hit = want.filter((w) => got.includes(w)).length;
    console.log(`${r.label.padEnd(22)} ${(Math.round(r.loaded) + 'ms').padStart(7)}  ${(Math.round(med) + 'ms').padStart(8)}          ${hit}/${want.length} words`);
    console.log(`${' '.repeat(22)} "${r.text}"`);
  });

  setTimeout(() => { console.log('timed out'); app.exit(1); }, 600000);
  await win.loadFile(file);
});
