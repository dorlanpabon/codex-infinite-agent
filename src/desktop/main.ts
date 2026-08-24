import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  protocol,
  session,
  type IpcMainInvokeEvent,
} from 'electron';
import squirrelStartup from 'electron-squirrel-startup';
import { errorMessage } from '../errors.js';
import { sanitizeLog, type Logger } from '../log.js';
import { doctorDesktop, listDesktopThreads } from '../operations.js';
import { listRuns, loadRun } from '../state.js';
import {
  DESKTOP_ORIGIN,
  parseDoctorInput,
  parseResumeRunInput,
  parseRunId,
  parseStartRunInput,
  parseThreadsInput,
  type DesktopEvent,
  type LogLevel,
} from './contracts.js';
import { RunManager } from './run-manager.js';

const CHANNELS = {
  systemInfo: 'system:info',
  doctor: 'system:doctor',
  chooseWorkspace: 'workspace:choose',
  chooseBinary: 'binary:choose',
  listRuns: 'runs:list',
  getRun: 'runs:get',
  startRun: 'runs:start',
  resumeRun: 'runs:resume',
  pauseRun: 'runs:pause',
  listThreads: 'threads:list',
  event: 'runs:event',
} as const;

const desktopRoot = path.dirname(fileURLToPath(import.meta.url));
const rendererFiles = new Map<string, { file: string; contentType: string }>([
  ['/', { file: 'renderer/index.html', contentType: 'text/html; charset=utf-8' }],
  ['/index.html', { file: 'renderer/index.html', contentType: 'text/html; charset=utf-8' }],
  ['/app.css', { file: 'renderer/app.css', contentType: 'text/css; charset=utf-8' }],
  ['/app.js', { file: 'renderer/app.js', contentType: 'text/javascript; charset=utf-8' }],
  ['/contracts.js', { file: 'contracts.js', contentType: 'text/javascript; charset=utf-8' }],
]);

let mainWindow: BrowserWindow | null = null;
let allowQuit = false;
let stopping = false;

protocol.registerSchemesAsPrivileged([{
  scheme: 'codex-infinite',
  privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false },
}]);
app.enableSandbox();

function sendEvent(event: DesktopEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(CHANNELS.event, event);
}

const runManager = new RunManager(sendEvent);

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const senderUrl = event.senderFrame?.url;
  if (!mainWindow || event.sender !== mainWindow.webContents || typeof senderUrl !== 'string'
    || !senderUrl.startsWith(`${DESKTOP_ORIGIN}/`)) {
    throw new TypeError('Origen IPC no autorizado.');
  }
}

function ipcLogger(operationId: string): Logger {
  const publish = (level: LogLevel, message: string): void => sendEvent({
    type: 'log',
    operationId,
    level,
    message: sanitizeLog(message),
    timestamp: new Date().toISOString(),
  });
  return {
    info: (message) => publish('info', message),
    warn: (message) => publish('warn', message),
    error: (message) => publish('error', message),
    debug: (message) => publish('debug', message),
  };
}

function registerHandlers(): void {
  ipcMain.handle(CHANNELS.systemInfo, (event) => {
    assertTrustedSender(event);
    return { platform: process.platform, arch: process.arch, version: app.getVersion() };
  });
  ipcMain.handle(CHANNELS.doctor, async (event, raw: unknown) => {
    assertTrustedSender(event);
    const input = parseDoctorInput(raw);
    return doctorDesktop(input.workspace, input.binary, ipcLogger('doctor'));
  });
  ipcMain.handle(CHANNELS.chooseWorkspace, async (event) => {
    assertTrustedSender(event);
    const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle(CHANNELS.chooseBinary, async (event) => {
    assertTrustedSender(event);
    const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openFile'] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle(CHANNELS.listRuns, async (event) => {
    assertTrustedSender(event);
    return listRuns();
  });
  ipcMain.handle(CHANNELS.getRun, async (event, raw: unknown) => {
    assertTrustedSender(event);
    return loadRun(parseRunId(raw));
  });
  ipcMain.handle(CHANNELS.startRun, (event, raw: unknown) => {
    assertTrustedSender(event);
    return runManager.start(parseStartRunInput(raw));
  });
  ipcMain.handle(CHANNELS.resumeRun, (event, raw: unknown) => {
    assertTrustedSender(event);
    return runManager.resume(parseResumeRunInput(raw));
  });
  ipcMain.handle(CHANNELS.pauseRun, (event, raw: unknown) => {
    assertTrustedSender(event);
    return runManager.pause(parseRunId(raw));
  });
  ipcMain.handle(CHANNELS.listThreads, async (event, raw: unknown) => {
    assertTrustedSender(event);
    const input = parseThreadsInput(raw);
    return listDesktopThreads(input.workspace, input.limit, input.binary, ipcLogger('threads'));
  });
}

async function registerRendererProtocol(): Promise<void> {
  await protocol.handle('codex-infinite', async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'app') return new Response('Not found', { status: 404 });
    const resource = rendererFiles.get(url.pathname);
    if (!resource) return new Response('Not found', { status: 404 });
    try {
      const bytes = await readFile(path.join(desktopRoot, resource.file));
      return new Response(bytes, {
        status: 200,
        headers: {
          'Content-Type': resource.contentType,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    } catch (error) {
      return new Response(sanitizeLog(errorMessage(error)), { status: 500 });
    }
  });
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1380,
    height: 860,
    minWidth: 920,
    minHeight: 640,
    show: false,
    backgroundColor: '#0b0d0c',
    title: 'Codex Infinite',
    webPreferences: {
      preload: path.join(path.dirname(fileURLToPath(import.meta.url)), 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: true,
      devTools: !app.isPackaged,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${DESKTOP_ORIGIN}/`)) event.preventDefault();
  });
  window.webContents.setVisualZoomLevelLimits(1, 3).catch(() => undefined);
  window.once('ready-to-show', () => window.show());
  window.on('close', (event) => {
    if (process.platform === 'darwin' && runManager.hasActiveOperations && !allowQuit) {
      event.preventDefault();
      window.hide();
    }
  });
  window.on('closed', () => { if (mainWindow === window) mainWindow = null; });
  void window.loadURL(`${DESKTOP_ORIGIN}/index.html`);
  return window;
}

const hasSingleInstanceLock = !squirrelStartup && app.requestSingleInstanceLock();
if (squirrelStartup || !hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) mainWindow = createWindow();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    await registerRendererProtocol();
    registerHandlers();
    mainWindow = createWindow();
  }).catch((error) => {
    process.stderr.write(`${sanitizeLog(errorMessage(error))}\n`);
    app.exit(1);
  });

  app.on('activate', () => {
    if (!mainWindow) mainWindow = createWindow();
    else {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', (event) => {
    if (allowQuit || !runManager.hasActiveOperations) return;
    event.preventDefault();
    if (stopping) return;
    stopping = true;
    void runManager.shutdown().finally(() => {
      allowQuit = true;
      app.quit();
    });
  });
}
