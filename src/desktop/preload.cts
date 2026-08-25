import type { DesktopApi, DesktopEvent } from './contracts.js';

const { contextBridge, ipcRenderer, webUtils } = require('electron') as typeof import('electron');

const CHANNELS = {
  systemInfo: 'system:info',
  doctor: 'system:doctor',
  chooseWorkspace: 'workspace:choose',
  chooseBinary: 'binary:choose',
  chooseAttachments: 'attachments:choose',
  inspectAttachments: 'attachments:inspect',
  listRuns: 'runs:list',
  getRun: 'runs:get',
  startRun: 'runs:start',
  attachRun: 'runs:attach',
  resumeRun: 'runs:resume',
  pauseRun: 'runs:pause',
  listThreads: 'threads:list',
  listSessions: 'sessions:list',
  event: 'runs:event',
} as const;

const api: DesktopApi = {
  systemInfo: () => ipcRenderer.invoke(CHANNELS.systemInfo),
  doctor: (input) => ipcRenderer.invoke(CHANNELS.doctor, input),
  chooseWorkspace: () => ipcRenderer.invoke(CHANNELS.chooseWorkspace),
  chooseBinary: () => ipcRenderer.invoke(CHANNELS.chooseBinary),
  chooseAttachments: () => ipcRenderer.invoke(CHANNELS.chooseAttachments),
  inspectAttachments: (paths) => ipcRenderer.invoke(CHANNELS.inspectAttachments, paths),
  pathForFile: (file) => webUtils.getPathForFile(file) || null,
  listRuns: () => ipcRenderer.invoke(CHANNELS.listRuns),
  getRun: (runId) => ipcRenderer.invoke(CHANNELS.getRun, runId),
  startRun: (input) => ipcRenderer.invoke(CHANNELS.startRun, input),
  attachRun: (input) => ipcRenderer.invoke(CHANNELS.attachRun, input),
  resumeRun: (input) => ipcRenderer.invoke(CHANNELS.resumeRun, input),
  pauseRun: (runId) => ipcRenderer.invoke(CHANNELS.pauseRun, runId),
  listThreads: (input) => ipcRenderer.invoke(CHANNELS.listThreads, input),
  listSessions: (input) => ipcRenderer.invoke(CHANNELS.listSessions, input),
  onEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: DesktopEvent): void => listener(payload);
    ipcRenderer.on(CHANNELS.event, handler);
    return () => ipcRenderer.removeListener(CHANNELS.event, handler);
  },
};

contextBridge.exposeInMainWorld('codexInfinite', api);
