import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './errors.js';
import { minimalWindowsEnvironment, spawnManagedProcess, terminateProcessTree } from './trusted-process.js';

const MAX_OUTPUT_BYTES = 256 * 1024;
let pinnedGit: { path: string; digest: string } | null = null;

async function protectedGitExecutable(): Promise<string> {
  if (!pinnedGit) {
    const candidates = process.platform === 'win32'
      ? [
        'C:\\Program Files\\Git\\cmd\\git.exe',
        'C:\\Program Files\\Git\\bin\\git.exe',
        'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
      ]
      : process.platform === 'darwin'
        ? ['/usr/bin/git']
        : process.platform === 'linux'
          ? ['/usr/bin/git', '/bin/git']
          : [];
    for (const candidate of candidates) {
      try {
        const resolved = await realpath(candidate);
        const metadata = await stat(resolved);
        if (!metadata.isFile()) continue;
        if (process.platform !== 'win32' && (metadata.uid !== 0 || (metadata.mode & 0o022) !== 0)) continue;
        const bytes = await readFile(resolved);
        pinnedGit = { path: resolved, digest: createHash('sha256').update(bytes).digest('hex') };
        break;
      } catch {
        // Try the next protected machine-wide installation.
      }
    }
    if (!pinnedGit) {
      throw new AppError(
        'TRUSTED_GIT_NOT_FOUND',
        process.platform === 'win32'
          ? 'Instala Git for Windows para todos los usuarios en C:\\Program Files\\Git.'
          : 'No se encontro un Git del sistema, propiedad de root y no modificable por usuarios.',
      );
    }
  }
  const bytes = await readFile(pinnedGit.path).catch((error) => {
    throw new AppError('TRUSTED_GIT_CHANGED', 'El Git protegido desaparecio durante la ejecucion.', 1, { cause: error });
  });
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== pinnedGit.digest) {
    throw new AppError('TRUSTED_GIT_CHANGED', 'El Git protegido cambio durante la ejecucion.');
  }
  return pinnedGit.path;
}

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface GitBaseline {
  root: string;
  branch: string | null;
  head: string | null;
  dirty: boolean;
}

function runCommand(command: string, args: string[], cwd: string, timeoutMs = 30_000, signal?: AbortSignal): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let terminating = false;
    const child = spawnManagedProcess(command, args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: minimalWindowsEnvironment(process.platform === 'win32' ? {
        PATH: [
          'C:\\Windows\\System32',
          'C:\\Windows',
          'C:\\Program Files\\Git\\cmd',
          'C:\\Program Files\\Git\\bin',
          'C:\\Program Files\\Git\\usr\\bin',
        ].join(path.delimiter),
        PATHEXT: '.COM;.EXE;.BAT;.CMD',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: 'NUL',
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'Never',
      } : {
        PATH: [path.dirname(command), '/usr/bin', '/bin'].join(path.delimiter),
        LANG: 'C',
        LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
      }),
    }) as ChildProcessWithoutNullStreams;
    const append = (current: string, chunk: Buffer) => (current + chunk.toString('utf8')).slice(0, MAX_OUTPUT_BYTES);
    child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      stop();
    }, timeoutMs);
    const onAbort = () => {
      stop();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.once('error', (error) => {
      if (terminating) return;
      stderr = append(stderr, Buffer.from(error.message));
      finish(null, false);
    });
    child.once('exit', (exitCode) => {
      if (terminating) return;
      terminating = true;
      void terminateProcessTree(child).then(
        () => finish(exitCode, false),
        (error) => failTermination(error),
      );
    });

    function stop(): void {
      if (settled || terminating) return;
      terminating = true;
      void terminateProcessTree(child).then(
        () => finish(null, true),
        (error) => failTermination(error),
      );
    }

    function finish(exitCode: number | null, timedOut: boolean): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ exitCode, stdout, stderr, timedOut });
    }

    function failTermination(error: unknown): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new AppError(
        'HOST_PROCESS_UNCERTAIN',
        `No se pudo confirmar la terminacion de Git: ${error instanceof Error ? error.message : String(error)}`,
        1,
        { cause: error },
      ));
    }
    if (signal?.aborted) onAbort();
  });
}

export async function runGitCommand(args: string[], cwd: string, timeoutMs = 30_000, signal?: AbortSignal): Promise<CommandResult> {
  const binary = await protectedGitExecutable();
  const hooksPath = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const platformConfig = process.platform === 'win32' ? ['-c', 'core.autocrlf=true'] : [];
  const commandArgs = args[0] === 'diff'
    ? ['diff', '--no-ext-diff', '--no-textconv', ...args.slice(1)]
    : args;
  return runCommand(binary, [
    '--no-optional-locks',
    '-c', 'core.fsmonitor=false',
    '-c', `core.hooksPath=${hooksPath}`,
    '-c', 'credential.helper=',
    ...platformConfig,
    ...commandArgs,
  ], cwd, timeoutMs, signal);
}

async function git(
  args: string[],
  cwd: string,
  allowFailure = false,
  timeoutMs = 30_000,
  signal?: AbortSignal,
): Promise<CommandResult> {
  const result = await runGitCommand(args, cwd, timeoutMs, signal);
  if (signal?.aborted) throw new AppError('INTERRUPTED', 'Operacion Git interrumpida.', 130);
  if (!allowFailure && result.exitCode !== 0) {
    throw new AppError('GIT_FAILED', `git ${args.join(' ')} fallo: ${(result.stderr || result.stdout).trim().slice(0, 2000)}`);
  }
  return result;
}

export async function resolveGitWorkspace(candidate: string, timeoutMs = 120_000, signal?: AbortSignal): Promise<GitBaseline> {
  const requested = path.resolve(candidate);
  const deadline = Date.now() + timeoutMs;
  const execute = async (args: string[], cwd: string, allowFailure = false): Promise<CommandResult> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new AppError('GIT_TIMEOUT', 'Tiempo agotado al capturar el estado Git.');
    return git(args, cwd, allowFailure, Math.min(30_000, remaining), signal);
  };
  const rootResult = await execute(['rev-parse', '--show-toplevel'], requested, true);
  if (rootResult.exitCode !== 0) {
    throw new AppError('NOT_A_GIT_REPOSITORY', `El directorio no pertenece a un repositorio Git: ${requested}`);
  }
  const root = path.resolve(rootResult.stdout.trim());
  const branchResult = await execute(['branch', '--show-current'], root, true);
  const headResult = await execute(['rev-parse', '--verify', 'HEAD'], root, true);
  const statusResult = await execute(['status', '--porcelain=v1', '--untracked-files=normal'], root);
  return {
    root,
    branch: branchResult.exitCode === 0 && branchResult.stdout.trim() ? branchResult.stdout.trim() : null,
    head: headResult.exitCode === 0 ? headResult.stdout.trim() : null,
    dirty: statusResult.stdout.trim().length > 0,
  };
}

export async function currentGitSnapshot(root: string, timeoutMs = 120_000, signal?: AbortSignal): Promise<GitBaseline> {
  return resolveGitWorkspace(root, timeoutMs, signal);
}
