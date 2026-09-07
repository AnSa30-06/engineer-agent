/**
 * Speech to text — local Moonshine (or Whisper) via transformers.js (ONNX/WASM).
 *
 * Runs entirely on this machine. The model is fetched from Hugging Face the
 * first time and then cached, so only the very first run needs the network.
 * If the model cannot be loaded the app says so and the typed box in the
 * control panel remains a working way in (section 32).
 *
 * Utterance detection is a plain energy gate against a measured noise floor —
 * good enough for a desktop mic and far cheaper than a VAD model.
 */
// Bundled at build time by tools/build-vendor.js — see that file for why.
const TRANSFORMERS = './vendor/transformers.mjs';
const WASM_DIR = './vendor/';

const TARGET_RATE = 16000;
const SILENCE_MS = 550;       // trailing silence that ends an utterance
const MIN_SPEECH_MS = 320;    // ignore coughs and clicks
const MAX_UTTERANCE_MS = 20000;

// Barge-in: how long the user must keep talking over him before he stops, and
// how far above the normal speech gate they must be. The margin scales with his
// OWN output level (see the gate below) — echo cancellation removes most of his
// voice from the microphone, but "most" is not "all", and a false barge-in is
// the app interrupting itself mid-sentence for no reason.
const BARGE_MS = 320;
const BARGE_BASE = 1.6;       // multiplier on the gate while he is silent
const BARGE_PER_OUTPUT = 2.4; // added multiplier at his full output volume

