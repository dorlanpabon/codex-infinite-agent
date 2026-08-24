import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listPackage } from '@electron/asar';
import {
  flipFuses,
  FuseV1Options,
  FuseVersion,
  getCurrentFuseWire,
} from '@electron/fuses';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = path.join(root, 'out', `Codex Infinite-${process.platform}-${process.arch}`);
const resourcesRoot = process.platform === 'darwin'
  ? path.join(packageRoot, 'Codex Infinite.app', 'Contents', 'Resources')
  : path.join(packageRoot, 'resources');
const candidates = process.platform === 'darwin'
  ? [
    path.join(packageRoot, 'Codex Infinite.app', 'Contents', 'MacOS', 'CodexInfinite'),
    path.join(packageRoot, 'Codex Infinite.app', 'Contents', 'MacOS', 'Codex Infinite'),
  ]
  : [path.join(packageRoot, process.platform === 'win32' ? 'CodexInfinite.exe' : 'CodexInfinite')];

let executable = null;
for (const candidate of candidates) {
  if (await access(candidate).then(() => true).catch(() => false)) {
    executable = candidate;
    break;
  }
}
if (!executable) throw new Error(`No se encontro el ejecutable empaquetado en ${packageRoot}.`);

const archivePath = path.join(resourcesRoot, 'app.asar');
const archiveEntries = new Set(listPackage(archivePath).map((entry) => entry.replaceAll('\\', '/')));
for (const required of [
  '/dist/desktop/main.js',
  '/dist/desktop/preload.cjs',
  '/dist/desktop/contracts.js',
  '/dist/desktop/renderer/app.js',
  '/dist/desktop/renderer/index.html',
]) {
  if (!archiveEntries.has(required)) throw new Error(`Falta ${required} dentro de app.asar.`);
}
if (process.platform === 'win32') {
  await access(path.join(
    resourcesRoot,
    'app.asar.unpacked',
    'native',
    'windows-job-wrapper',
    'bin',
    'windows-x64',
    'codex-infinite-job-wrapper.exe',
  ));
}

const expected = {
  version: FuseVersion.V1,
  strictlyRequireAllFuses: true,
  resetAdHocDarwinSignature: process.platform === 'darwin' && process.arch === 'arm64',
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  [FuseV1Options.WasmTrapHandlers]: false,
};

await flipFuses(executable, expected);
const current = await getCurrentFuseWire(executable);
for (const [key, value] of Object.entries(expected)) {
  const expectedState = value ? 49 : 48;
  if (/^\d+$/.test(key) && current[key] !== expectedState) {
    throw new Error(`El fuse ${key} no quedo aplicado.`);
  }
}
process.stdout.write(`Fuses verificados: ${executable}\n`);
