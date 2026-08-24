import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { CodexDesktopClient } from '../dist/app-server/client.js';

const ALL_SOURCE_KINDS = [
  'cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview',
  'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown',
];

const logger = { info() {}, warn() {}, error() {}, debug() {} };

function goal(status, tokensUsed = 0) {
  return {
    threadId: 'thread-owned',
    objective: 'Finish safely',
    status,
    tokenBudget: 1000,
    tokensUsed,
    timeUsedSeconds: 1,
    createdAt: 1,
    updatedAt: 2,
  };
}

function thread(id, cwd = 'D:\\workspace') {
  return {
    id,
    preview: '',
    name: null,
    cwd,
    createdAt: 1,
    updatedAt: 2,
    status: { type: 'idle' },
    source: 'appServer',
    ephemeral: false,
  };
}

class FakeTransport extends EventEmitter {
  calls = [];
  responses = [];
  errors = [];
  handlers = new Map();
  closed = false;

  when(method, handler) {
    this.handlers.set(method, handler);
  }

  async request(method, params = {}, timeoutMs = 30_000) {
    const call = { method, params, timeoutMs };
    this.calls.push(call);
    const handler = this.handlers.get(method);
    if (!handler && (method === 'thread/settings/update' || method === 'thread/backgroundTerminals/clean')) return {};
    if (!handler && method === 'thread/turns/list') return { data: [], nextCursor: null };
    if (!handler && method === 'thread/read') return { thread: thread('thread-owned') };
    if (!handler) throw new Error(`Unexpected request: ${method}`);
    return handler(call);
  }

  respond(id, result) {
    this.responses.push({ id, result });
  }

  respondError(id, code, message) {
    this.errors.push({ id, code, message });
  }

  async close() {
    this.closed = true;
  }
}

async function openOwnedClient(t) {
  const rpc = new FakeTransport();
  const client = new CodexDesktopClient(rpc, logger);
  t.after(() => client.close());
  rpc.when('thread/start', () => ({ thread: thread('thread-owned') }));
  await client.startThread('D:\\workspace');
  return { rpc, client };
}

test('startThread relies on native Goal tools and applies the safe policy', async (t) => {
  const rpc = new FakeTransport();
  const client = new CodexDesktopClient(rpc, logger);
  t.after(() => client.close());
  rpc.when('thread/start', () => ({ thread: thread('thread-safe') }));

  await client.startThread('D:\\workspace', 'gpt-test');
  const call = rpc.calls[0];

  assert.equal(call.method, 'thread/start');
  assert.equal(call.params.approvalPolicy, 'never');
  assert.equal(call.params.sandbox, 'workspace-write');
  assert.equal(call.params.ephemeral, false);
  assert.equal(Object.hasOwn(call.params, 'dynamicTools'), false);
});

test('configureThread applies network, sandbox, model, and effort to native Goal turns', async (t) => {
  const { rpc, client } = await openOwnedClient(t);
  rpc.when('thread/settings/update', () => ({}));

  await client.configureThread({
    threadId: 'thread-owned',
    workspace: 'D:\\workspace',
    network: true,
    dangerFullAccess: false,
    model: 'gpt-test',
    effort: 'high',
  });

  const call = rpc.calls.find(({ method }) => method === 'thread/settings/update');
  assert.deepEqual(call.params.sandboxPolicy, {
    type: 'workspaceWrite',
    writableRoots: ['D:\\workspace'],
    networkAccess: true,
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true,
  });
  assert.equal(call.params.model, 'gpt-test');
  assert.equal(call.params.effort, 'high');
});