export function createSTT({ onText, onStatus, onLevel, onSpeechStart, onSpeechEnd, onBargeIn, getOutputLevel, deviceId, model }) {
  let pipe = null;
  let loading = null;
  let stream = null;
  let ctx = null;
  let node = null;
  let source = null;
  let active = false;
  let watchOnly = false;   // barge-in watch: measure, never transcribe
  let loudMs = 0;

  let buffer = [];
  let speaking = false;
  let speechMs = 0;
  let silenceMs = 0;
  let floor = 0.006;
  let floorSamples = 0;
  let busy = false;
  let loadedName = null;

  const status = (level, human, technical) => onStatus && onStatus({ level, human, technical });

  async function loadModel() {
    if (pipe) return pipe;
    if (loading) return loading;
    loading = (async () => {
      const t = await import(TRANSFORMERS);
      t.env.allowLocalModels = false;
      t.env.useBrowserCache = true;
      t.env.backends.onnx.wasm.wasmPaths = new URL(WASM_DIR, import.meta.url).href;
      t.env.backends.onnx.wasm.numThreads = 1;   // keeps the sprite smooth

      // Measured on this machine, same 4.3s utterance, all 15/15 words correct:
      //   whisper-base.en   5415ms   <- the old default
      //   whisper-tiny.en   2522ms
      //   moonshine-base     758ms   <- current default
      //   moonshine-tiny     371ms
      // Whisper pads every clip to a 30s window whatever its length, which is
      // where its floor comes from; moonshine takes the audio as it is.
      //
      // Every published q4/q8 export fails session creation on onnxruntime-web
      // 1.26.0-dev (MatMulNBits missing its scale), so fp32 throughout.
      const candidates = [
        [model, { dtype: 'fp32' }],
        ['onnx-community/moonshine-tiny-ONNX', { dtype: 'fp32' }],
        ['Xenova/whisper-tiny.en', { dtype: 'fp32' }],
      ];
      let last;
      for (const [name, opts] of candidates) {
        try {
          status('info', null, `loading speech model ${name} ${JSON.stringify(opts)} (first run downloads it once)`);
          pipe = await t.pipeline('automatic-speech-recognition', name, opts);
          loadedName = name;
          status('info', 'Speech recognition is ready.', `model ${name} loaded`);
          return pipe;
        } catch (e) {
          last = e;
          status('warn', null, `speech model ${name} ${JSON.stringify(opts)} unusable: ${String(e.message).slice(0, 120)}`);
        }
      }
      throw last;
    })().catch((e) => {
      loading = null;
      status('error', "I can't hear you — speech recognition failed to start. You can still type to me in my controls.", `STT load failed: ${e.message}`);
      throw e;
    });
    return loading;
  }

  /** Downsample whatever the device gives us to the 16 kHz mono Whisper wants. */
  function resample(input, fromRate) {
    if (fromRate === TARGET_RATE) return input;
    const ratio = fromRate / TARGET_RATE;
    const out = new Float32Array(Math.floor(input.length / ratio));
    for (let i = 0; i < out.length; i++) {
      const pos = i * ratio;
      const j = Math.floor(pos);
      const frac = pos - j;
      out[i] = input[j] * (1 - frac) + (input[Math.min(j + 1, input.length - 1)] || 0) * frac;
    }
    return out;
  }

  async function transcribe(samples) {
    if (busy) return;
    busy = true;
    try {
      const p = await loadModel();
      // English-only (.en) models reject `language`/`task` — measured.
      // chunk_length_s is a whisper notion; moonshine takes the audio as it is.
      const out = await p(samples, /moonshine/i.test(loadedName || '') ? {} : { chunk_length_s: 30 });
      const text = String((out && out.text) || '').trim();
      // Whisper emits these for silence; they are not something the user said.
      if (text && !/^[\s.,!?]*$/.test(text) && !/^\(?\[?(blank_audio|silence|music|inaudible)\]?\)?$/i.test(text)) {
        status('info', null, `heard: ${text}`);
        onText(text);
      }
    } catch (e) {
      status('error', null, `transcription failed: ${e.message}`);
    } finally {
      busy = false;
    }
  }

  function flush() {
    const samples = buffer.length ? concat(buffer) : null;
    const long = samples && samples.length > (TARGET_RATE * MIN_SPEECH_MS) / 1000;
    buffer = [];
    speaking = false;
    speechMs = 0;
    silenceMs = 0;
    // tell the UI the turn is over before transcription starts, so the user
    // knows they were heard instead of wondering whether to repeat themselves
    if (long && onSpeechEnd) onSpeechEnd();
    if (long) transcribe(samples);
  }

  function concat(chunks) {
    const total = chunks.reduce((a, c) => a + c.length, 0);
    const out = new Float32Array(total);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }

  async function start() {
    watchOnly = false;
    loudMs = 0;
    if (active) return;
    active = true;
    loadModel().catch(() => {});   // warm up while the user is still being greeted
    try {
      if (!stream) {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: deviceId ? { exact: deviceId } : undefined,
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
      }
      if (!ctx) {
        ctx = new AudioContext();
        source = ctx.createMediaStreamSource(stream);
        node = ctx.createScriptProcessor(4096, 1, 1);
        node.onaudioprocess = (e) => {
          if (!active) return;
          const raw = e.inputBuffer.getChannelData(0);
          const chunk = resample(Float32Array.from(raw), ctx.sampleRate);
          const ms = (chunk.length / TARGET_RATE) * 1000;

          let sum = 0;
          for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
          const rms = Math.sqrt(sum / chunk.length);

          // first ~1s establishes the room's noise floor
          if (floorSamples < 12) { floor = floor * 0.7 + rms * 0.3; floorSamples++; return; }
          const threshold = Math.max(0.012, floor * 3.2);

          // drive the on-screen level meter, normalised against the gate
          if (onLevel) onLevel(Math.max(0, Math.min(1, rms / (threshold * 4))));

          // Barge-in watch: he is talking, so we measure only. Nothing is
          // buffered and nothing is transcribed, which is what makes it safe —
          // if echo cancellation lets his voice through, the worst case is a
          // spurious interruption, never his own words fed back as input.
          if (watchOnly) {
            const out = typeof getOutputLevel === 'function' ? Math.max(0, Math.min(1, getOutputLevel() || 0)) : 0;
            const gate = threshold * (BARGE_BASE + BARGE_PER_OUTPUT * out);
            if (rms > gate) {
              loudMs += ms;
              if (loudMs >= BARGE_MS) { loudMs = 0; if (onBargeIn) onBargeIn(); }
            } else {
              loudMs = Math.max(0, loudMs - ms);   // a single loud frame is a door, not a person
            }
            return;
          }

          if (rms > threshold) {
            if (!speaking && onSpeechStart) onSpeechStart();
            speaking = true;
            silenceMs = 0;
            speechMs += ms;
            buffer.push(chunk);
          } else if (speaking) {
            silenceMs += ms;
            buffer.push(chunk);          // keep a little tail for the decoder
            if (silenceMs >= SILENCE_MS) flush();
          }
          if (speechMs >= MAX_UTTERANCE_MS) flush();
        };
        source.connect(node);
        // ScriptProcessor only runs when connected to a destination; a zero gain
        // node keeps the microphone out of the speakers.
        const mute = ctx.createGain();
        mute.gain.value = 0;
        node.connect(mute);
        mute.connect(ctx.destination);
      }
      if (ctx.state === 'suspended') await ctx.resume();
    } catch (e) {
      active = false;
      status('error', "I can't reach your microphone. Check Windows microphone permissions — you can also type to me in my controls.", `getUserMedia failed: ${e.message}`);
    }
  }

  /** Listen only for the user talking OVER him, so he can be interrupted. */
  async function watch() {
    loudMs = 0;
    if (active) { watchOnly = true; return; }
    await start();
    watchOnly = true;
  }

  function stop() {
    active = false;
    watchOnly = false;
    loudMs = 0;
    buffer = [];
    speaking = false;
    speechMs = 0;
    silenceMs = 0;
  }

  return { start, stop, watch, get ready() { return !!pipe; } };
}
