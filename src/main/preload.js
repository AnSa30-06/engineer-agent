const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('engineer', {
  bootstrap: () => ipcRenderer.invoke('bootstrap'),

  // sprite -> main
  spriteReady: () => ipcRenderer.send('sprite-ready'),
  entranceDone: () => ipcRenderer.send('entrance-done'),
  speechEnded: (id) => ipcRenderer.send('speech-ended', { id }),
  userSaid: (text) => ipcRenderer.send('user-said', { text }),
  bargeIn: () => ipcRenderer.send('barge-in'),
  sttStatus: (s) => ipcRenderer.send('stt-status', s),
  togglePanel: () => ipcRenderer.send('toggle-panel'),
  answerCall: () => ipcRenderer.send('answer-call'),

  // panel -> main
  answerDecision: (id, answer) => ipcRenderer.send('answer-decision', { id, answer }),
  say: (text) => ipcRenderer.send('say', { text }),
  control: (action) => ipcRenderer.send('control', { action }),
  setConfig: (patch) => ipcRenderer.invoke('set-config', patch),
  pickDir: () => ipcRenderer.invoke('pick-dir'),
  listVoices: () => ipcRenderer.invoke('list-voices'),
  openPath: (which) => ipcRenderer.send('open-path', { which }),
  quit: () => ipcRenderer.send('quit'),

  // main -> renderers
  onState: on('state'),
  onLog: on('log'),
  onSpeakBegin: on('speak-begin'),
  onSpeakChunk: on('speak-chunk'),
  onStopAudio: on('stop-audio'),
  onCaption: on('caption'),
  onRing: on('ring'),
  onListen: on('listen'),
  onConfig: on('config'),
  onDecision: on('decision'),
  onDecisionResolved: on('decision-resolved'),
});
