import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validateAttachmentPaths } from '../dist/operations.js';

test('attachment validation resolves readable files, deduplicates, and rejects invalid targets', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'codex-infinite-attachments-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const file = path.join(temp, 'brief.txt');
  await writeFile(file, 'brief', 'utf8');

  assert.deepEqual(await validateAttachmentPaths([file, file]), [await realpath(file)]);
  await assert.rejects(() => validateAttachmentPaths([temp]), /no se puede leer/iu);
  await assert.rejects(() => validateAttachmentPaths([path.join(temp, 'missing.txt')]), /no se puede leer/iu);
  await assert.rejects(() => validateAttachmentPaths(Array.from({ length: 101 }, () => file)), /hasta 100/u);
});

test('attachment validation deduplicates a symbolic link by its real path', { skip: process.platform === 'win32' }, async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'codex-infinite-attachment-link-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const file = path.join(temp, 'brief.txt');
  const link = path.join(temp, 'brief-link.txt');
  await writeFile(file, 'brief', 'utf8');
  await symlink(file, link);

  assert.equal((await validateAttachmentPaths([file, link])).length, 1);
});
