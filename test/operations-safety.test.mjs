import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

test('desktop adoption never creates a missing Goal with a non-atomic set', async () => {
  const source = await readFile(path.join(root, 'dist', 'operations.js'), 'utf8');
  const start = source.indexOf('async function attachGoal');
  const end = source.indexOf('async function resumeGoal', start);
  assert.ok(start >= 0 && end > start);
  const attachGoal = source.slice(start, end);

  assert.match(attachGoal, /remoteGoal === null/u);
  assert.doesNotMatch(attachGoal, /client\.setGoal\(/u);
});
