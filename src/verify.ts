import { spawn } from 'node:child_process';
import { sanitizeLog } from './log.js';
import { runCommand } from './git.js';
import type { VerificationRecord } from './state.js';

const MAX_CAPTURE = 64 * 1024;

interface VerificationCheck {
  label: string;
  ok: boolean;
  output: string;
}

function runShell(command: string, cwd: string, timeoutMs: number): Promise<VerificationCheck> {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const append = (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(0, MAX_CAPTURE); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => {
      child.kill();
      finish(false, `${output}\n[timeout]`);
    }, timeoutMs);
    child.once('error', (error) => finish(false, `${output}\n${error.message}`));
    child.once('exit', (code) => finish(code === 0, output));

    function finish(ok: boolean, raw: string): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ label: command, ok, output: sanitizeLog(raw.trim(), 8000) });
    }
  });
}

export async function verifyWorkspace(workspace: string, commands: string[], timeoutMs = 15 * 60_000): Promise<VerificationRecord> {
  const checks: VerificationCheck[] = [];
  for (const args of [['diff', '--check'], ['diff', '--cached', '--check']]) {
    const result = await runCommand('git', args, workspace, 60_000);
    checks.push({
      label: `git ${args.join(' ')}`,
      ok: result.exitCode === 0 && !result.timedOut,
      output: sanitizeLog((result.stderr || result.stdout).trim(), 8000),
    });
  }
  for (const command of commands) checks.push(await runShell(command, workspace, timeoutMs));
  return {
    ok: checks.every((check) => check.ok),
    checkedAt: new Date().toISOString(),
    summary: checks.map((check) => `${check.ok ? 'PASS' : 'FAIL'} ${check.label}${check.output ? `\n${check.output}` : ''}`),
  };
}
