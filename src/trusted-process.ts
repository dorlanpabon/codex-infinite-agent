import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { readFileSync } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from './errors.js';

const WINDOWS_JOB_WRAPPER_SHA256 = 'a6600cf1a3dba2c39ab4ec99cf459d51438bfeb4537d8c1e00fd666801c4b7f1';

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function executableFile(candidate: string): Promise<string | null> {
  try {
    await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    const resolved = await realpath(candidate);
    return (await stat(resolved)).isFile() ? resolved : null;
  } catch {
    return null;
  }
}

export async function resolvePathExecutable(name: string, excludedRoot?: string): Promise<string> {
  const filename = process.platform === 'win32' && !name.toLowerCase().endsWith('.exe') ? `${name}.exe` : name;
  const excluded = excludedRoot ? await realpath(path.resolve(excludedRoot)).catch(() => path.resolve(excludedRoot)) : null;
  const entries = (process.env.PATH ?? '').split(path.delimiter);
  for (const rawEntry of entries) {
    const trimmed = rawEntry.trim();
    const entry = trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
    if (!entry || !path.isAbsolute(entry)) continue;
    const candidate = await executableFile(path.join(entry, filename));
    if (candidate && (!excluded || !isInside(candidate, excluded))) return candidate;
  }
  throw new AppError('TRUSTED_EXECUTABLE_NOT_FOUND', `No se encontro ${filename} en una ruta absoluta y confiable de PATH.`);
}

export async function resolveWindowsSystemExecutable(relativePath: string): Promise<string> {
  if (process.platform !== 'win32') throw new AppError('UNSUPPORTED_PLATFORM', 'Se solicito un binario del sistema Windows fuera de Windows.');
  const rootValue = 'C:\\Windows';
  const root = await realpath(rootValue).catch(() => null);
  const candidate = await executableFile(path.join(rootValue, relativePath));
  if (root && candidate && isInside(candidate, root)) return candidate;
  throw new AppError('WINDOWS_SYSTEM_EXECUTABLE_NOT_FOUND', `No se encontro el binario de sistema Windows: ${relativePath}`);
}

export function minimalWindowsEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  if (process.platform !== 'win32') {
    const environment = { ...extra };
    delete environment.SystemRoot;
    delete environment.WINDIR;
    delete environment.SystemDrive;
    delete environment.COMSPEC;
    delete environment.ProgramFiles;
    delete environment['ProgramFiles(x86)'];
    delete environment.PATHEXT;
    return environment;
  }
  const environment: NodeJS.ProcessEnv = {
    SystemRoot: 'C:\\Windows',
    WINDIR: 'C:\\Windows',
    SystemDrive: 'C:',
  };
  return { ...extra, ...environment };
}

function verifiedWindowsJobWrapper(): string {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new AppError('UNSUPPORTED_PLATFORM', 'El guardia de procesos requiere Windows x64.');
  }
  const packagedMarker = `${path.sep}app.asar${path.sep}`;
  const bundledCandidate = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'native',
    'windows-job-wrapper',
    'bin',
    'windows-x64',
    'codex-infinite-job-wrapper.exe',
  );
  const candidate = bundledCandidate.includes(packagedMarker)
    ? bundledCandidate.replace(packagedMarker, `${path.sep}app.asar.unpacked${path.sep}`)
    : bundledCandidate;
  let bytes: Buffer;
  try {
    bytes = readFileSync(candidate);
  } catch (error) {
    throw new AppError('PROCESS_GUARD_MISSING', 'No se encontro el guardia nativo de procesos.', 1, { cause: error });
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== WINDOWS_JOB_WRAPPER_SHA256) {
    throw new AppError('PROCESS_GUARD_INVALID', 'La integridad del guardia nativo de procesos no coincide.');
  }
  return candidate;
}

export function spawnManagedProcess(command: string, args: readonly string[], options: SpawnOptions = {}): ChildProcess {
  if (!path.isAbsolute(command)) {
    throw new AppError('UNTRUSTED_EXECUTABLE_PATH', 'Los procesos administrados requieren una ruta absoluta.');
  }
  if (process.platform === 'win32') {
    return spawn(
      verifiedWindowsJobWrapper(),
      ['--parent-pid', String(process.pid), '--', command, ...args],
      { ...options, shell: false, detached: false },
    );
  }
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new AppError('UNSUPPORTED_PLATFORM', `La supervision durable de procesos no soporta ${process.platform}.`);
  }
  return spawn(command, [...args], { ...options, shell: false, detached: true });
}

function childExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (childExited(child)) return true;
  return new Promise((resolve) => {
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(childExited(child)), Math.max(1, timeoutMs));
    child.once('exit', onExit);
    function finish(exited: boolean): void {
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(exited);
    }
  });
}

async function waitForGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

export async function terminateProcessTree(child: ChildProcess, timeoutMs = 8000): Promise<void> {
  if (!child.pid) throw new AppError('PROCESS_TREE_TERMINATION_UNCERTAIN', 'El proceso no expuso un PID verificable.');
  const deadline = Date.now() + timeoutMs;
  if (process.platform === 'win32') {
    if (childExited(child)) return;
    let signaled = false;
    let lastExitCode: number | null = null;
    while (!signaled && Date.now() < deadline) {
      if (childExited(child)) return;
      const stopper = spawn(verifiedWindowsJobWrapper(), ['--stop', String(child.pid)], {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'ignore'],
        env: minimalWindowsEnvironment(),
      });
      const attemptTimeout = Math.max(1, Math.min(1000, deadline - Date.now()));
      lastExitCode = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          stopper.kill();
          resolve(null);
        }, attemptTimeout);
        stopper.once('error', (error) => {
          clearTimeout(timer);
          reject(new AppError('PROCESS_TREE_TERMINATION_UNCERTAIN', `El pedido cooperativo de cierre fallo: ${error.message}`, 1, { cause: error }));
        });
        stopper.once('exit', (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });
      signaled = lastExitCode === 0;
      if (!signaled && !childExited(child) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
      }
    }
    if (!signaled) {
      if (childExited(child)) return;
      throw new AppError('PROCESS_TREE_TERMINATION_UNCERTAIN', `No se pudo senalizar el cierre cooperativo (codigo=${String(lastExitCode)}).`);
    }
    if (!await waitForChildExit(child, deadline - Date.now())) {
      throw new AppError('PROCESS_TREE_TERMINATION_UNCERTAIN', 'El guardia no confirmo el drenaje del arbol de procesos.');
    }
    return;
  }

  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw new AppError('PROCESS_TREE_TERMINATION_UNCERTAIN', `No se pudo enviar SIGTERM al grupo: ${(error as Error).message}`, 1, { cause: error });
    }
  }
  if (!await waitForGroupExit(child.pid, Math.min(1500, Math.max(1, deadline - Date.now())))) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        throw new AppError('PROCESS_TREE_TERMINATION_UNCERTAIN', `No se pudo enviar SIGKILL al grupo: ${(error as Error).message}`, 1, { cause: error });
      }
    }
  }
  const groupRemaining = deadline - Date.now();
  if (groupRemaining <= 0 || !await waitForGroupExit(child.pid, groupRemaining)) {
    throw new AppError('PROCESS_TREE_TERMINATION_UNCERTAIN', 'El grupo de procesos siguio activo despues de SIGKILL.');
  }
  const childRemaining = deadline - Date.now();
  if (childRemaining <= 0 || !await waitForChildExit(child, childRemaining)) {
    throw new AppError('PROCESS_TREE_TERMINATION_UNCERTAIN', 'El grupo de procesos siguio activo despues de SIGKILL.');
  }
}
