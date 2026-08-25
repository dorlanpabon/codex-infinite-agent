import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const tag = process.argv[2] ?? process.env.RELEASE_TAG;
if (tag !== `v${packageJson.version}` || !/^v\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)(?:\.\d+)?)?$/.test(tag)) {
  throw new Error(`El tag ${String(tag)} no coincide con v${packageJson.version}.`);
}

const releaseRoot = path.join(root, 'release-assets');
const expected = [
  `Codex-Infinite-${packageJson.version}-windows-x64-Setup.exe`,
  `Codex-Infinite-${packageJson.version}-macos-arm64.zip`,
  `Codex-Infinite-${packageJson.version}-macos-x64.zip`,
  `Codex-Infinite-${packageJson.version}-linux-x64.deb`,
  `Codex-Infinite-${packageJson.version}-linux-x64.rpm`,
  `Codex-Infinite-${packageJson.version}-linux-arm64.deb`,
  `Codex-Infinite-${packageJson.version}-linux-arm64.rpm`,
].sort();
const actual = (await readdir(releaseRoot, { withFileTypes: true }))
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)
  .sort();
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  throw new Error(`Set de artefactos incompleto. Esperado=${expected.join(', ')} Actual=${actual.join(', ')}`);
}

const checksums = [];
for (const name of expected) {
  const file = path.join(releaseRoot, name);
  if ((await stat(file)).size < 1024) throw new Error(`Artefacto vacio o truncado: ${name}.`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  checksums.push(`${hash.digest('hex')}  ${name}`);
}
await writeFile(path.join(releaseRoot, 'SHA256SUMS.txt'), `${checksums.join('\n')}\n`, 'utf8');
process.stdout.write(`Release ${tag} verificado con ${expected.length} artefactos.\n`);
