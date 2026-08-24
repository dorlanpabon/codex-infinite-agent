import { access, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { AppError, errorMessage } from '../errors.js';
import {
  minimalWindowsEnvironment,
  resolveWindowsSystemExecutable,
  spawnManagedProcess,
  terminateProcessTree,
} from '../trusted-process.js';

const PROBE_OUTPUT_LIMIT = 128 * 1024;
export const FIXED_DESKTOP_BINARIES = Object.freeze({
  darwin: '/Applications/ChatGPT.app/Contents/Resources/codex',
  linux: '/usr/lib/chatgpt/resources/codex',
});

export function isSupportedDesktopPlatform(platform: NodeJS.Platform, arch: string): boolean {
  return (platform === 'win32' && arch === 'x64')
    || (platform === 'darwin' && arch === 'arm64')
    || (platform === 'linux' && (arch === 'x64' || arch === 'arm64'));
}

export interface BinaryInfo {
  path: string;
  version: string;
  source: 'explicit' | 'environment' | 'desktop-cache' | 'desktop-bundle' | 'desktop-package';
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
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let child;
    try {
      child = spawnManagedProcess(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ exitCode: null, stdout, stderr, timedOut: false });
      return;
    }
    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    if (!stdoutStream || !stderrStream) {
      resolve({ exitCode: null, stdout, stderr, timedOut: false });
      return;
    }
    let timeoutTriggered = false;
    const timer = setTimeout(() => {
      if (settled || timeoutTriggered) return;
      timeoutTriggered = true;
      void terminateProcessTree(child).then(
        () => finish(null, true),
        (error) => failTermination(error),
      );
    }, timeoutMs);

    const append = (current: string, chunk: Buffer) => {
      if (current.length >= PROBE_OUTPUT_LIMIT) return current;
      return (current + chunk.toString('utf8')).slice(0, PROBE_OUTPUT_LIMIT);
    };
    stdoutStream.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
    stderrStream.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.once('error', () => finish(null, false));
    child.once('exit', (code) => {
      if (timeoutTriggered) return;
      void terminateProcessTree(child).then(
        () => finish(code, false),
        (error) => failTermination(error),
      );
    });

    function finish(exitCode: number | null, timedOut: boolean) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, timedOut });
    }

    function failTermination(error: unknown): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new AppError(
        'HOST_PROCESS_UNCERTAIN',
        `No se pudo confirmar el cierre del probe de Codex Desktop: ${errorMessage(error)}`,
        1,
        { cause: error },
      ));
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
  const result = await new Promise<ProbeResult>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    try {
      const windowsRoot = 'C:\\Windows';
      const programFiles = 'C:\\Program Files';
      const powerShellModulePath = [
        path.join(programFiles, 'WindowsPowerShell', 'Modules'),
        path.join(windowsRoot, 'system32', 'WindowsPowerShell', 'v1.0', 'Modules'),
      ].join(path.delimiter);
      void resolveWindowsSystemExecutable(path.join('System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
        .then((powershell) => {
          const child = spawnManagedProcess(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: minimalWindowsEnvironment({ PSModulePath: powerShellModulePath, CODEX_INFINITE_VERIFY_BIN: candidate }),
          });
          const stdoutStream = child.stdout;
          const stderrStream = child.stderr;
          if (!stdoutStream || !stderrStream) {
            resolve({ exitCode: null, stdout, stderr, timedOut: false });
            return;
          }
          let timeoutTriggered = false;
          const timer = setTimeout(() => {
            timeoutTriggered = true;
            void terminateProcessTree(child).catch((error) => reject(new AppError(
              'HOST_PROCESS_UNCERTAIN',
              `No se pudo confirmar el cierre de la validacion Authenticode: ${errorMessage(error)}`,
              1,
              { cause: error },
            )));
          }, 5000);
          stdoutStream.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString('utf8')).slice(0, 8192); });
          stderrStream.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(0, 8192); });
          child.once('error', () => { clearTimeout(timer); resolve({ exitCode: null, stdout, stderr, timedOut: false }); });
          child.once('exit', (exitCode) => { clearTimeout(timer); resolve({ exitCode, stdout, stderr, timedOut: timeoutTriggered }); });
        })
        .catch(() => resolve({ exitCode: null, stdout, stderr, timedOut: false }));
    } catch {
      resolve({ exitCode: null, stdout, stderr, timedOut: false });
      return;
    }
  });
  if (result.exitCode !== 0) return false;
  try {
    const parsed = JSON.parse(result.stdout) as { Status?: unknown; Subject?: unknown };
    return parsed.Status === 'Valid' && typeof parsed.Subject === 'string' && /OpenAI OpCo|\bOpenAI\b/i.test(parsed.Subject);
  } catch {
    return false;
  }
}

