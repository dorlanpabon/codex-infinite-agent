import { open, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  protocol,
  session,
  shell,
  type IpcMainInvokeEvent,
} from 'electron';
import squirrelStartup from 'electron-squirrel-startup';
import { errorMessage } from '../errors.js';
import { sanitizeLog, type Logger } from '../log.js';
import {
  doctorDesktop,
  listDesktopModels,
  listDesktopSessions,
  listDesktopThreads,
  getDesktopSession,
  listRecentDesktopMessages,
} from '../operations.js';
import { listRuns, loadRun } from '../state.js';
import {
  DESKTOP_ORIGIN,
  codexInfiniteDeepLink,
  codexThreadDeepLink,
  parseAttachRunInput,
  parseAttachmentPaths,
  parseDoctorInput,
  parseCodexInfiniteDeepLinks,
  parseDesktopNavigationTarget,
  parseRecentMessagesInput,
  parseResumeRunInput,
  parseRunId,
  parseStartRunInput,
  parseThreadsInput,
  type DesktopEvent,
  type DesktopNavigationTarget,
  type LocalAttachment,
  type LogLevel,
} from './contracts.js';
import { DesktopNavigationQueue } from './navigation.js';
import { RunManager } from './run-manager.js';

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
  openCodexThread: 'threads:open-in-codex',
  listModels: 'models:list',
  listThreads: 'threads:list',
  listSessions: 'sessions:list',
  getSession: 'sessions:get',
  recentMessages: 'sessions:recent-messages',
  copyDeepLink: 'navigation:copy-deep-link',
  navigationReady: 'navigation:ready',
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
let desktopReady = false;
const navigationQueue = new DesktopNavigationQueue();

protocol.registerSchemesAsPrivileged([{
  scheme: 'codex-infinite-app',
  privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false },
}]);
app.enableSandbox();

function sendEvent(event: DesktopEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(CHANNELS.event, event);
}

const runManager = new RunManager(sendEvent);

