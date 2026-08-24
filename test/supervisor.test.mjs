import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRunState } from '../dist/state.js';
import { supervise } from '../dist/supervisor.js';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

function goal(status, tokensUsed = 10) {
  return {
    threadId: 'thread-test',
    objective: 'Finish the test goal',
    status,
    tokenBudget: 1000,
    tokensUsed,
    timeUsedSeconds: 1,
    createdAt: 1,
    updatedAt: 2,
  };
}

class FakeClient {
  constructor(terminals = ['complete'], initialGoal = null) {
    this.terminals = [...terminals];
    this.currentGoal = initialGoal;
    this.goalUpdates = [];
    this.runGoalCalls = [];
    this.injected = [];
    this.configureCalls = [];
    this.threadStatus = { type: 'idle' };
    this.failFinalGoalConfirmation = false;
    this.completeGoalReads = 0;
    this.resumeCalls = 0;
    this.persistedTurns = initialGoal?.status === 'complete' ? [{
      turnId: 'turn-persisted', status: 'completed', finalText: 'done', error: null,
    }] : [];
    this.turnStatuses = [];
    this.turnBlockedReason = null;
  }

  async startThread(workspace) {
    return { id: 'thread-test', cwd: workspace };
  }

  async readThread(_threadId) {
    return { id: 'thread-test', cwd: process.cwd(), status: this.threadStatus };
  }

  async resumeThread(threadId, workspace) {
    this.resumeCalls += 1;
    return { id: threadId, cwd: workspace, status: { type: 'idle' } };
  }

  async configureThread(settings) {
    this.configureCalls.push(settings);
  }

  async restoreSafeThreadSettings() {}

  async prepareThreadForTerminal() {}

  async setThreadName() {}

  async getGoal() {
    if (this.currentGoal?.status === 'complete') {
      this.completeGoalReads += 1;
      if (this.failFinalGoalConfirmation && this.completeGoalReads === 2) throw new Error('goal confirmation failed');
    }
    return this.currentGoal;
  }

  async setGoal(_threadId, objective, status) {
    this.goalUpdates.push({ objective, status });
    this.currentGoal = { ...(this.currentGoal ?? goal(status)), status };
    return this.currentGoal;
  }

  async runNativeGoal(options) {
    this.runGoalCalls.push(options);
    const index = this.runGoalCalls.length;
    const turnId = `turn-${index}`;
    const active = { ...goal('active', index * 10), tokenBudget: options.tokenBudget ?? null };
    this.currentGoal = active;
    await options.onActivated?.(active);
    await options.onGoalUpdated?.(active);
    await options.onTurnStarted?.(turnId);
    const terminalStatus = this.terminals.shift();
    assert.notEqual(terminalStatus, undefined, 'fake terminal sequence exhausted');
    const terminal = { ...goal(terminalStatus, index * 10), tokenBudget: options.tokenBudget ?? null };
    this.currentGoal = terminal;
    await options.onGoalUpdated?.(terminal);
    const turnStatus = this.turnStatuses.shift() ?? 'completed';
    const turn = {
      threadId: 'thread-test',
      turnId,
      status: turnStatus,
      finalText: 'done',
      totalTokens: index * 10,
      error: turnStatus === 'failed' ? 'model failure' : null,
      failedItems: [],
      blockedReason: this.turnBlockedReason,
    };
    await options.onTurnCompleted?.(turn);
    return { goal: terminal, lastTurn: turn, turnsStarted: 1, activeTurnId: null, stopReason: null };
  }

  async injectText(_threadId, text) {
    this.injected.push(text);
  }

  async readTurn(_threadId, turnId) {
    return this.persistedTurns.find((turn) => turn.turnId === turnId) ?? null;
  }

  async listTurns() {
    return this.persistedTurns;
  }

  async interrupt() {}
}