async function verifyMacSignature(candidate: string): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  const bundle = '/Applications/ChatGPT.app';
  const codesign = '/usr/bin/codesign';
  const spctl = '/usr/sbin/spctl';
  if (!await isExecutableFile(codesign) || !await isExecutableFile(spctl)) return false;
  const bundleVerification = await runProbe(codesign, ['--verify', '--deep', '--strict', '--verbose=2', bundle], 15_000);
  if (bundleVerification.exitCode !== 0) return false;
  const details = await runProbe(codesign, ['--display', '--verbose=4', bundle]);
  const detailText = `${details.stdout}\n${details.stderr}`;
  if (details.exitCode !== 0 || !/^TeamIdentifier=2DC432GLL2$/m.test(detailText)) return false;
  const assessment = await runProbe(spctl, ['--assess', '--type', 'execute', '--verbose=2', bundle], 15_000);
  if (assessment.exitCode !== 0) return false;
  const resolved = await realpath(candidate).catch(() => null);
  const resources = await realpath('/Applications/ChatGPT.app/Contents/Resources').catch(() => null);
  if (!resolved || !resources) return false;
  const relative = path.relative(resources, resolved);
  return relative === 'codex';
}

async function rootOwnedAndImmutable(candidate: string, root: string): Promise<boolean> {
  const resolvedCandidate = await realpath(candidate).catch(() => null);
  const resolvedRoot = await realpath(root).catch(() => null);
  if (!resolvedCandidate || !resolvedRoot) return false;
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
  let current = resolvedCandidate;
  while (true) {
    const metadata = await stat(current).catch(() => null);
    if (!metadata || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0) return false;
    if (current === resolvedRoot) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

async function verifyLinuxPackage(candidate: string): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  const expected = FIXED_DESKTOP_BINARIES.linux;
  const resolved = await realpath(candidate).catch(() => null);
  const resolvedExpected = await realpath(expected).catch(() => null);
  if (!resolved || !resolvedExpected || resolved !== resolvedExpected) return false;
  if (!await rootOwnedAndImmutable(resolved, '/usr/lib/chatgpt')) return false;

  const dpkgQuery = '/usr/bin/dpkg-query';
  const dpkg = '/usr/bin/dpkg';
  if (await isExecutableFile(dpkgQuery) && await isExecutableFile(dpkg)) {
    const owner = await runProbe(dpkgQuery, ['-S', expected]);
    if (owner.exitCode !== 0 || !/^chatgpt(?::[^:]+)?:\s+\/usr\/lib\/chatgpt\/resources\/codex$/m.test(owner.stdout.trim())) return false;
    const status = await runProbe(dpkgQuery, ['-W', '-f=${db:Status-Abbrev}', 'chatgpt']);
    if (status.exitCode !== 0 || status.stdout.trim() !== 'ii') return false;
    const verified = await runProbe(dpkg, ['--verify', 'chatgpt'], 15_000);
    return verified.exitCode === 0 && `${verified.stdout}\n${verified.stderr}`.trim() === '';
  }

  const rpm = '/usr/bin/rpm';
  if (await isExecutableFile(rpm)) {
    const owner = await runProbe(rpm, ['-qf', expected, '--queryformat', '%{NAME}']);
    if (owner.exitCode !== 0 || owner.stdout.trim() !== 'chatgpt') return false;
    const verified = await runProbe(rpm, ['--verify', 'chatgpt'], 15_000);
    return verified.exitCode === 0 && `${verified.stdout}\n${verified.stderr}`.trim() === '';
  }
  return false;
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

async function isDesktopBundlePath(candidate: string): Promise<boolean> {
  const resolved = await realpath(path.resolve(candidate)).catch(() => null);
  if (!resolved) return false;
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) return false;
    const root = await realpath(path.resolve(localAppData, 'OpenAI', 'Codex', 'bin')).catch(() => null);
    if (!root) return false;
    const relative = path.relative(root, resolved);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
      && path.basename(resolved).toLowerCase() === 'codex.exe';
  }
  if (process.platform === 'darwin') {
    return resolved === await realpath(FIXED_DESKTOP_BINARIES.darwin).catch(() => null);
  }
  if (process.platform === 'linux') {
    return resolved === await realpath(FIXED_DESKTOP_BINARIES.linux).catch(() => null);
  }
  return false;
}

