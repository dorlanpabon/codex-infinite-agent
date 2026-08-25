import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

test('desktop adoption records explicit missing-Goal intent and rechecks before supervision', async () => {
  const source = await readFile(path.join(root, 'dist', 'operations.js'), 'utf8');
  const start = source.indexOf('async function attachGoal');
  const end = source.indexOf('async function resumeGoal', start);
  assert.ok(start >= 0 && end > start);
  const attachGoal = source.slice(start, end);

  assert.match(attachGoal, /currentGoal !== null/u);
  assert.match(attachGoal, /adoptingGoalMissing:\s*remoteGoal === null/u);
  assert.doesNotMatch(attachGoal, /client\.setGoal\(/u);
  const sessionsStart = source.indexOf('async function listDesktopSessions');
  const sessions = source.slice(sessionsStart);
  assert.match(sessions, /goal === null \|\| attachableGoal\(goal\)/u);
});
