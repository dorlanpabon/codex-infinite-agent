import type { ChildProcess } from 'node:child_process';
import { mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sanitizeLog } from './log.js';
import { runGitCommand } from './git.js';
import type { VerificationRecord } from './state.js';
import {
  minimalWindowsEnvironment,
  resolveWindowsSystemExecutable,
  spawnManagedProcess,
  terminateProcessTree,
} from './trusted-process.js';
import { AppError } from './errors.js';

const MAX_CAPTURE = 64 * 1024;

interface VerificationCheck {
  label: string;
  ok: boolean;
  output: string;
}

async function runShell(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<VerificationCheck> {
  let shell: string;
  try {
    if (process.platform === 'win32') {
      shell = await resolveWindowsSystemExecutable(path.join('System32', 'cmd.exe'));
    } else {
      const resolved = await realpath('/bin/sh');
      const metadata = await stat(resolved);
      if (!metadata.isFile() || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0) {
        throw new AppError('UNTRUSTED_SHELL', '/bin/sh no pertenece al sistema protegido.');
      }
      shell = resolved;
    }
  } catch (error) {
    return { label: command, ok: false, output: sanitizeLog(error instanceof Error ? error.message : String(error), 8000) };
  }
  const scriptDirectory = process.platform === 'win32'
    ? await mkdtemp(path.join(os.tmpdir(), 'codex-infinite-verify-'))
    : null;
  const scriptPath = scriptDirectory ? path.join(scriptDirectory, 'verify.cmd') : null;
  if (scriptPath) await writeFile(scriptPath, `@echo off\r\n${command}\r\n`, { encoding: 'utf8', mode: 0o600 });
  const cleanup = async (): Promise<void> => {
    if (scriptDirectory) await rm(scriptDirectory, { recursive: true, force: true });
  };
  return new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    let terminating = false;
    let child: ChildProcess;
    try {
      child = spawnManagedProcess(shell, process.platform === 'win32' ? ['/d', '/s', '/c', scriptPath!] : ['-c', command], {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: minimalWindowsEnvironment(process.platform === 'win32' ? {
          PATH: [
            'C:\\Windows\\System32',
            'C:\\Windows',
            'C:\\Program Files\\nodejs',
            'C:\\Program Files\\Git\\cmd',
            'C:\\Program Files\\Git\\bin',
            'C:\\Program Files\\dotnet',
          ].join(path.delimiter),
          PATHEXT: '.COM;.EXE;.BAT;.CMD',
          COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: 'NUL',
          GIT_TERMINAL_PROMPT: '0',
          NPM_CONFIG_USERCONFIG: 'NUL',
        } : {
          PATH: [path.dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(path.delimiter),
          LANG: 'C',
          LC_ALL: 'C',
          TMPDIR: os.tmpdir(),
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
          NPM_CONFIG_USERCONFIG: '/dev/null',
        }),
      });
    } catch (error) {
      void cleanup().finally(() => {
        resolve({ label: command, ok: false, output: sanitizeLog(error instanceof Error ? error.message : String(error), 8000) });
      });
      return;
    }
    const append = (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(0, MAX_CAPTURE); };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const stop = (suffix: string) => {
      if (settled || terminating) return;
      terminating = true;
      void terminateProcessTree(child).then(
        () => finish(false, `${output}\n[${suffix}]`),
        (error) => failTermination(error),
      );
    };
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    const onAbort = () => stop('aborted');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.once('error', (error) => finish(false, `${output}\n${error.message}`));
    child.once('exit', (code) => {
      if (terminating) return;
      terminating = true;
      void terminateProcessTree(child).then(
        () => finish(code === 0, output),
        (error) => failTermination(error),
      );
    });
    if (signal?.aborted) onAbort();

    function finish(ok: boolean, raw: string): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      void cleanup().finally(() => {
        resolve({ label: command, ok, output: sanitizeLog(raw.trim(), 8000) });
      });
    }

    function failTermination(error: unknown): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      void cleanup().finally(() => {
        reject(new AppError(
          'HOST_PROCESS_UNCERTAIN',
          `No se pudo confirmar la terminacion de --verify: ${error instanceof Error ? error.message : String(error)}`,
          1,
          { cause: error },
        ));
      });
    }
  });
}

export async function verifyWorkspace(
  workspace: string,
  commands: string[],
  timeoutMs = 15 * 60_000,
  signal?: AbortSignal,
): Promise<VerificationRecord> {
  const checks: VerificationCheck[] = [];
  const deadline = Date.now() + timeoutMs;
  const runGitChecks = async (suffix = ''): Promise<void> => {
    for (const args of [['diff', '--check'], ['diff', '--cached', '--check']]) {
      const label = `git ${args.join(' ')}${suffix}`;
      const remaining = deadline - Date.now();
      if (remaining <= 0 || signal?.aborted) {
        checks.push({ label, ok: false, output: signal?.aborted ? 'aborted' : 'timeout' });
        continue;
      }
      const result = await runGitCommand(args, workspace, Math.min(60_000, remaining), signal);
      checks.push({
        label,
        ok: result.exitCode === 0 && !result.timedOut,
        output: sanitizeLog((result.stderr || result.stdout).trim(), 8000),
      });
    }
  };
  await runGitChecks();
  for (const command of commands) {
    const remaining = deadline - Date.now();
    if (remaining <= 0 || signal?.aborted) {
      checks.push({ label: command, ok: false, output: signal?.aborted ? 'aborted' : 'timeout' });
      break;
    }
    checks.push(await runShell(command, workspace, remaining, signal));
  }
  await runGitChecks(' (final)');
  return {
    ok: checks.every((check) => check.ok),
    checkedAt: new Date().toISOString(),
    summary: checks.map((check) => `${check.ok ? 'PASS' : 'FAIL'} ${check.label}${check.output ? `\n${check.output}` : ''}`),
  };
}