async function validateCandidate(candidate: string, source: BinaryInfo['source']): Promise<BinaryInfo | null> {
  const resolved = await realpath(path.resolve(candidate)).catch(() => null);
  if (!resolved || !await isDesktopBundlePath(resolved)) return null;
  if (!await isExecutableFile(resolved)) return null;
  const signedByOpenAI = process.platform === 'win32'
    ? await verifyWindowsSignature(resolved)
    : process.platform === 'darwin'
      ? await verifyMacSignature(resolved)
      : process.platform === 'linux'
        ? await verifyLinuxPackage(resolved)
        : false;
  if (signedByOpenAI !== true) return null;

  const versionProbe = await runProbe(resolved, ['--version']);
  const version = `${versionProbe.stdout}\n${versionProbe.stderr}`.trim().split(/\r?\n/)[0] ?? '';
  if (versionProbe.exitCode !== 0 || !/^codex-cli\s+/i.test(version)) return null;
  const appServerProbe = await runProbe(resolved, ['app-server', '--help']);
  if (appServerProbe.exitCode !== 0 || !/app-server|app server/i.test(`${appServerProbe.stdout}\n${appServerProbe.stderr}`)) return null;

  return { path: resolved, version, source, signedByOpenAI };
}

export async function discoverCodexBinary(explicit?: string): Promise<BinaryInfo> {
  if (!isSupportedDesktopPlatform(process.platform, process.arch)) {
    throw new AppError('UNSUPPORTED_PLATFORM', `Codex Infinite Agent no soporta ${process.platform}/${process.arch}.`);
  }
  const configured = explicit || process.env.CODEX_APP_SERVER_BIN;
  if (configured) {
    const source = explicit ? 'explicit' : 'environment';
    const info = await validateCandidate(configured, source);
    if (!info) {
      throw new AppError('INVALID_CODEX_BINARY', `El binario configurado no pertenece a un App Server compatible y verificable: ${path.resolve(configured)}`);
    }
    return info;
  }

  const groups: Array<{ source: BinaryInfo['source']; candidates: string[] }> = [
    ...(process.platform === 'win32'
      ? [{ source: 'desktop-cache' as const, candidates: await desktopCacheCandidates() }]
      : process.platform === 'darwin'
        ? [{ source: 'desktop-bundle' as const, candidates: [FIXED_DESKTOP_BINARIES.darwin] }]
        : [{ source: 'desktop-package' as const, candidates: [FIXED_DESKTOP_BINARIES.linux] }]),
  ];

  const seen = new Set<string>();
  for (const group of groups) {
    for (const candidate of group.candidates) {
      const key = process.platform === 'win32' ? path.resolve(candidate).toLowerCase() : path.resolve(candidate);
      if (seen.has(key)) continue;
      seen.add(key);
      const info = await validateCandidate(candidate, group.source);
      if (info) return info;
    }
  }

  throw new AppError(
    'CODEX_DESKTOP_NOT_FOUND',
    'No se encontro un binario verificable de Codex Desktop con App Server. Instala/actualiza ChatGPT Desktop o define CODEX_APP_SERVER_BIN dentro de su bundle oficial.',
  );
}
