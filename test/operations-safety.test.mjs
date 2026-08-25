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
  assert.match(attachGoal, /listRecentTurns\(thread\.id, 1\)/u);
  assert.match(attachGoal, /state\.turnBaselineId\s*=/u);
  assert.doesNotMatch(attachGoal, /state\.maxTurns\s*=\s*state\.turnCount/u);
  assert.doesNotMatch(attachGoal, /client\.setGoal\(/u);
  const sessionsStart = source.indexOf('async function listDesktopSessions');
  const sessions = source.slice(sessionsStart);
  assert.match(sessions, /goal === null \|\| attachableGoal\(goal\)/u);
});

test('direct desktop session lookup does not depend on the bounded session list', async () => {
  const source = await readFile(path.join(root, 'dist', 'operations.js'), 'utf8');
  const start = source.indexOf('async function getDesktopSession');
  const end = source.indexOf('async function doctorDesktop', start);
  assert.ok(start >= 0 && end > start);
  const getDesktopSession = source.slice(start, end);

  assert.match(getDesktopSession, /client\.readThread\(threadId\)/u);
  assert.match(getDesktopSession, /describeDesktopSession\(/u);
  assert.doesNotMatch(getDesktopSession, /listThreads\(/u);
  assert.doesNotMatch(getDesktopSession, /listDesktopSessions\(/u);
});
