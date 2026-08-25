import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { packagerConfig } = require('../forge.config.cjs');
const { executableName, name: packageName } = packagerConfig;
if (!/^[A-Za-z0-9._-]+$/u.test(packageName) || !/^[A-Za-z0-9._-]+$/u.test(executableName)) {
  throw new Error('Los nombres tecnicos del paquete deben ser segmentos de ruta sin espacios.');
}
const packageRoot = path.join(root, 'out', `${packageName}-${process.platform}-${process.arch}`);
const executablePath = process.platform === 'win32'
  ? path.join(packageRoot, `${executableName}.exe`)
  : process.platform === 'darwin'
    ? path.join(packageRoot, `${packageName}.app`, 'Contents', 'MacOS', executableName)
    : path.join(packageRoot, executableName);

await access(executablePath);
const userDataDirectory = await mkdtemp(path.join(os.tmpdir(), 'codex-infinite-smoke-'));
const port = await reservePort();
const desktop = spawn(executablePath, [
  '--remote-debugging-address=127.0.0.1',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${userDataDirectory}`,
], {
  detached: process.platform !== 'win32',
  stdio: ['ignore', 'ignore', 'pipe'],
  windowsHide: true,
});
let stderr = '';
desktop.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString('utf8')).slice(-8192); });
let browser;
try {
  browser = await connectToDesktop(port, desktop, () => stderr);
  const window = await findAppWindow(browser);
  await window.waitForLoadState('domcontentloaded');
  assert.equal(await window.title(), 'Codex Infinite');
  assert.equal(await window.url(), 'codex-infinite://app/index.html');
  const system = await window.evaluate(() => window.codexInfinite.systemInfo());
  assert.deepEqual(
    { platform: system.platform, arch: system.arch },
    { platform: process.platform, arch: process.arch },
  );
  assert.match(system.version, /^\d+\.\d+\.\d+/);
  const qaDirectory = process.env.QA_SCREENSHOT_DIR || path.join(root, 'out', 'qa');
  await mkdir(qaDirectory, { recursive: true });
  const initialFit = await layoutSnapshot(window);
  assert.equal(initialFit.canScrollX, false);
  assert.equal(initialFit.canScrollY, false);
  assert.equal(initialFit.regions.every((region) => region.visible && region.inViewport), true);
  await window.screenshot({ path: path.join(qaDirectory, 'desktop-initial.png') });

  await window.locator('#inspector-tab').focus();
  await window.keyboard.press('ArrowRight');
  assert.equal(await window.locator('#sessions-tab').getAttribute('aria-selected'), 'true');
  assert.equal(await window.locator('#sessions-panel').isVisible(), true);
  await window.locator('#sessions-panel').waitFor({ state: 'visible' });
  await window.waitForFunction(() => document.querySelector('#sessions-panel')?.getAttribute('aria-busy') === 'false');
  await window.screenshot({ path: path.join(qaDirectory, 'desktop-sessions.png') });
  const attachableSession = window.locator('.session-switch:enabled').first();
  if (await attachableSession.count() > 0) {
    await attachableSession.click();
    assert.equal(await window.locator('#goal-dialog').evaluate((dialog) => dialog.open), true);
    assert.equal(await window.locator('#goal-thread-row').isVisible(), true);
    assert.equal(await window.locator('#goal-dialog-title').innerText(), 'Coloca el objetivo para activar');
    assert.match(await window.locator('#dialog-footer-copy').innerText(), /No se enviarán mensajes/iu);
    await window.screenshot({ path: path.join(qaDirectory, 'desktop-attach-dialog.png') });
    await window.locator('#dialog-close-button').click();
  }

  await window.locator('#new-goal-button').click();
  assert.equal(await window.locator('#goal-dialog').evaluate((dialog) => dialog.open), true);
  assert.equal(await window.locator('#goal-network').isChecked(), false);
  assert.equal(await window.locator('#goal-full-access').isChecked(), false);
  await window.locator('#dialog-close-button').click();
  assert.equal(await window.locator('#resume-verify').inputValue(), '');
  assert.equal(await window.locator('#resume-network').isChecked(), false);
  assert.equal(await window.locator('#resume-full-access').isChecked(), false);

  for (const viewport of [
    { width: 1024, height: 768 },
    { width: 760, height: 900 },
    { width: 430, height: 932 },
  ]) {
    await window.setViewportSize(viewport);
    await window.locator('.inspector').evaluate((element) => element.scrollIntoView({ block: 'start' }));
    await window.locator('#sessions-tab').click();
    const compactFit = await compactSessionsSnapshot(window);
    assert.equal(compactFit.canScrollX, false);
    assert.equal(
      compactFit.regions.every((region) => region.visible && region.inViewport),
      true,
      JSON.stringify({ viewport, compactFit }),
    );
    await window.screenshot({
      path: path.join(qaDirectory, `desktop-sessions-${viewport.width}.png`),
    });
  }

  await window.locator('#new-goal-button').click();
  const compactDialogFit = await window.locator('#goal-dialog').evaluate((dialog) => {
    const rect = dialog.getBoundingClientRect();
    return rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
  });
  assert.equal(compactDialogFit, true);
  await window.screenshot({ path: path.join(qaDirectory, 'desktop-dialog-430.png') });
  await window.locator('#dialog-close-button').click();
} finally {
  await browser?.close().catch(() => undefined);
  await stopDesktop(desktop);
  await rm(userDataDirectory, {
    recursive: true,
    force: true,
    maxRetries: process.platform === 'win32' ? 20 : 0,
    retryDelay: 250,
  });
}

process.stdout.write(`Smoke de escritorio correcto: ${process.platform}/${process.arch}\n`);

async function layoutSnapshot(window) {
  return window.evaluate(() => {
    const selectors = ['.sidebar', '.run-main', '.inspector'];
    return {
      canScrollX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      canScrollY: document.documentElement.scrollHeight > document.documentElement.clientHeight,
      regions: selectors.map((selector) => {
        const element = document.querySelector(selector);
        const rect = element?.getBoundingClientRect();
        return {
          selector,
          visible: Boolean(rect && rect.width > 0 && rect.height > 0),
          inViewport: Boolean(rect && rect.left >= 0 && rect.top >= 0
            && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1),
        };
      }),
    };
  });
}

async function compactSessionsSnapshot(window) {
  return window.evaluate(() => {
    const selectors = ['.inspector', '.tabs', '#sessions-panel'];
    return {
      canScrollX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      regions: selectors.map((selector) => {
        const element = document.querySelector(selector);
        const rect = element?.getBoundingClientRect();
        return {
          selector,
          visible: Boolean(rect && rect.width > 0 && rect.height > 0),
          inViewport: Boolean(rect && rect.left >= 0 && rect.top >= 0
            && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1),
        };
      }),
    };
  });
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function connectToDesktop(port, child, readStderr) {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Electron termino con codigo ${child.exitCode} y senal ${child.signalCode}: ${readStderr()}`);
    }
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 });
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`No se pudo conectar al paquete Electron: ${lastError instanceof Error ? lastError.message : String(lastError)}\n${readStderr()}`);
}

async function findAppWindow(browser) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const window = browser.contexts().flatMap((context) => context.pages())
      .find((page) => page.url() === 'codex-infinite://app/index.html');
    if (window) return window;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('La ventana empaquetada no cargo el protocolo local.');
}

async function stopDesktop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') child.kill();
  else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch (error) {
      if (error.code === 'ESRCH') return;
      throw error;
    }
  }
  const exited = await Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
  ]);
  if (exited) return;
  if (process.platform === 'win32') child.kill('SIGKILL');
  else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
}
