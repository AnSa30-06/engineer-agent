const { ipcRenderer } = require('electron');
window.report = (payload) => ipcRenderer.send('report', payload);
