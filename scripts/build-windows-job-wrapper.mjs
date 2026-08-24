import { spawnSync } from 'node:child_process';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  process.stdout.write(`Guardia Windows omitido en ${process.platform}/${process.arch}.\n`);
  process.exit(0);
}
if (process.arch !== 'x64') throw new Error(`El guardia Windows no soporta ${process.arch}.`);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nativeRoot = path.join(root, 'native', 'windows-job-wrapper');
const manifest = path.join(nativeRoot, 'Cargo.toml');
const result = spawnSync('cargo', ['build', '--manifest-path', manifest, '--release', '--locked'], {
  cwd: root,
  shell: false,
  stdio: 'inherit',
  windowsHide: true,
});
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`cargo build termino con codigo ${String(result.status)}.`);

const source = path.join(nativeRoot, 'target', 'release', 'codex-infinite-job-wrapper.exe');
const target = path.join(nativeRoot, 'bin', 'windows-x64', 'codex-infinite-job-wrapper.exe');
await mkdir(path.dirname(target), { recursive: true });
await copyFile(source, target);
process.stdout.write(`Guardia Windows compilado desde fuente: ${target}\n`);
