import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { verifyWorkspace } from '../dist/verify.js';

test('host verification honors abort and returns a failed check', async () => {
  const controller = new AbortController();
  const started = Date.now();
  const timer = setTimeout(() => controller.abort(), 100);
  const command = 'node -e "setTimeout(() => {}, 60000)"';
  const result = await verifyWorkspace(process.cwd(), [command], 10_000, controller.signal);
  clearTimeout(timer);

  assert.equal(result.ok, false);
  assert.match(result.summary.join('\n'), /aborted/);
  assert.ok(Date.now() - started < 8_000);
});

test('host verification preserves quoted Windows command payloads', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows only');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'codex infinite verify '));
  const marker = path.join(temp, 'quoted marker.txt');
  t.after(() => rm(temp, { recursive: true, force: true }));
  const script = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ok')`;
  const result = await verifyWorkspace(process.cwd(), [`node -e ${JSON.stringify(script)}`], 10_000);

  assert.equal(result.ok, true, result.summary.join('\n'));
  assert.equal(await readFile(marker, 'utf8'), 'ok');
});
