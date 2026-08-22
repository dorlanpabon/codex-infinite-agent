import { spawn } from 'node:child_process';
import path from 'node:path';
import { AppError } from './errors.js';

const MAX_OUTPUT_BYTES = 256 * 1024;

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

export function runCommand(command: string, args: string[], cwd: string, timeoutMs = 30_000): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const append = (current: string, chunk: Buffer) => (current + chunk.toString('utf8')).slice(0, MAX_OUTPUT_BYTES);
    child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      child.kill();
      finish(null, true);
    }, timeoutMs);
    child.once('error', (error) => {
      stderr = append(stderr, Buffer.from(error.message));
      finish(null, false);
    });
    child.once('exit', (exitCode) => finish(exitCode, false));

    function finish(exitCode: number | null, timedOut: boolean): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, timedOut });
    }
  });
}

async function git(args: string[], cwd: string, allowFailure = false): Promise<CommandResult> {
  const result = await runCommand('git', args, cwd);
  if (!allowFailure && result.exitCode !== 0) {
    throw new AppError('GIT_FAILED', `git ${args.join(' ')} fallo: ${(result.stderr || result.stdout).trim().slice(0, 2000)}`);
  }
  return result;
}

export async function resolveGitWorkspace(candidate: string): Promise<GitBaseline> {
  const requested = path.resolve(candidate);
  const rootResult = await git(['rev-parse', '--show-toplevel'], requested, true);
  if (rootResult.exitCode !== 0) {
    throw new AppError('NOT_A_GIT_REPOSITORY', `El directorio no pertenece a un repositorio Git: ${requested}`);
  }
  const root = path.resolve(rootResult.stdout.trim());
  const branchResult = await git(['branch', '--show-current'], root, true);
  const headResult = await git(['rev-parse', '--verify', 'HEAD'], root, true);
  const statusResult = await git(['status', '--porcelain=v1', '--untracked-files=normal'], root);
  return {
    root,
    branch: branchResult.exitCode === 0 && branchResult.stdout.trim() ? branchResult.stdout.trim() : null,
    head: headResult.exitCode === 0 ? headResult.stdout.trim() : null,
    dirty: statusResult.stdout.trim().length > 0,
  };
}

export async function currentGitSnapshot(root: string): Promise<GitBaseline> {
  return resolveGitWorkspace(root);
}
