import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = path.join(root, 'out', `Codex Infinite-${process.platform}-${process.arch}`);
const executablePath = process.platform === 'win32'
  ? path.join(packageRoot, 'CodexInfinite.exe')
  : process.platform === 'darwin'
    ? path.join(packageRoot, 'Codex Infinite.app', 'Contents', 'MacOS', 'CodexInfinite')
    : path.join(packageRoot, 'CodexInfinite');

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
  await window.locator('#new-goal-button').click();
  assert.equal(await window.locator('#goal-dialog').evaluate((dialog) => dialog.open), true);
  assert.equal(await window.locator('#goal-network').isChecked(), false);
  assert.equal(await window.locator('#goal-full-access').isChecked(), false);
  await window.locator('#dialog-close-button').click();
  assert.equal(await window.locator('#resume-verify').inputValue(), '');
  assert.equal(await window.locator('#resume-network').isChecked(), false);
  assert.equal(await window.locator('#resume-full-access').isChecked(), false);
} finally {
  await browser?.close().catch(() => undefined);
  await stopDesktop(desktop);
  await rm(userDataDirectory, { recursive: true, force: true });
}

process.stdout.write(`Smoke de escritorio correcto: ${process.platform}/${process.arch}\n`);

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
