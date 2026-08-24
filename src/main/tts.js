/**
 * Text to speech via Microsoft Edge's free neural voices (en-US-AndrewNeural).
 *
 * Requires an internet connection — Edge synthesises server-side. This is the
 * one part of the app that is not offline, and README says so plainly.
 *
 * The whole surface is speak() + listVoices(); swap this file to change engines
 * without touching the agent, the sprite, or the state machine.
 */
const crypto = require('crypto');
// Node's global WebSocket silently drops custom headers, and Edge rejects the
// handshake without an Origin. Measured, hence the one dependency.
const WebSocketClient = require('ws');

const TRUSTED_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const WSS =
  'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=' +
  TRUSTED_TOKEN;
const VOICES_URL =
  'https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=' +
  TRUSTED_TOKEN;
// Edge rejects the socket when this string goes stale (measured: 131 -> 403,
// 140 -> OK). Tried in order, so a bump outlives one hard-coded version.
const CHROME_VERSIONS = ['140.0.3485.14', '131.0.2903.99'];
let CHROME = CHROME_VERSIONS[0];
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  `Chrome/${CHROME.split('.')[0]}.0.0.0 Safari/537.36 Edg/${CHROME.split('.')[0]}.0.0.0`;

const DEFAULT_VOICE = 'en-US-AndrewNeural';

/** Edge requires a rolling token derived from the clock, rounded to 5 minutes. */
function secMsGec() {
  let ticks = Math.floor(Date.now() / 1000) + 11644473600;
  ticks -= ticks % 300;
  ticks *= 1e9 / 100;
  return crypto.createHash('sha256').update(`${ticks.toFixed(0)}${TRUSTED_TOKEN}`).digest('hex').toUpperCase();
}

const stamp = () => new Date().toISOString().replace('T', ' ').replace('Z', 'Z');
const xmlEscape = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function endpoint(chrome = CHROME) {
  return `${WSS}&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=1-${chrome}&ConnectionId=${crypto.randomUUID().replace(/-/g, '')}`;
}

const SOCKET_OPTS = {
  headers: {
    Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
    'User-Agent': UA,
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
  },
};

/**
 * @returns {Promise<{audio: Buffer, format: string, words: {text,offset,duration}[]}>}
 *          audio is mp3. `words` come from Edge's word-boundary metadata and are
 *          used for nothing but diagnostics — the mouth is driven by amplitude.
 */
function synth(text, chrome, { voice = DEFAULT_VOICE, rate = '+0%', pitch = '+0Hz', volume = '+0%', timeout = 20000 } = {}) {
  const clean = String(text || '').trim();
  if (!clean) return Promise.resolve({ audio: Buffer.alloc(0), format: 'audio/mpeg', words: [] });

  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocketClient(endpoint(chrome), SOCKET_OPTS);
    } catch (e) {
      return reject(new Error(`TTS socket failed: ${e.message}`));
    }
    ws.binaryType = 'nodebuffer';

    const chunks = [];
    const words = [];
    const requestId = crypto.randomUUID().replace(/-/g, '');
    let settled = false;

    const timer = setTimeout(() => finish(new Error('TTS timed out')), timeout);
    function finish(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* already closing */ }
      err ? reject(err) : resolve(value);
    }

    ws.onopen = () => {
      ws.send(
        `X-Timestamp:${stamp()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
          JSON.stringify({
            context: {
              synthesis: {
                audio: {
                  metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'true' },
                  outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
                },
              },
            },
          })
      );
      ws.send(
        `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${stamp()}\r\nPath:ssml\r\n\r\n` +
          `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
          `<voice name='${voice}'><prosody pitch='${pitch}' rate='${rate}' volume='${volume}'>` +
          `${xmlEscape(clean)}</prosody></voice></speak>`
      );
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        if (ev.data.includes('Path:turn.end')) {
          finish(null, { audio: Buffer.concat(chunks), format: 'audio/mpeg', words });
        } else if (ev.data.includes('Path:audio.metadata')) {
          const body = ev.data.slice(ev.data.indexOf('\r\n\r\n') + 4);
          try {
            for (const m of JSON.parse(body).Metadata || []) {
              if (m.Type === 'WordBoundary') {
                words.push({ text: m.Data.text.Text, offset: m.Data.Offset, duration: m.Data.Duration });
              }
            }
          } catch { /* metadata is optional */ }
        }
        return;
      }
      // binary frame: [2-byte big-endian header length][header][audio]
      const buf = Buffer.from(ev.data);
      if (buf.length < 2) return;
      const headerLen = buf.readUInt16BE(0);
      const header = buf.subarray(2, 2 + headerLen).toString('utf8');
      if (header.includes('Path:audio')) chunks.push(buf.subarray(2 + headerLen));
    };

    ws.onerror = () => finish(new Error('TTS connection failed (Edge TTS needs internet access)'));
    ws.onclose = () => {
      if (chunks.length) finish(null, { audio: Buffer.concat(chunks), format: 'audio/mpeg', words });
      else finish(new Error('TTS closed before any audio arrived'));
    };
  });
}

/** Public entry point: try each known client version until one is accepted. */
async function speak(text, opts = {}) {
  let last;
  for (const v of CHROME_VERSIONS) {
    try {
      const out = await synth(text, v, opts);
      CHROME = v; // remember the one that worked for the rest of the session
      return out;
    } catch (e) { last = e; }
  }
  throw last || new Error('TTS failed');
}

/** English neural voices, for the voice picker in settings. */
async function listVoices() {
  const res = await fetch(`${VOICES_URL}&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=1-${CHROME}`, {
    headers: SOCKET_OPTS.headers,
  });
  if (!res.ok) throw new Error(`voice list failed: ${res.status}`);
  return (await res.json())
    .filter((v) => v.Locale.startsWith('en-'))
    .map((v) => ({ name: v.ShortName, gender: v.Gender, locale: v.Locale }));
}

module.exports = { speak, listVoices, DEFAULT_VOICE };