function createState(workspace, overrides = {}) {
  return createRunState({
    workspace,
    objective: 'Finish the test goal',
    name: 'Supervisor test',
    maxTurns: 5,
    turnTimeoutMs: 10_000,
    maxWallTimeMs: 60_000,
    tokenBudget: 1000,
    network: false,
    dangerFullAccess: false,
    verifyCommands: [],
    model: null,
    effort: null,
    gitBaseline: { root: workspace, branch: 'main', head: null, dirty: false },
    ...overrides,
  });
}

async function withStateHome(t) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'codex-infinite-supervisor-'));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = temp;
  t.after(async () => {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    await rm(temp, { recursive: true, force: true });
  });
  return temp;
}

test('supervisor completes only after native Goal and host verification', async (t) => {
  await withStateHome(t);
  const client = new FakeClient(['complete']);
  const result = await supervise(client, createState(process.cwd()), silentLogger, {
    resume: false,
    signal: new AbortController().signal,
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.nativeGoalStatus, 'complete');
  assert.equal(result.turnCount, 1);
  assert.equal(result.lastVerification.ok, true);
  assert.equal(result.gitFinal.root, process.cwd());
  assert.equal(client.runGoalCalls.length, 1);
  assert.equal(client.runGoalCalls[0].objective, 'Finish the test goal');
});

test('supervisor preserves a native blocked result', async (t) => {
  await withStateHome(t);
  const client = new FakeClient(['blocked']);
  const result = await supervise(client, createState(process.cwd()), silentLogger, {
    resume: false,
    signal: new AbortController().signal,
  });

  assert.equal(result.status, 'blocked');
  assert.equal(result.nativeGoalStatus, 'blocked');
  assert.match(result.lastError, /bloqueado/);
});

test('native paused state drains hidden durable turns before returning', async (t) => {
  await withStateHome(t);
  const client = new FakeClient(['paused']);
  client.threadStatus = { type: 'active', activeFlags: [] };
  client.persistedTurns = [{
    turnId: 'turn-hidden-after-pause',
    status: 'inProgress',
    finalText: null,
    error: null,
    blockedReason: null,
  }];
  const interrupted = [];
  client.interrupt = async (_threadId, turnId) => {
    interrupted.push(turnId);
    client.persistedTurns[0].status = 'interrupted';
    client.threadStatus = { type: 'idle' };
  };

  const result = await supervise(client, createState(process.cwd()), silentLogger, {
    resume: false,
    signal: new AbortController().signal,
  });
  assert.equal(result.status, 'paused');
  assert.deepEqual(interrupted, ['turn-hidden-after-pause']);
  assert.equal(result.activeTurnId, null);
});

test('failed verification is injected and reactivates without replacing objective or accounting', async (t) => {
  const temp = await withStateHome(t);
  const marker = path.join(temp, 'verification-marker');
  const script = `const fs=require('fs');const p=${JSON.stringify(marker)};if(fs.existsSync(p)){process.exit(0)}fs.writeFileSync(p,'1');process.exit(1)`;
  const client = new FakeClient(['complete', 'complete']);
  const state = createState(process.cwd(), { verifyCommands: [`node -e ${JSON.stringify(script)}`] });

  const result = await supervise(client, state, silentLogger, {
    resume: false,
    signal: new AbortController().signal,
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.verificationAttempts, 2);
  assert.equal(client.injected.length, 1);
  assert.match(client.injected[0], /Host-side verification failed/);
  assert.equal(client.runGoalCalls[0].objective, state.objective);
  assert.equal(client.runGoalCalls[1].objective, undefined);
});

test('resume of a completed Goal runs verification without reactivation', async (t) => {
  await withStateHome(t);
  const client = new FakeClient([], goal('complete', 42));
  const state = createState(process.cwd());
  state.threadId = 'thread-test';

  const result = await supervise(client, state, silentLogger, {
    resume: true,
    signal: new AbortController().signal,
  });

  assert.equal(result.status, 'completed');
  assert.equal(client.runGoalCalls.length, 0);
  assert.equal(client.resumeCalls, 1);
});

test('resume verifies a completed Goal that used exactly the final allowed turn', async (t) => {
  await withStateHome(t);
  const client = new FakeClient([], goal('complete', 10));
  const state = createState(process.cwd(), { maxTurns: 1 });
  state.threadId = 'thread-test';
  state.observedTurnIds = ['turn-persisted'];
  state.turnCount = 1;

  const result = await supervise(client, state, silentLogger, {
    resume: true,
    signal: new AbortController().signal,
  });

  assert.equal(result.status, 'completed');
  assert.equal(client.runGoalCalls.length, 0);
});

test('resume never recreates a missing Goal after prior durable work', async (t) => {
  await withStateHome(t);
  const client = new FakeClient([], null);
  client.persistedTurns = [{ turnId: 'turn-old', status: 'completed', finalText: 'old', error: null }];
  const state = createState(process.cwd());
  state.threadId = 'thread-test';
  state.observedTurnIds = ['turn-old'];
  state.turnCount = 1;
  state.nativeGoalStatus = 'paused';

  const result = await supervise(client, state, silentLogger, {
    resume: true,
    signal: new AbortController().signal,
  });

  assert.equal(result.status, 'blocked');
  assert.equal(client.resumeCalls, 0);
  assert.equal(client.runGoalCalls.length, 0);
  assert.match(result.lastError, /Goal durable desaparecio/);
});

test('resume safely retries a pre-activation intent with no Goal or durable turns', async (t) => {
  await withStateHome(t);
  const client = new FakeClient(['complete'], null);
  const state = createState(process.cwd());
  state.threadId = 'thread-test';
  state.goalActivationPending = true;

  const result = await supervise(client, state, silentLogger, {
    resume: true,
    signal: new AbortController().signal,
  });

  assert.equal(result.status, 'completed');
  assert.equal(client.resumeCalls, 1);
  assert.equal(client.runGoalCalls.length, 1);
  assert.equal(client.runGoalCalls[0].objective, state.objective);
});

test('resume never creates a Goal when a pending intent has unowned durable turns', async (t) => {
  await withStateHome(t);
  const client = new FakeClient([], null);
  client.persistedTurns = [{ turnId: 'turn-unowned', status: 'completed', finalText: 'old', error: null }];
  const state = createState(process.cwd());
  state.threadId = 'thread-test';
  state.goalActivationPending = true;

  const result = await supervise(client, state, silentLogger, {
    resume: true,
    signal: new AbortController().signal,
  });

  assert.equal(result.status, 'blocked');
  assert.equal(client.runGoalCalls.length, 0);
  assert.match(result.lastError, /thread conserva turnos/);
});

test('resume refuses to mutate a thread active in another Desktop instance', async (t) => {
  await withStateHome(t);
  const client = new FakeClient([]);
  client.threadStatus = { type: 'active', activeFlags: [] };
  const state = createState(process.cwd());
  state.threadId = 'thread-test';

  const result = await supervise(client, state, silentLogger, {
    resume: true,
    signal: new AbortController().signal,
  });

  assert.equal(result.status, 'blocked');
  assert.equal(client.resumeCalls, 0);
  assert.equal(client.goalUpdates.length, 0);
});

test('resume completes an owned paused stop whose durable turn is still inProgress', async (t) => {
  await withStateHome(t);
  const client = new FakeClient([], goal('paused'));
  client.threadStatus = { type: 'active', activeFlags: [] };
  client.persistedTurns = [{
    turnId: 'turn-stop-pending',
    status: 'inProgress',
    finalText: null,
    error: null,
    blockedReason: null,
  }];
  const interrupted = [];
  client.interrupt = async (_threadId, turnId) => {
    interrupted.push(turnId);
    client.persistedTurns[0].status = 'interrupted';
    client.threadStatus = { type: 'idle' };
  };
  const state = createState(process.cwd());
  state.threadId = 'thread-test';
  state.nativeGoalStatus = 'paused';
  state.nativeGoalCreatedAt = 1;

  const result = await supervise(client, state, silentLogger, {
    resume: true,
    signal: new AbortController().signal,
  });

  assert.equal(result.status, 'paused');
  assert.deepEqual(interrupted, ['turn-stop-pending']);
  assert.equal(result.activeTurnId, null);
  assert.equal(client.runGoalCalls.length, 0);
});

test('resume reconciles an unobserved durable turn before reactivating Goal', async (t) => {
  await withStateHome(t);
  const client = new FakeClient(['complete'], goal('active', 10));
  client.persistedTurns = [{ turnId: 'turn-before-crash', status: 'completed', finalText: 'partial', error: null }];
  const state = createState(process.cwd());
  state.threadId = 'thread-test';
  state.goalActivationPending = true;

  const result = await supervise(client, state, silentLogger, {
    resume: true,
    signal: new AbortController().signal,
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(result.observedTurnIds, ['turn-before-crash', 'turn-1']);
  assert.equal(client.runGoalCalls[0].objective, undefined);
});

test('resume blocks when the persisted active turn is missing', async (t) => {
  await withStateHome(t);
  const client = new FakeClient([], goal('active', 10));
  const state = createState(process.cwd());
  state.threadId = 'thread-test';
  state.activeTurnId = 'turn-lost';
  state.goalActivationPending = true;

  const result = await supervise(client, state, silentLogger, {
    resume: true,
    signal: new AbortController().signal,
  });

  assert.equal(result.status, 'blocked');
  assert.equal(client.runGoalCalls.length, 0);
  assert.match(result.lastError, /no existe en el historial durable/);
});

test('resume rejects stale local completion evidence missing from durable history', async (t) => {
  await withStateHome(t);
  const client = new FakeClient([], goal('complete', 10));
  client.persistedTurns = [];
  const state = createState(process.cwd());
  state.threadId = 'thread-test';
  state.nativeGoalStatus = 'complete';
  state.nativeGoalCreatedAt = 1;
  state.observedTurnIds = ['turn-lost'];
  state.turnCount = 1;
  state.lastTurn = {
    turnId: 'turn-lost',
    status: 'completed',
    error: null,
    failedItems: [],
    blockedReason: null,
  };

  const result = await supervise(client, state, silentLogger, {
    resume: true,
    signal: new AbortController().signal,
  });

  assert.equal(result.status, 'blocked');
  assert.equal(result.lastVerification, null);
  assert.equal(client.runGoalCalls.length, 0);
  assert.match(result.lastError, /evidencia local obsoleta/);
});

test('resume blocks a complete Goal whose durable turn contains a declined approval', async (t) => {
  await withStateHome(t);
  const client = new FakeClient([], goal('complete', 10));
  client.persistedTurns = [{
    turnId: 'turn-declined',
    status: 'completed',
    finalText: 'done',
    error: null,
    blockedReason: 'approval_declined:commandExecution',
  }];
  const state = createState(process.cwd());
  state.threadId = 'thread-test';

  const result = await supervise(client, state, silentLogger, {
    resume: true,
    signal: new AbortController().signal,
  });

  assert.equal(result.status, 'blocked');
  assert.equal(result.lastVerification, null);
  assert.match(result.lastError, /interaccion no disponible/);
});

test('resume preserves a local interaction reason when the same durable turn omits it', async (t) => {
  await withStateHome(t);
  const client = new FakeClient([], goal('complete', 10));
  client.persistedTurns = [{
    turnId: 'turn-local-interaction',
    status: 'completed',
    finalText: 'done',
    error: null,
    blockedReason: null,
  }];
  const state = createState(process.cwd());
  state.threadId = 'thread-test';
  state.observedTurnIds = ['turn-local-interaction'];
  state.turnCount = 1;
  state.lastTurn = {
    turnId: 'turn-local-interaction',
    status: 'completed',
    error: null,
    failedItems: [],
    blockedReason: 'unsupported_server_request:item/newAuthority/request',
  };

  const result = await supervise(client, state, silentLogger, {
    resume: true,
    signal: new AbortController().signal,
  });

  assert.equal(result.status, 'blocked');
  assert.equal(result.lastTurn.blockedReason, 'unsupported_server_request:item/newAuthority/request');
  assert.equal(result.lastVerification, null);
});

test('Goal complete with a failed final turn never reaches host verification', async (t) => {
  await withStateHome(t);
  const client = new FakeClient(['complete']);
  client.turnStatuses.push('failed');
  const state = createState(process.cwd());

  const result = await supervise(client, state, silentLogger, {
    resume: false,
    signal: new AbortController().signal,
  });

  assert.equal(result.status, 'blocked');
  assert.equal(result.lastVerification, null);
  assert.match(result.lastError, /ultimo turno termino failed/);
});

test('Goal complete after an interaction request remains blocked', async (t) => {
  await withStateHome(t);
  const client = new FakeClient(['complete']);
  client.turnBlockedReason = 'approval_denied:item/fileChange/requestApproval';
  const state = createState(process.cwd());

  const result = await supervise(client, state, silentLogger, {
    resume: false,
    signal: new AbortController().signal,
  });

  assert.equal(result.status, 'blocked');
  assert.equal(result.lastVerification, null);
  assert.match(result.lastError, /interaccion no disponible/);
});

test('Goal complete at the token budget does not bypass the budget terminal state', async (t) => {
  await withStateHome(t);
  const client = new FakeClient(['complete']);
  const state = createState(process.cwd(), { tokenBudget: 10 });

  const result = await supervise(client, state, silentLogger, {
    resume: false,
    signal: new AbortController().signal,
  });

  assert.equal(result.status, 'budgetLimited');
  assert.equal(result.lastVerification, null);
  assert.match(result.lastError, /presupuesto de 10 tokens/);
});

test('a Desktop-configured default Goal budget is captured as effective state', async (t) => {
  await withStateHome(t);
  const client = new FakeClient([]);
  client.runNativeGoal = async (options) => {
    const active = { ...goal('active', 1), tokenBudget: 50 };
    client.currentGoal = active;
    await options.onActivated?.(active);
    await options.onGoalUpdated?.(active);
    await options.onTurnStarted?.('turn-default-budget');
    const complete = { ...goal('complete', 1), tokenBudget: 50 };
    client.currentGoal = complete;
    await options.onGoalUpdated?.(complete);
    const turn = {
      threadId: 'thread-test',
      turnId: 'turn-default-budget',
      status: 'completed',
      finalText: 'done',
      totalTokens: 1,
      error: null,
      failedItems: [],
      blockedReason: null,
    };
    await options.onTurnCompleted?.(turn);
    return { goal: complete, lastTurn: turn, turnsStarted: 1, activeTurnId: null, stopReason: null };
  };
  const state = createState(process.cwd(), { tokenBudget: null });

  const result = await supervise(client, state, silentLogger, {
    resume: false,
    signal: new AbortController().signal,
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.tokenBudget, null);
  assert.equal(result.goalTokenBudget, 50);
});

test('budget stop changes the Goal state before interrupting its active turn', async (t) => {
  await withStateHome(t);
  const client = new FakeClient([]);
  const operations = [];
  client.runNativeGoal = async (options) => {
    const active = goal('active');
    client.currentGoal = active;
    await options.onActivated?.(active);
    await options.onTurnStarted?.('turn-budget');
    const complete = goal('complete');
    client.currentGoal = complete;
    await options.onGoalUpdated?.(complete);
    return { goal: complete, lastTurn: null, turnsStarted: 1, activeTurnId: 'turn-budget', stopReason: 'wall_timeout' };
  };
  client.setGoal = async (_threadId, objective, status) => {
    operations.push(`goal:${status}`);
    client.currentGoal = { ...(client.currentGoal ?? goal(status)), status };
    return client.currentGoal;
  };
  client.interrupt = async () => {
    operations.push('interrupt');
    client.persistedTurns = [{ turnId: 'turn-budget', status: 'interrupted', finalText: null, error: null, blockedReason: null }];
  };
  const state = createState(process.cwd());

  const result = await supervise(client, state, silentLogger, {
    resume: false,
    signal: new AbortController().signal,
  });

  assert.equal(result.status, 'budgetLimited');
  assert.deepEqual(operations, ['goal:budgetLimited', 'interrupt']);
});

test('resume refuses a Goal whose objective changed in Desktop', async (t) => {
  await withStateHome(t);
  const changedGoal = { ...goal('paused'), objective: 'A different Desktop objective' };
  const client = new FakeClient([], changedGoal);
  const state = createState(process.cwd());
  state.threadId = 'thread-test';

  const result = await supervise(client, state, silentLogger, {
    resume: true,
    signal: new AbortController().signal,
  });

  assert.equal(result.status, 'blocked');
  assert.equal(client.resumeCalls, 0);
  assert.equal(client.goalUpdates.length, 0);
  assert.match(result.lastError, /cambio de objetivo o presupuesto/);
});

test('resume blocks after a durable failed turn instead of repeating effects', async (t) => {
  await withStateHome(t);
  const client = new FakeClient([], goal('paused'));
  client.persistedTurns = [{ turnId: 'turn-failed', status: 'failed', finalText: null, error: 'failed' }];
  const state = createState(process.cwd());
  state.threadId = 'thread-test';

  const result = await supervise(client, state, silentLogger, {
    resume: true,
    signal: new AbortController().signal,
  });

  assert.equal(result.status, 'blocked');
  assert.equal(client.runGoalCalls.length, 0);
  assert.match(result.lastError, /requiere revision/);

  client.terminals.push('complete');
  const resumed = await supervise(client, result, silentLogger, {
    resume: true,
    signal: new AbortController().signal,
  });
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.acknowledgedBlockingTurnIds.includes('turn-failed'), true);
});

test('supervisor never completes while Desktop reports systemError', async (t) => {
  await withStateHome(t);
  const client = new FakeClient(['complete']);
  client.threadStatus = { type: 'systemError' };
  const state = createState(process.cwd());

  await assert.rejects(
    () => supervise(client, state, silentLogger, { resume: false, signal: new AbortController().signal }),
    /estado idle|estado remoto es incierto|no quedaron estables/,
  );
  assert.notEqual(state.status, 'completed');
});

test('terminal cleanup runs before the full verification suite', async (t) => {
  const temp = await withStateHome(t);
  const marker = path.join(temp, 'cleanup-complete');
  const client = new FakeClient(['complete']);
  client.prepareThreadForTerminal = async () => { await writeFile(marker, 'ready'); };
  const script = `if(!require('node:fs').existsSync(${JSON.stringify(marker)}))process.exit(1)`;
  const state = createState(process.cwd(), { verifyCommands: [`node -e ${JSON.stringify(script)}`] });

  const result = await supervise(client, state, silentLogger, {
    resume: false,
    signal: new AbortController().signal,
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.verificationAttempts, 1);
});

test('resume blocks when any newly discovered turn failed before a later completion', async (t) => {
  await withStateHome(t);
  const client = new FakeClient([], goal('paused'));
  client.persistedTurns = [
    { turnId: 'turn-partial', status: 'interrupted', finalText: null, error: 'interrupted' },
    { turnId: 'turn-later', status: 'completed', finalText: 'later', error: null },
  ];
  const state = createState(process.cwd());
  state.threadId = 'thread-test';

  const result = await supervise(client, state, silentLogger, {
    resume: true,
    signal: new AbortController().signal,
  });

  assert.equal(result.status, 'blocked');
  assert.equal(client.runGoalCalls.length, 0);
  assert.match(result.lastError, /turn-partial termino interrupted/);
});

test('abort fails closed when the active remote turn cannot be stopped', async (t) => {
  await withStateHome(t);
  const controller = new AbortController();
  const client = new FakeClient([]);
  client.runNativeGoal = async (options) => {
    const active = goal('active');
    client.currentGoal = active;
    await options.onActivated?.(active);
    await options.onTurnStarted?.('turn-uncertain');
    controller.abort();
    throw new Error('aborted in fake runtime');
  };
  client.interrupt = async () => { throw new Error('interrupt failed'); };
  client.readTurn = async () => { throw new Error('turn read failed'); };
  const state = createState(process.cwd());

  await assert.rejects(
    () => supervise(client, state, silentLogger, { resume: false, signal: controller.signal }),
    /estado remoto es incierto/,
  );
  assert.equal(state.status, 'failed');
});

test('abort after Goal complete preserves the terminal remote Goal', async (t) => {
  await withStateHome(t);
  const client = new FakeClient([]);
  client.runNativeGoal = async (options) => {
    const active = goal('active');
    client.currentGoal = active;
    await options.onActivated?.(active);
    await options.onTurnStarted?.('turn-aborted-after-complete');
    const complete = goal('complete');
    client.currentGoal = complete;
    await options.onGoalUpdated?.(complete);
    const interrupted = {
      threadId: 'thread-test',
      turnId: 'turn-aborted-after-complete',
      status: 'interrupted',
      finalText: null,
      totalTokens: 10,
      error: null,
      failedItems: [],
      blockedReason: null,
    };
    await options.onTurnCompleted?.(interrupted);
    return { goal: complete, lastTurn: interrupted, turnsStarted: 1, activeTurnId: null, stopReason: 'signal' };
  };
  const state = createState(process.cwd());

  const result = await supervise(client, state, silentLogger, {
    resume: false,
    signal: new AbortController().signal,
  });

  assert.equal(result.status, 'paused');
  assert.equal(result.nativeGoalStatus, 'complete');
  assert.equal(client.currentGoal.status, 'complete');
  assert.equal(client.goalUpdates.some(({ status }) => status === 'paused'), false);
  assert.equal(result.lastTurn.status, 'interrupted');
});

test('abort during verification preserves a complete remote Goal', async (t) => {
  const temp = await withStateHome(t);
  const marker = path.join(temp, 'verification-started');
  const controller = new AbortController();
  const client = new FakeClient(['complete']);
  const script = `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started');setInterval(()=>{},1000)`;
  const state = createState(process.cwd(), {
    verifyCommands: [`node -e ${JSON.stringify(script)}`],
  });

  const pending = supervise(client, state, silentLogger, {
    resume: false,
    signal: controller.signal,
  });
  const deadline = Date.now() + 5000;
  let verificationStarted = false;
  while (!verificationStarted && Date.now() < deadline) {
    verificationStarted = await access(marker).then(() => true).catch(() => false);
    if (!verificationStarted) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  controller.abort();
  const result = await pending;

  assert.equal(verificationStarted, true);
  assert.equal(result.status, 'paused');
  assert.equal(result.nativeGoalStatus, 'complete');
  assert.equal(client.currentGoal.status, 'complete');
  assert.equal(client.goalUpdates.some(({ status }) => status === 'paused'), false);
  assert.equal(result.verificationAttempts, 1);
  assert.notEqual(result.lastVerification, null);
  assert.equal(result.lastVerification.ok, false);
});

test('a pre-aborted resume pauses an existing remote Goal before returning', async (t) => {
  await withStateHome(t);
  const controller = new AbortController();
  controller.abort();
  const client = new FakeClient([], goal('active'));
  const state = createState(process.cwd());
  state.threadId = 'thread-test';

  const result = await supervise(client, state, silentLogger, {
    resume: true,
    signal: controller.signal,
  });

  assert.equal(result.status, 'paused');
  assert.equal(client.goalUpdates.at(-1).status, 'paused');
});

test('a pre-aborted resume interrupts an inProgress turn missing from local state', async (t) => {
  await withStateHome(t);
  const controller = new AbortController();
  controller.abort();
  const client = new FakeClient([], goal('active'));
  client.persistedTurns = [{
    turnId: 'turn-orphaned',
    status: 'inProgress',
    finalText: null,
    error: null,
    blockedReason: null,
  }];
  const interrupted = [];
  client.interrupt = async (_threadId, turnId) => {
    interrupted.push(turnId);
    client.persistedTurns = [{
      turnId,
      status: 'interrupted',
      finalText: null,
      error: null,
      blockedReason: null,
    }];
  };
  const state = createState(process.cwd());
  state.threadId = 'thread-test';

  const result = await supervise(client, state, silentLogger, {
    resume: true,
    signal: controller.signal,
  });

  assert.equal(result.status, 'paused');
  assert.deepEqual(interrupted, ['turn-orphaned']);
  assert.equal(result.activeTurnId, null);
});

test('a pre-aborted resume preserves a complete remote Goal', async (t) => {
  await withStateHome(t);
  const controller = new AbortController();
  controller.abort();
  const client = new FakeClient([], goal('complete'));
  const state = createState(process.cwd());
  state.threadId = 'thread-test';

  const result = await supervise(client, state, silentLogger, {
    resume: true,
    signal: controller.signal,
  });

  assert.equal(result.status, 'paused');
  assert.equal(result.nativeGoalStatus, 'complete');
  assert.equal(client.goalUpdates.length, 0);
});

test('a pre-aborted resume never interrupts a turn after Goal ownership drift', async (t) => {
  await withStateHome(t);
  const controller = new AbortController();
  controller.abort();
  const changedGoal = { ...goal('active'), objective: 'Changed in Desktop' };
  const client = new FakeClient([], changedGoal);
  client.persistedTurns = [{
    turnId: 'turn-foreign',
    status: 'inProgress',
    finalText: null,
    error: null,
    blockedReason: null,
  }];
  const interrupted = [];
  client.interrupt = async (_threadId, turnId) => { interrupted.push(turnId); };
  const state = createState(process.cwd());
  state.threadId = 'thread-test';

  const result = await supervise(client, state, silentLogger, {
    resume: true,
    signal: controller.signal,
  });

  assert.equal(result.status, 'blocked');
  assert.deepEqual(interrupted, []);
  assert.equal(client.currentGoal.status, 'active');
});

test('failure stopping still interrupts a known turn when Goal lookup fails', async (t) => {
  await withStateHome(t);
  const client = new FakeClient([]);
  const originalGetGoal = client.getGoal.bind(client);
  let goalReads = 0;
  client.getGoal = async () => {
    goalReads += 1;
    if (goalReads > 1) throw new Error('Goal lookup failed');
    return originalGetGoal();
  };
  client.runNativeGoal = async (options) => {
    const active = goal('active');
    client.currentGoal = active;
    await options.onActivated?.(active);
    await options.onTurnStarted?.('turn-known');
    throw new Error('runtime failure');
  };
  const interrupted = [];
  client.interrupt = async (_threadId, turnId) => {
    interrupted.push(turnId);
    client.persistedTurns = [{ turnId, status: 'interrupted', finalText: null, error: null, blockedReason: null }];
  };
  const state = createState(process.cwd());

  await assert.rejects(
    () => supervise(client, state, silentLogger, { resume: false, signal: new AbortController().signal }),
    /runtime failure/,
  );
  assert.deepEqual(interrupted, ['turn-known']);
  assert.equal(state.activeTurnId, null);
  assert.equal(state.status, 'failed');
});

test('supervisor never reports completed when final Goal confirmation fails', async (t) => {
  await withStateHome(t);
  const client = new FakeClient(['complete']);
  client.failFinalGoalConfirmation = true;
  const state = createState(process.cwd());

  await assert.rejects(
    () => supervise(client, state, silentLogger, { resume: false, signal: new AbortController().signal }),
    /goal confirmation failed/,
  );
  assert.equal(state.status, 'failed');
  assert.equal(state.nativeGoalStatus, 'complete');
  assert.equal(client.currentGoal.status, 'complete');
  assert.equal(client.goalUpdates.some(({ status }) => status === 'blocked'), false);
});