test('native Goal observes synchronous activation events and waits for terminal turn persistence', async (t) => {
  const { rpc, client } = await openOwnedClient(t);
  let listenersAtActivation = 0;
  rpc.when('thread/goal/set', ({ params }) => {
    if (params.status === 'active') {
      listenersAtActivation = rpc.listenerCount('notification');
      rpc.emit('notification', {
        method: 'thread/goal/updated',
        params: { threadId: 'thread-owned', turnId: null, goal: goal('active') },
      });
      rpc.emit('notification', {
        method: 'turn/started',
        params: { threadId: 'thread-owned', turn: { id: 'turn-owned', status: 'inProgress' } },
      });
      return { goal: goal('active') };
    }
    throw new Error(`unexpected Goal transition: ${params.status}`);
  });

  const started = [];
  const promise = client.runNativeGoal({
    threadId: 'thread-owned',
    objective: 'Finish safely',
    tokenBudget: 1000,
    timeoutMs: 5000,
    turnTimeoutMs: 5000,
    maxTurns: 2,
    signal: new AbortController().signal,
    onTurnStarted: (turnId) => { started.push(turnId); },
  });
  await new Promise(setImmediate);

  rpc.emit('notification', {
    method: 'turn/started',
    params: { threadId: 'thread-owned', turn: { id: 'turn-owned', status: 'inProgress' } },
  });

  rpc.emit('notification', {
    method: 'item/completed',
    params: {
      threadId: 'thread-foreign',
      turnId: 'turn-owned',
      item: { type: 'agentMessage', text: 'foreign', phase: 'final_answer' },
    },
  });
  rpc.emit('notification', {
    method: 'thread/goal/updated',
    params: {
      threadId: 'thread-owned',
      turnId: 'turn-owned',
      goal: goal('complete', 321),
    },
  });
  await new Promise(setImmediate);

  let resolved = false;
  void promise.then(() => { resolved = true; });
  await new Promise(setImmediate);
  assert.equal(resolved, false, 'Goal complete must wait for turn/completed');

  rpc.emit('notification', {
    method: 'turn/completed',
    params: {
      threadId: 'thread-owned',
      turn: {
        id: 'turn-owned',
        status: 'completed',
        error: null,
        items: [{ type: 'agentMessage', text: 'final answer', phase: 'final_answer' }],
      },
    },
  });

  const result = await promise;
  assert.ok(listenersAtActivation > 0);
  assert.deepEqual(started, ['turn-owned']);
  assert.equal(result.goal.status, 'complete');
  assert.equal(result.lastTurn.finalText, 'final answer');
  assert.equal(result.lastTurn.totalTokens, 321);
  assert.equal(result.activeTurnId, null);
  assert.equal(rpc.calls.some(({ method }) => method === 'turn/start'), false);
});

test('native Goal waits for the next native turn without injecting continuation messages', async (t) => {
  const { rpc, client } = await openOwnedClient(t);
  rpc.when('thread/goal/set', ({ params }) => {
    assert.equal(params.status, 'active');
    rpc.emit('notification', {
      method: 'turn/started',
      params: { threadId: 'thread-owned', turn: { id: 'turn-first', status: 'inProgress' } },
    });
    return { goal: goal('active') };
  });

  const started = [];
  const completed = [];
  const promise = client.runNativeGoal({
    threadId: 'thread-owned',
    objective: 'Finish safely',
    tokenBudget: 1000,
    timeoutMs: 5000,
    turnTimeoutMs: 5000,
    maxTurns: 2,
    signal: new AbortController().signal,
    onTurnStarted: (turnId) => { started.push(turnId); },
    onTurnCompleted: (turn) => { completed.push(turn.turnId); },
  });
  await new Promise(setImmediate);

  rpc.emit('notification', {
    method: 'turn/completed',
    params: {
      threadId: 'thread-owned',
      turn: { id: 'turn-first', status: 'completed', error: null, items: [] },
    },
  });
  await new Promise(setImmediate);

  let resolved = false;
  void promise.then(() => { resolved = true; });
  await new Promise(setImmediate);
  assert.equal(resolved, false);
  assert.deepEqual(started, ['turn-first']);
  assert.deepEqual(completed, ['turn-first']);
  assert.equal(rpc.calls.filter(({ method }) => method === 'thread/goal/set').length, 1);
  assert.equal(rpc.calls.some(({ method }) => method === 'turn/start'), false);
  assert.equal(rpc.calls.some(({ method }) => method === 'thread/inject_items'), false);

  rpc.emit('notification', {
    method: 'turn/started',
    params: { threadId: 'thread-owned', turn: { id: 'turn-second', status: 'inProgress' } },
  });
  rpc.emit('notification', {
    method: 'thread/goal/updated',
    params: { threadId: 'thread-owned', turnId: 'turn-second', goal: goal('complete', 200) },
  });
  rpc.emit('notification', {
    method: 'turn/completed',
    params: {
      threadId: 'thread-owned',
      turn: {
        id: 'turn-second',
        status: 'completed',
        error: null,
        items: [{ type: 'agentMessage', text: 'finished', phase: 'final_answer' }],
      },
    },
  });

  const result = await promise;
  assert.deepEqual(started, ['turn-first', 'turn-second']);
  assert.deepEqual(completed, ['turn-first', 'turn-second']);
  assert.equal(result.goal.status, 'complete');
  assert.equal(result.lastTurn.turnId, 'turn-second');
  assert.equal(result.lastTurn.finalText, 'finished');
  assert.equal(result.turnsStarted, 2);
  assert.equal(rpc.calls.some(({ method }) => method === 'turn/start'), false);
  assert.equal(rpc.calls.some(({ method }) => method === 'thread/inject_items'), false);
});

