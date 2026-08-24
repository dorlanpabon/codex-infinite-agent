import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
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
const require = createRequire(import.meta.url);
const { packagerConfig } = require('../forge.config.cjs');
const { executableName, name: packageName } = packagerConfig;
if (!/^[A-Za-z0-9._-]+$/u.test(packageName) || !/^[A-Za-z0-9._-]+$/u.test(executableName)) {
  throw new Error('Los nombres tecnicos del paquete deben ser segmentos de ruta sin espacios.');
}
const packageRoot = path.join(root, 'out', `${packageName}-${process.platform}-${process.arch}`);
const appBundle = `${packageName}.app`;
const resourcesRoot = process.platform === 'darwin'
  ? path.join(packageRoot, appBundle, 'Contents', 'Resources')
  : path.join(packageRoot, 'resources');
const candidates = process.platform === 'darwin'
  ? [path.join(packageRoot, appBundle, 'Contents', 'MacOS', executableName)]
  : [path.join(packageRoot, process.platform === 'win32' ? `${executableName}.exe` : executableName)];

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
const allowedArchiveRoots = new Set([
  'dist',
  'native',
  'node_modules',
  'package.json',
  'README.md',
  'SECURITY.md',
  'LICENSE',
]);
const allowedRuntimeModules = new Set(['debug', 'electron-squirrel-startup', 'ms']);
const allowedNativeEntries = new Set([
  '/native',
  '/native/windows-job-wrapper',
  '/native/windows-job-wrapper/bin',
  '/native/windows-job-wrapper/bin/windows-x64',
  '/native/windows-job-wrapper/bin/windows-x64/codex-infinite-job-wrapper.exe',
]);
for (const entry of archiveEntries) {
  const segments = entry.split('/').filter(Boolean);
  const archiveRoot = segments[0];
  if (!archiveRoot || !allowedArchiveRoots.has(archiveRoot)) {
    throw new Error(`Entrada inesperada dentro de app.asar: ${entry}.`);
  }
  if (archiveRoot === 'node_modules' && segments[1] && !allowedRuntimeModules.has(segments[1])) {
    throw new Error(`Dependencia no permitida dentro de app.asar: ${entry}.`);
  }
  if (archiveRoot === 'native' && (!allowedNativeEntries.has(entry) || process.platform !== 'win32')) {
    throw new Error(`Binario nativo inesperado dentro de app.asar: ${entry}.`);
  }
  if (allowedArchiveRoots.has(archiveRoot) && !['dist', 'native', 'node_modules'].includes(archiveRoot) && segments.length !== 1) {
    throw new Error(`Ruta inesperada dentro de app.asar: ${entry}.`);
  }
}
for (const required of [
  '/dist/desktop/main.js',
  '/dist/generated/windows-job-wrapper-integrity.js',
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
