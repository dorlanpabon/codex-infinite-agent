import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const tag = process.argv[2] ?? process.env.RELEASE_TAG;
const expected = `v${packageJson.version}`;
if (tag !== expected || !/^v\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)(?:\.\d+)?)?$/.test(tag)) {
  throw new Error(`El tag ${String(tag)} no coincide exactamente con ${expected}.`);
}
process.stdout.write(`Tag de release verificado: ${tag}\n`);
