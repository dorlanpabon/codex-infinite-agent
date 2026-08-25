import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('CLI informa la misma versión que el paquete', async () => {
  const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const version = execFileSync(process.execPath, [path.join(root, 'dist', 'bin', 'codex-infinite.js'), '--version'], {
    encoding: 'utf8',
  }).trim();
  assert.equal(version, metadata.version);
});
