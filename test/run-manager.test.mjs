import assert from 'node:assert/strict';
import test from 'node:test';
import { RunManager } from '../dist/desktop/run-manager.js';
import { createRunState } from '../dist/state.js';

const runId = '123e4567-e89b-42d3-a456-426614174000';

function state(status = 'initializing') {
  const value = createRunState({
    workspace: process.cwd(),
    objective: 'Complete the goal',
    name: 'Infinite test',
    maxTurns: 3,
    turnTimeoutMs: 60_000,
    maxWallTimeMs: 3_600_000,
    tokenBudget: null,
    network: false,
    dangerFullAccess: false,
    verifyCommands: [],
    model: null,
    effort: null,
    gitBaseline: { root: process.cwd(), branch: 'main', head: null, dirty: false },
  });
  value.runId = runId;
  value.status = status;
  return value;
}

const startInput = {
  objective: 'Complete the goal',
  attachments: [],
  workspace: process.cwd(),
  name: null,
  maxTurns: 3,
  maxHours: 1,
  turnMinutes: 1,
  tokenBudget: null,
  verifyCommands: [],
  model: null,
  effort: null,
  network: false,
  dangerFullAccess: false,
  dangerConfirmation: false,
  binary: null,
};

test('run manager forwards the selected native model and effort unchanged', async () => {
  let received;
  const execute = async (options, _signal, _logger, hooks) => {
    received = options;
    const value = state('completed');
    value.model = options.model;
    value.effort = options.effort;
    hooks?.onRunChanged?.(value);
    return value;
  };
  const manager = new RunManager(() => undefined, { startGoal: execute, resumeGoal: execute });

  await manager.start({ ...startInput, model: 'gpt-native-default', effort: 'max' });
  await manager.shutdown();

  assert.equal(received.model, 'gpt-native-default');
  assert.equal(received.effort, 'max');
});

function controlledExecutor() {
  return async (_options, signal, _logger, hooks) => {
    const value = state('running');
    hooks?.onRunChanged?.(value);
    await new Promise((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', resolve, { once: true });
    });
    value.status = 'paused';
    return value;
  };
}

test('run manager starts asynchronously and pauses only its owned run', async () => {
  const events = [];
  const execute = controlledExecutor();
  const manager = new RunManager((event) => events.push(event), { startGoal: execute, resumeGoal: execute });
  const receipt = await manager.start(startInput);
  assert.match(receipt.operationId, /^[0-9a-f-]{36}$/i);
  assert.equal(manager.hasActiveOperations, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.some((event) => event.type === 'run-changed' && event.run.runId === runId), true);

  assert.equal(manager.pause(runId).operationId, receipt.operationId);
  await manager.shutdown();
  assert.equal(events.some((event) => event.type === 'operation-finished' && event.run.status === 'paused'), true);
  assert.equal(manager.hasActiveOperations, false);
});

test('run manager does not announce a new run until durable state is published', async () => {
  const events = [];
  let continuePreflight;
  const preflight = new Promise((resolve) => { continuePreflight = resolve; });
  const execute = async (_options, signal, _logger, hooks) => {
    await preflight;
    const value = state('running');
    hooks?.onRunChanged?.(value);
    await new Promise((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', resolve, { once: true });
    });
    value.status = 'paused';
    return value;
  };
  const manager = new RunManager((event) => events.push(event), { startGoal: execute, resumeGoal: execute });
  let receiptSettled = false;
  const receiptPromise = manager.start(startInput).then((receipt) => {
    receiptSettled = true;
    return receipt;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(receiptSettled, false);
  assert.equal(events.some((event) => event.type === 'operation-started'), false);

  continuePreflight();
  const receipt = await receiptPromise;
  assert.match(receipt.operationId, /^[0-9a-f-]{36}$/i);
  assert.equal(events.some((event) => event.type === 'operation-started' && event.runId === runId), true);
  manager.pause(runId);
  await manager.shutdown();
});

test('run manager rejects an unpersisted preflight failure without announcing a run', async () => {
  const events = [];
  const failPreflight = async () => { throw new Error('preflight failed'); };
  const manager = new RunManager((event) => events.push(event), {
    startGoal: failPreflight,
    resumeGoal: failPreflight,
  });

  await assert.rejects(manager.start(startInput), /preflight failed/u);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.some((event) => event.type === 'operation-started'), false);
  assert.equal(manager.hasActiveOperations, false);
});

test('run manager rejects duplicate resumes and unowned pause requests', async () => {
  const execute = controlledExecutor();
  const manager = new RunManager(() => undefined, { startGoal: execute, resumeGoal: execute });
  const input = {
    runId,
    verifyCommands: [],
    network: false,
    dangerFullAccess: false,
    dangerConfirmation: false,
    binary: null,
  };
  manager.resume(input);
  assert.throws(() => manager.resume(input), /ya esta activa/i);
  assert.throws(() => manager.pause('123e4567-e89b-42d3-b456-426614174000'), /Solo se puede pausar/i);
  manager.pause(runId);
  await manager.shutdown();
});
