import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  acquireWorkspaceLock,
  createRunState,
  listRuns,
  loadRun,
  saveRun,
} from '../dist/state.js';

function stateFor(workspace) {
  return createRunState({
    workspace,
    objective: 'Test objective',
    name: 'Test run',
    maxTurns: 3,
    turnTimeoutMs: 1000,
    maxWallTimeMs: 60_000,
    tokenBudget: 1000,
    network: false,
    dangerFullAccess: false,
    verifyCommands: [],
    model: null,
    effort: null,
    gitBaseline: { root: workspace, branch: 'main', head: null, dirty: false },
  });
}

test('run state is saved atomically and listed', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'codex-infinite-state-'));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = temp;
  t.after(async () => {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    await rm(temp, { recursive: true, force: true });
  });

  const state = stateFor(process.cwd());
  await saveRun(state);
  state.status = 'running';
  state.turnCount = 1;
  state.observedTurnIds.push('turn-one');
  await saveRun(state);

  assert.deepEqual(await loadRun(state.runId), state);
  assert.deepEqual((await listRuns()).map((item) => item.runId), [state.runId]);
});

test('workspace lock excludes a second supervisor and can be released', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'codex-infinite-lock-'));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = temp;
  t.after(async () => {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    await rm(temp, { recursive: true, force: true });
  });

  const workspace = path.resolve(process.cwd());
  const first = await acquireWorkspaceLock(workspace, 'run-one');
  await assert.rejects(() => acquireWorkspaceLock(workspace, 'run-two'), /ya esta supervisado/);
  await first.release();
  const second = await acquireWorkspaceLock(workspace, 'run-two');
  await second.release();
});

test('workspace quarantine survives lock release and fails closed', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'codex-infinite-quarantine-'));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = temp;
  t.after(async () => {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    await rm(temp, { recursive: true, force: true });
  });

  const workspace = path.resolve(process.cwd());
  const first = await acquireWorkspaceLock(workspace, 'run-quarantine');
  await first.quarantine('uncertain process cleanup');
  await first.release();
  await assert.rejects(() => acquireWorkspaceLock(workspace, 'run-after-quarantine'), /cuarentena/);
});

test('loadRun rejects a mismatched id and tampered security fields', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'codex-infinite-tamper-'));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = temp;
  t.after(async () => {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    await rm(temp, { recursive: true, force: true });
  });

  const state = stateFor(process.cwd());
  await saveRun(state);
  const statePath = path.join(temp, 'infinite-agent', 'runs', `${state.runId}.json`);
  const stored = JSON.parse(await readFile(statePath, 'utf8'));
  stored.runId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  stored.dangerFullAccess = 'false';
  await writeFile(statePath, `${JSON.stringify(stored)}\n`, 'utf8');

  await assert.rejects(() => loadRun(state.runId), /incompatible o corrupto|no coincide/);
});

test('state v2 round-trips bounded native evidence and rejects self-inconsistent saves', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'codex-infinite-schema-'));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = temp;
  t.after(async () => {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    await rm(temp, { recursive: true, force: true });
  });

  const state = stateFor(process.cwd());
  state.observedTurnIds = ['turn-boundary'];
  state.turnCount = 1;
  state.lastTurn = {
    turnId: 'turn-boundary',
    status: 'completed',
    error: null,
    failedItems: ['x'.repeat(1000)],
    blockedReason: null,
  };
  state.lastVerification = {
    ok: false,
    checkedAt: new Date().toISOString(),
    summary: ['y'.repeat(10_000)],
  };
  await saveRun(state);
  assert.equal((await loadRun(state.runId)).schemaVersion, 2);

  state.turnCount = 2;
  await assert.rejects(() => saveRun(state), /incompatible o corrupto/);
});
