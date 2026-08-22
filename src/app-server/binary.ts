import { spawn } from 'node:child_process';
import { access, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { constants } from 'node:fs';
import { AppError } from '../errors.js';

const PROBE_OUTPUT_LIMIT = 128 * 1024;

export interface BinaryInfo {
  path: string;
  version: string;
  source: 'explicit' | 'environment' | 'desktop-cache' | 'plugin-runtime' | 'application' | 'path';
  signedByOpenAI: boolean | null;
}

interface ProbeResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

export function runProbe(binary: string, args: string[], timeoutMs = 5000): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let child;
    try {
      child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ exitCode: null, stdout, stderr, timedOut: false });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      finish(null, true);
    }, timeoutMs);

    const append = (current: string, chunk: Buffer) => {
      if (current.length >= PROBE_OUTPUT_LIMIT) return current;
      return (current + chunk.toString('utf8')).slice(0, PROBE_OUTPUT_LIMIT);
    };
    child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.once('error', () => finish(null, false));
    child.once('exit', (code) => finish(code, false));

    function finish(exitCode: number | null, timedOut: boolean) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, timedOut });
    }
  });
}

async function verifyWindowsSignature(candidate: string): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  const script = [
    '$s = Get-AuthenticodeSignature -LiteralPath $env:CODEX_INFINITE_VERIFY_BIN',
    '$subject = if ($s.SignerCertificate) { $s.SignerCertificate.Subject } else { "" }',
    '[pscustomobject]@{ Status = [string]$s.Status; Subject = $subject } | ConvertTo-Json -Compress',
  ].join('; ');
  const result = await new Promise<ProbeResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      const windowsRoot = process.env.WINDIR ?? 'C:\\Windows';
      const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
      const powerShellModulePath = [
        path.join(programFiles, 'WindowsPowerShell', 'Modules'),
        path.join(windowsRoot, 'system32', 'WindowsPowerShell', 'v1.0', 'Modules'),
      ].join(path.delimiter);
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PSModulePath: powerShellModulePath, CODEX_INFINITE_VERIFY_BIN: candidate },
      });
    } catch {
      resolve({ exitCode: null, stdout, stderr, timedOut: false });
      return;
    }
    const timer = setTimeout(() => child.kill(), 5000);
    child.stdout.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString('utf8')).slice(0, 8192); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(0, 8192); });
    child.once('error', () => { clearTimeout(timer); resolve({ exitCode: null, stdout, stderr, timedOut: false }); });
    child.once('exit', (exitCode) => { clearTimeout(timer); resolve({ exitCode, stdout, stderr, timedOut: false }); });
  });
  if (result.exitCode !== 0) return false;
  try {
    const parsed = JSON.parse(result.stdout) as { Status?: unknown; Subject?: unknown };
    return parsed.Status === 'Valid' && typeof parsed.Subject === 'string' && /OpenAI OpCo|\bOpenAI\b/i.test(parsed.Subject);
  } catch {
    return false;
  }
}

async function desktopCacheCandidates(): Promise<string[]> {
  if (process.platform !== 'win32') return [];
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return [];
  const root = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name, 'codex.exe'));
  const ranked = await Promise.all(candidates.map(async (candidate) => {
    try {
      return { candidate, modified: (await stat(candidate)).mtimeMs };
    } catch {
      return { candidate, modified: 0 };
    }
  }));
  return ranked.sort((a, b) => b.modified - a.modified).map(({ candidate }) => candidate);
}

async function pathCandidates(): Promise<string[]> {
  const command = process.platform === 'win32' ? 'where.exe' : 'which';
  const args = process.platform === 'win32' ? ['codex.exe'] : ['-a', 'codex'];
  const result = await runProbe(command, args, 3000);
  if (result.exitCode !== 0) return [];
  return result.stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
}

function applicationCandidates(): string[] {
  if (process.platform === 'darwin') {
    return [
      '/Applications/Codex.app/Contents/Resources/codex',
      '/Applications/ChatGPT.app/Contents/Resources/codex',
    ];
  }
  return [];
}

async function validateCandidate(candidate: string, source: BinaryInfo['source'], requireSignature: boolean): Promise<BinaryInfo | null> {
  const resolved = path.resolve(candidate);
  if (!await isExecutableFile(resolved)) return null;
  const versionProbe = await runProbe(resolved, ['--version']);
  const version = `${versionProbe.stdout}\n${versionProbe.stderr}`.trim().split(/\r?\n/)[0] ?? '';
  if (versionProbe.exitCode !== 0 || !/^codex-cli\s+/i.test(version)) return null;
  const appServerProbe = await runProbe(resolved, ['app-server', '--help']);
  if (appServerProbe.exitCode !== 0 || !/app-server|app server/i.test(`${appServerProbe.stdout}\n${appServerProbe.stderr}`)) return null;

  const signedByOpenAI = process.platform === 'win32' ? await verifyWindowsSignature(resolved) : null;
  if (requireSignature && signedByOpenAI !== true) return null;
  return { path: resolved, version, source, signedByOpenAI };
}

export async function discoverCodexBinary(explicit?: string): Promise<BinaryInfo> {
  const configured = explicit || process.env.CODEX_APP_SERVER_BIN;
  if (configured) {
    const source = explicit ? 'explicit' : 'environment';
    const info = await validateCandidate(configured, source, process.platform === 'win32');
    if (!info) {
      throw new AppError('INVALID_CODEX_BINARY', `El binario configurado no es una CLI oficial compatible con App Server: ${path.resolve(configured)}`);
    }
    return info;
  }

  const home = os.homedir();
  const groups: Array<{ source: BinaryInfo['source']; candidates: string[] }> = [
    { source: 'desktop-cache', candidates: await desktopCacheCandidates() },
    {
      source: 'plugin-runtime',
      candidates: process.platform === 'win32' ? [
        path.join(home, '.codex', 'plugins', '.plugin-appserver', 'codex.exe'),
        path.join(home, '.codex', '.sandbox-bin', 'codex.exe'),
      ] : [],
    },
    { source: 'application', candidates: applicationCandidates() },
    { source: 'path', candidates: await pathCandidates() },
  ];

  const seen = new Set<string>();
  for (const group of groups) {
    for (const candidate of group.candidates) {
      const key = process.platform === 'win32' ? path.resolve(candidate).toLowerCase() : path.resolve(candidate);
      if (seen.has(key)) continue;
      seen.add(key);
      const info = await validateCandidate(candidate, group.source, process.platform === 'win32');
      if (info) return info;
    }
  }

  throw new AppError(
    'CODEX_DESKTOP_NOT_FOUND',
    'No se encontro un binario firmado de Codex Desktop con App Server. Abre/actualiza Codex Desktop o define CODEX_APP_SERVER_BIN.',
  );
}
