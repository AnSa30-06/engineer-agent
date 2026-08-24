/**
 * Integration test for the speech-to-text path.
 *
 * Microphone hardware cannot be driven from a test, so the seam is the audio
 * buffer: Edge TTS speaks a known sentence, the renderer decodes it exactly as
 * it would decode microphone samples, and Whisper transcribes it. That
 * exercises everything except the physical mic — the model, the wasm runtime,
 * the resampling and the decoder.
 *
 *   npx electron tests/stt-roundtrip.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const tts = require('../src/main/tts');

const PHRASE = 'Build me a calculator with a dark theme.';
const KEYWORDS = ['calculator', 'dark'];
const VENDOR = path.join(__dirname, '..', 'src', 'sprite', 'vendor');

const pageHtml = (mp3b64) => `<!doctype html>
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; connect-src 'self' file: blob: data: https://huggingface.co https://*.huggingface.co https://*.hf.co;">
<body><script type="module">
const MP3 = "${mp3b64}";
const VENDOR = "${`file:///${VENDOR.replace(/\\/g, '/')}/`}";
try {
  const t = await import(VENDOR + 'transformers.mjs');
  t.env.allowLocalModels = false;
  t.env.useBrowserCache = true;
  t.env.backends.onnx.wasm.wasmPaths = VENDOR;
  t.env.backends.onnx.wasm.numThreads = 1;

  const bytes = Uint8Array.from(atob(MP3), c => c.charCodeAt(0));
  const ac = new AudioContext({ sampleRate: 16000 });
  const decoded = await ac.decodeAudioData(bytes.buffer);
  const samples = decoded.getChannelData(0);

  const pipe = await t.pipeline('automatic-speech-recognition', 'Xenova/whisper-base.en', { dtype: 'fp32' });
  const out = await pipe(samples, { chunk_length_s: 30 });
  window.report({ ok: true, msg: String(out.text || '').trim(), seconds: decoded.duration });
} catch (e) {
  window.report({ ok: false, msg: e.message });
}
</script></body>`;

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

app.whenReady().then(async () => {
  let audio;
  try {
    audio = (await tts.speak(PHRASE)).audio;
    console.log(`TTS produced ${audio.length} bytes of mp3 for: "${PHRASE}"`);
  } catch (e) {
    console.log(`FAIL: TTS could not produce test audio: ${e.message}`);
    return app.exit(1);
  }

  const page = path.join(os.tmpdir(), 'engineer-stt-test.html');
  fs.writeFileSync(page, pageHtml(audio.toString('base64')));

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'stt-preload.js'),
      contextIsolation: false,
      nodeIntegration: false,
    },
  });

  ipcMain.on('report', (_e, { ok, msg, seconds }) => {
    if (!ok) { console.log(`FAIL: ${msg}`); return app.exit(1); }
    const heard = msg.toLowerCase().replace(/[^a-z ]/g, ' ');
    const hit = KEYWORDS.filter((w) => heard.includes(w));
    console.log(`decoded audio: ${(seconds || 0).toFixed(2)}s`);
    console.log(`spoken:      "${PHRASE}"`);
    console.log(`transcribed: "${msg}"`);
    console.log(`key words found: ${hit.length}/${KEYWORDS.length} (${hit.join(', ')})`);
    const pass = hit.length === KEYWORDS.length;
    console.log(pass ? 'PASS: speech-to-text round trip' : 'FAIL: transcript missed key words');
    app.exit(pass ? 0 : 1);
  });

  win.webContents.on('console-message', (e) => console.log(`  [page] ${e.message}`));
  setTimeout(() => { console.log('FAIL: timed out'); app.exit(1); }, 300000);
  await win.loadFile(page);
});