function focusMainWindow(): void {
  if (!desktopReady) return;
  if (!mainWindow) mainWindow = createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function flushNavigationQueue(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  for (const target of navigationQueue.takeReady()) {
    sendEvent({ type: 'navigation-requested', target });
  }
}

function receiveDeepLinks(arguments_: readonly string[]): boolean {
  const targets = parseCodexInfiniteDeepLinks(arguments_);
  for (const target of targets) navigationQueue.enqueue(target);
  if (targets.length === 0) return false;
  focusMainWindow();
  flushNavigationQueue();
  return true;
}

function registerOperatingSystemProtocol(): void {
  if (process.defaultApp && process.argv[1]) {
    app.setAsDefaultProtocolClient('codex-infinite', process.execPath, [path.resolve(process.argv[1])]);
    return;
  }
  app.setAsDefaultProtocolClient('codex-infinite');
}

function handleSquirrelProtocolLifecycle(): void {
  if (!squirrelStartup || process.platform !== 'win32') return;
  const command = process.argv[1];
  if (command === '--squirrel-install' || command === '--squirrel-updated') {
    app.setAsDefaultProtocolClient('codex-infinite');
  } else if (command === '--squirrel-uninstall') {
    app.removeAsDefaultProtocolClient('codex-infinite');
  }
}

async function inspectAttachmentPaths(raw: unknown): Promise<LocalAttachment[]> {
  const paths = parseAttachmentPaths(raw);
  const attachments: LocalAttachment[] = [];
  const seen = new Set<string>();
  for (const candidate of paths) {
    const resolved = await realpath(candidate);
    if (resolved.length > 32_767 || /[\x00-\x1f\x7f]/u.test(resolved)) throw new TypeError('La ruta resuelta del adjunto no es valida.');
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    const handle = await open(resolved, 'r');
    let size: number;
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new TypeError(`El adjunto no es un archivo regular: ${path.basename(resolved)}`);
      size = info.size;
    } finally {
      await handle.close();
    }
    seen.add(key);
    attachments.push({ path: resolved, name: path.basename(resolved), size });
  }
  return attachments;
}

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
  ipcMain.handle(CHANNELS.chooseAttachments, async (event) => {
    assertTrustedSender(event);
    const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openFile', 'multiSelections'] });
    return result.canceled ? [] : inspectAttachmentPaths(result.filePaths);
  });
  ipcMain.handle(CHANNELS.inspectAttachments, async (event, raw: unknown) => {
    assertTrustedSender(event);
    return inspectAttachmentPaths(raw);
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
  ipcMain.handle(CHANNELS.attachRun, (event, raw: unknown) => {
    assertTrustedSender(event);
    return runManager.attach(parseAttachRunInput(raw));
  });
  ipcMain.handle(CHANNELS.resumeRun, (event, raw: unknown) => {
    assertTrustedSender(event);
    return runManager.resume(parseResumeRunInput(raw));
  });
  ipcMain.handle(CHANNELS.pauseRun, (event, raw: unknown) => {
    assertTrustedSender(event);
    return runManager.pause(parseRunId(raw));
  });
  ipcMain.handle(CHANNELS.openCodexThread, async (event, raw: unknown) => {
    assertTrustedSender(event);
    const deepLink = codexThreadDeepLink(raw);
    try {
      await shell.openExternal(deepLink);
    } catch (error) {
      throw new Error(`No se pudo abrir Codex Desktop: ${sanitizeLog(errorMessage(error))}`);
    }
  });
  ipcMain.handle(CHANNELS.listModels, async (event, raw: unknown) => {
    assertTrustedSender(event);
    const input = parseDoctorInput(raw);
    return listDesktopModels(input.workspace, input.binary, ipcLogger('models'));
  });
  ipcMain.handle(CHANNELS.listThreads, async (event, raw: unknown) => {
    assertTrustedSender(event);
    const input = parseThreadsInput(raw);
    return listDesktopThreads(input.workspace, input.limit, input.binary, ipcLogger('threads'));
  });
  ipcMain.handle(CHANNELS.listSessions, async (event, raw: unknown) => {
    assertTrustedSender(event);
    const input = parseThreadsInput(raw);
    return listDesktopSessions(
      input.workspace,
      input.limit,
      input.binary,
      ipcLogger('sessions'),
      runManager.activeRunIds,
    );
  });
  ipcMain.handle(CHANNELS.getSession, async (event, raw: unknown) => {
    assertTrustedSender(event);
    const input = parseRecentMessagesInput(raw);
    return getDesktopSession(
      input.workspace,
      input.threadId,
      input.binary,
      ipcLogger('session'),
      runManager.activeRunIds,
    );
  });
  ipcMain.handle(CHANNELS.recentMessages, async (event, raw: unknown) => {
    assertTrustedSender(event);
    const input = parseRecentMessagesInput(raw);
    return listRecentDesktopMessages(
      input.workspace,
      input.threadId,
      input.binary,
      ipcLogger('recent-context'),
    );
  });
  ipcMain.handle(CHANNELS.copyDeepLink, (event, raw: unknown) => {
    assertTrustedSender(event);
    const deepLink = codexInfiniteDeepLink(parseDesktopNavigationTarget(raw));
    clipboard.writeText(deepLink);
    return deepLink;
  });
  ipcMain.handle(CHANNELS.navigationReady, (event) => {
    assertTrustedSender(event);
    return navigationQueue.markRendererReady();
  });
}

async function registerRendererProtocol(): Promise<void> {
  await protocol.handle('codex-infinite-app', async (request) => {
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
  navigationQueue.resetRenderer();
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
  window.webContents.on('did-start-loading', () => navigationQueue.resetRenderer());
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
const startupArguments = squirrelStartup ? [] : [...process.argv];
handleSquirrelProtocolLifecycle();

app.on('open-url', (event, url) => {
  event.preventDefault();
  receiveDeepLinks([url]);
});

if (squirrelStartup || !hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    receiveDeepLinks(commandLine);
    focusMainWindow();
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
    registerOperatingSystemProtocol();
    desktopReady = true;
    mainWindow = createWindow();
    receiveDeepLinks(startupArguments);
  }).catch((error) => {
    process.stderr.write(`${sanitizeLog(errorMessage(error))}\n`);
    app.exit(1);
  });

  app.on('activate', () => {
    focusMainWindow();
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