test('native Goal recovers the durable final turn when its completion notification is missed', async (t) => {
  const { rpc, client } = await openOwnedClient(t);
  rpc.when('thread/goal/set', () => {
    rpc.emit('notification', {
      method: 'turn/started',
      params: { threadId: 'thread-owned', turn: { id: 'turn-recovered', status: 'inProgress' } },
    });
    return { goal: goal('active') };
  });
  rpc.when('thread/turns/list', () => ({
    data: [{
      id: 'turn-recovered',
      status: 'completed',
      error: null,
      items: [{ type: 'agentMessage', text: 'recovered final', phase: 'final_answer' }],
    }],
    nextCursor: null,
  }));

  const completed = [];
  const promise = client.runNativeGoal({
    threadId: 'thread-owned',
    objective: 'Finish safely',
    tokenBudget: 1000,
    timeoutMs: 5000,
    turnTimeoutMs: 1000,
    maxTurns: 2,
    signal: new AbortController().signal,
    onTurnCompleted: (turnResult) => { completed.push(turnResult.turnId); },
  });
  await new Promise(setImmediate);
  rpc.emit('notification', {
    method: 'thread/goal/updated',
    params: { threadId: 'thread-owned', turnId: 'turn-recovered', goal: goal('complete', 456) },
  });

  const result = await promise;
  assert.deepEqual(completed, ['turn-recovered']);
  assert.equal(result.lastTurn.turnId, 'turn-recovered');
  assert.equal(result.lastTurn.finalText, 'recovered final');
  assert.equal(result.lastTurn.totalTokens, 456);
});

test('native Goal rejects a final turn that becomes readable after its deadline', async (t) => {
  const { rpc, client } = await openOwnedClient(t);
  rpc.when('thread/goal/set', () => {
    rpc.emit('notification', {
      method: 'turn/started',
      params: { threadId: 'thread-owned', turn: { id: 'turn-late', status: 'inProgress' } },
    });
    return { goal: goal('active') };
  });
  rpc.when('thread/turns/list', async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return {
      data: [{ id: 'turn-late', status: 'completed', error: null, items: [] }],
      nextCursor: null,
    };
  });
  rpc.when('turn/interrupt', () => ({}));

  const promise = client.runNativeGoal({
    threadId: 'thread-owned',
    objective: 'Finish safely',
    timeoutMs: 5000,
    turnTimeoutMs: 20,
    maxTurns: 2,
    signal: new AbortController().signal,
  });
  await new Promise(setImmediate);
  rpc.emit('notification', {
    method: 'thread/goal/updated',
    params: { threadId: 'thread-owned', turnId: 'turn-late', goal: goal('complete', 456) },
  });

  await Promise.all([
    assert.rejects(promise, /Tiempo agotado|limite de tiempo/),
    new Promise((resolve) => setTimeout(resolve, 60)),
  ]);
});

