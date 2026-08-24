import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  minimalWindowsEnvironment,
  resolvePathExecutable,
  resolveWindowsSystemExecutable,
  spawnManagedProcess,
  terminateProcessTree,
} from '../dist/trusted-process.js';

test('PATH resolution ignores an executable inside the untrusted workspace', async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'codex-infinite-path-'));
  const previousPath = process.env.PATH;
  const fake = path.join(workspace, process.platform === 'win32' ? 'node.exe' : 'node');
  await writeFile(fake, 'untrusted');
  if (process.platform !== 'win32') await chmod(fake, 0o755);
  process.env.PATH = `${workspace}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${previousPath ?? ''}`;
  t.after(async () => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(workspace, { recursive: true, force: true });
  });

  const resolved = await resolvePathExecutable('node', workspace);
  assert.equal(path.isAbsolute(resolved), true);
  assert.notEqual(path.resolve(resolved).toLowerCase(), path.resolve(fake).toLowerCase());
});

test('Windows helpers resolve inside SystemRoot and receive a minimal environment', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows only');
  const taskkill = await resolveWindowsSystemExecutable(path.join('System32', 'taskkill.exe'));
  const relative = path.relative(process.env.SystemRoot, taskkill);
  assert.equal(relative.startsWith('..'), false);

  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'must-not-leak';
  t.after(() => {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  });
  assert.equal(minimalWindowsEnvironment().OPENAI_API_KEY, undefined);
});

test('managed process exit drains detached descendants', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows only');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'codex-infinite-drain-'));
  const marker = path.join(temp, 'survived.txt');
  t.after(() => rm(temp, { recursive: true, force: true }));
  const grandchild = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 800)`;
  const parent = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{detached:true,stdio:'ignore'}).unref()`;
  const child = spawnManagedProcess(process.execPath, ['-e', parent], { stdio: ['ignore', 'ignore', 'ignore'] });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await assert.rejects(() => access(marker), { code: 'ENOENT' });
});

test('cooperative termination drains detached descendants', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows only');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'codex-infinite-stop-'));
  const marker = path.join(temp, 'survived.txt');
  t.after(() => rm(temp, { recursive: true, force: true }));
  const grandchild = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 1000)`;
  const parent = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{detached:true,stdio:'ignore'}).unref();setInterval(()=>{},1000)`;
  const child = spawnManagedProcess(process.execPath, ['-e', parent], { stdio: ['ignore', 'ignore', 'ignore'] });
  await new Promise((resolve) => setTimeout(resolve, 150));
  await terminateProcessTree(child);
  assert.equal(child.exitCode, 125);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await assert.rejects(() => access(marker), { code: 'ENOENT' });
});

test('immediate cooperative termination waits for wrapper readiness', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows only');
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const child = spawnManagedProcess(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    await terminateProcessTree(child);
    assert.equal(child.exitCode, 125, `attempt ${attempt + 1}`);
  }
});

test('POSIX managed process termination drains its process group', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX only');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'codex-infinite-posix-stop-'));
  const marker = path.join(temp, 'survived.txt');
  t.after(() => rm(temp, { recursive: true, force: true }));
  const grandchild = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 1000)`;
  const parent = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
  const child = spawnManagedProcess(process.execPath, ['-e', parent], { stdio: ['ignore', 'ignore', 'ignore'] });
  await new Promise((resolve) => setTimeout(resolve, 150));
  await terminateProcessTree(child);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await assert.rejects(() => access(marker), { code: 'ENOENT' });
});

test('POSIX managed process can drain descendants after its leader exits naturally', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX only');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'codex-infinite-posix-exit-'));
  const marker = path.join(temp, 'survived.txt');
  t.after(() => rm(temp, { recursive: true, force: true }));
  const grandchild = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 1000)`;
  const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'})`;
  const child = spawnManagedProcess(process.execPath, ['-e', parent], { stdio: ['ignore', 'ignore', 'ignore'] });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  await terminateProcessTree(child);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await assert.rejects(() => access(marker), { code: 'ENOENT' });
});

test('minimal environment removes Windows-only values on POSIX', (t) => {
  if (process.platform === 'win32') return t.skip('POSIX only');
  const environment = minimalWindowsEnvironment({
    PATH: '/usr/bin:/bin',
    COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
    ProgramFiles: 'C:\\Program Files',
    PATHEXT: '.EXE',
  });
  assert.equal(environment.PATH, '/usr/bin:/bin');
  assert.equal(environment.COMSPEC, undefined);
  assert.equal(environment.ProgramFiles, undefined);
  assert.equal(environment.PATHEXT, undefined);
});