test('abort during a hung Goal activation closes App Server and fails bounded', async (t) => {
  const { rpc, client } = await openOwnedClient(t);
  const controller = new AbortController();
  const unhandled = [];
  const onUnhandled = (error) => { unhandled.push(error); };
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  rpc.when('thread/goal/set', () => new Promise(() => {}));
  rpc.close = async () => {
    rpc.closed = true;
    rpc.emit('closed', new Error('closed by abort'));
  };

  const promise = client.runNativeGoal({
    threadId: 'thread-owned',
    objective: 'Finish safely',
    timeoutMs: 60_000,
    turnTimeoutMs: 5000,
    maxTurns: 2,
    signal: controller.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  controller.abort();

  await assert.rejects(promise, /activacion Goal|trabajo tardio/);
  await new Promise(setImmediate);
  assert.equal(rpc.closed, true);
  assert.deepEqual(unhandled, []);
});

test('abort interrupts a still-active turn after the Goal already became complete', async (t) => {
  const { rpc, client } = await openOwnedClient(t);
  const controller = new AbortController();
  rpc.when('thread/goal/set', () => {
    rpc.emit('notification', {
      method: 'turn/started',
      params: { threadId: 'thread-owned', turn: { id: 'turn-abort', status: 'inProgress' } },
    });
    return { goal: goal('active') };
  });
  rpc.when('turn/interrupt', () => {
    rpc.emit('notification', {
      method: 'turn/completed',
      params: {
        threadId: 'thread-owned',
        turn: { id: 'turn-abort', status: 'interrupted', error: null, items: [] },
      },
    });
    return {};
  });

  const promise = client.runNativeGoal({
    threadId: 'thread-owned',
    objective: 'Finish safely',
    timeoutMs: 5000,
    turnTimeoutMs: 5000,
    maxTurns: 2,
    signal: controller.signal,
  });
  await new Promise(setImmediate);
  rpc.emit('notification', {
    method: 'thread/goal/updated',
    params: { threadId: 'thread-owned', turnId: 'turn-abort', goal: goal('complete', 50) },
  });
  controller.abort();

  const result = await promise;
  assert.equal(result.stopReason, 'signal');
  assert.equal(result.lastTurn.status, 'interrupted');
  assert.equal(rpc.calls.some(({ method }) => method === 'turn/interrupt'), true);
});

test('unknown server requests fail closed for the active owned turn', async (t) => {
  const { rpc, client } = await openOwnedClient(t);
  rpc.when('thread/goal/set', ({ params }) => {
    if (params.status === 'active') {
      rpc.emit('notification', {
        method: 'turn/started',
        params: { threadId: 'thread-owned', turn: { id: 'turn-unknown-request', status: 'inProgress' } },
      });
    }
    return { goal: goal(params.status) };
  });
  rpc.when('turn/interrupt', () => ({}));

  const promise = client.runNativeGoal({
    threadId: 'thread-owned',
    objective: 'Finish safely',
    timeoutMs: 5000,
    turnTimeoutMs: 5000,
    maxTurns: 2,
    signal: new AbortController().signal,
  });
  await new Promise(setImmediate);
  rpc.emit('request', {
    id: 99,
    method: 'item/newAuthority/request',
    params: { newProtocolShape: true },
  });
  rpc.emit('notification', {
    method: 'turn/completed',
    params: {
      threadId: 'thread-owned',
      turn: { id: 'turn-unknown-request', status: 'completed', error: null, items: [] },
    },
  });

  const result = await promise;
  assert.equal(result.goal.status, 'blocked');
  assert.equal(result.stopReason, 'interaction_required');
  assert.equal(result.lastTurn.blockedReason, 'unsupported_server_request:item/newAuthority/request');
  assert.equal(rpc.errors.at(-1).id, 99);
  assert.equal(rpc.calls.some(({ method }) => method === 'turn/interrupt'), true);
});

test('usageLimited remains authoritative when its turn ends interrupted', async (t) => {
  const { rpc, client } = await openOwnedClient(t);
  rpc.when('thread/goal/set', ({ params }) => {
    assert.equal(params.status, 'active');
    rpc.emit('notification', {
      method: 'turn/started',
      params: { threadId: 'thread-owned', turn: { id: 'turn-usage-limit', status: 'inProgress' } },
    });
    return { goal: goal('active') };
  });

  const promise = client.runNativeGoal({
    threadId: 'thread-owned',
    objective: 'Finish safely',
    timeoutMs: 5000,
    turnTimeoutMs: 5000,
    maxTurns: 2,
    signal: new AbortController().signal,
  });
  await new Promise(setImmediate);
  rpc.emit('notification', {
    method: 'thread/goal/updated',
    params: { threadId: 'thread-owned', turnId: 'turn-usage-limit', goal: goal('usageLimited', 10) },
  });
  rpc.emit('notification', {
    method: 'turn/completed',
    params: {
      threadId: 'thread-owned',
      turn: { id: 'turn-usage-limit', status: 'interrupted', error: null, items: [] },
    },
  });

  const result = await promise;
  assert.equal(result.goal.status, 'usageLimited');
  assert.equal(result.stopReason, null);
  assert.equal(result.lastTurn.blockedReason, null);
  assert.equal(rpc.calls.some(({ method, params }) => method === 'thread/goal/set' && params.status === 'blocked'), false);
});

test('thread responses reject unknown status variants', async (t) => {
  const { rpc, client } = await openOwnedClient(t);
  rpc.when('thread/read', () => ({ thread: { ...thread('thread-owned'), status: { type: 'futureState' } } }));
  await assert.rejects(() => client.readThread('thread-owned'), /estado de thread invalido/);
});

test('server approval requests are denied', async (t) => {
  const { rpc } = await openOwnedClient(t);
  rpc.emit('request', {
    id: 41,
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 'thread-owned', turnId: 'turn-1', itemId: 'item-1' },
  });
  rpc.emit('request', {
    id: 42,
    method: 'item/fileChange/requestApproval',
    params: { threadId: 'thread-owned', turnId: 'turn-1', itemId: 'item-2' },
  });

  assert.deepEqual(rpc.responses, [
    { id: 41, result: { decision: 'decline' } },
    { id: 42, result: { decision: 'decline' } },
  ]);
});

test('persisted declined approvals remain blocked after crash recovery', async (t) => {
  const { rpc, client } = await openOwnedClient(t);
  rpc.when('thread/turns/list', () => ({
    data: [{
      id: 'turn-declined',
      status: 'completed',
      error: null,
      items: [{ type: 'commandExecution', command: 'dangerous', status: 'declined' }],
    }],
    nextCursor: null,
  }));

  const turns = await client.listTurns('thread-owned');
  assert.equal(turns[0].blockedReason, 'approval_declined:commandExecution');
});

test('legacy approvals correlate conversationId and use the legacy denial shape', async (t) => {
  const { rpc } = await openOwnedClient(t);
  rpc.emit('request', {
    id: 41,
    method: 'execCommandApproval',
    params: { conversationId: 'thread-owned' },
  });
  assert.deepEqual(rpc.responses.at(-1), {
    id: 41,
    result: { decision: { denied: { rejection: 'Denied in unattended mode.' } } },
  });
});

test('verification feedback is injected without replacing the Goal objective', async (t) => {
  const { rpc, client } = await openOwnedClient(t);
  rpc.when('thread/inject_items', () => ({}));
  await client.injectText('thread-owned', 'verification failed');
  const call = rpc.calls.find(({ method }) => method === 'thread/inject_items');
  assert.equal(call.params.items[0].type, 'message');
  assert.equal(call.params.items[0].content[0].text, 'verification failed');
});

test('listThreads requests every persisted source kind', async (t) => {
  const rpc = new FakeTransport();
  const client = new CodexDesktopClient(rpc, logger);
  t.after(() => client.close());
  rpc.when('thread/list', () => ({ data: [thread('thread-listed')], nextCursor: null }));

  const threads = await client.listThreads('D:\\workspace', 25);
  assert.equal(threads[0].id, 'thread-listed');
  assert.deepEqual(rpc.calls[0].params.sourceKinds, ALL_SOURCE_KINDS);
});
