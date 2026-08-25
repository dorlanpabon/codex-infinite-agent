import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DESKTOP_ORIGIN,
  codexInfiniteDeepLink,
  codexThreadDeepLink,
  effectiveDesktopBinary,
  parseAttachRunInput,
  parseAttachmentPaths,
  parseCodexInfiniteDeepLink,
  parseCodexInfiniteDeepLinks,
  parseDesktopNavigationTarget,
  parseDoctorInput,
  parseRecentMessagesInput,
  parseResumeRunInput,
  parseRunId,
  parseStartRunInput,
  parseThreadId,
  reconcileSelectedSession,
} from '../dist/desktop/contracts.js';

const startInput = {
  objective: 'Termina la migracion y verifica el resultado',
  attachments: [],
  workspace: 'C:\\workspace',
  name: null,
  maxTurns: 30,
  maxHours: 8,
  turnMinutes: 45,
  tokenBudget: null,
  verifyCommands: ['npm test'],
  model: null,
  effort: 'high',
  network: false,
  dangerFullAccess: false,
  dangerConfirmation: false,
  binary: null,
};

const runId = '123e4567-e89b-42d3-a456-426614174000';
const threadId = '01a0291b-9f2e-7152-9575-c8f7c545b848';

test('desktop contracts accept exact inputs without an artificial objective limit', () => {
  assert.deepEqual(parseStartRunInput(startInput), startInput);
  assert.equal(parseStartRunInput({ ...startInput, effort: 'max' }).effort, 'max');
  assert.equal(parseStartRunInput({ ...startInput, objective: 'x'.repeat(20_000) }).objective.length, 20_000);
  assert.deepEqual(parseAttachmentPaths(['C:\\workspace\\brief.pdf']), ['C:\\workspace\\brief.pdf']);
  assert.deepEqual(parseDoctorInput({ workspace: null, binary: null }), { workspace: null, binary: null });
  assert.equal(parseRunId('123e4567-e89b-42d3-a456-426614174000'), '123e4567-e89b-42d3-a456-426614174000');
  assert.deepEqual(parseAttachRunInput({ ...startInput, threadId: '01a0291b-9f2e-7152-9575-c8f7c545b848' }), {
    ...startInput,
    threadId: '01a0291b-9f2e-7152-9575-c8f7c545b848',
  });
  assert.equal(parseThreadId('01a0291b-9f2e-7152-9575-c8f7c545b848'), '01a0291b-9f2e-7152-9575-c8f7c545b848');
  assert.equal(
    codexThreadDeepLink('01A0291B-9F2E-7152-9575-C8F7C545B848'),
    'codex://threads/01a0291b-9f2e-7152-9575-c8f7c545b848',
  );
});

test('desktop contracts reject extra fields and unconfirmed full access', () => {
  assert.throws(() => parseStartRunInput({ ...startInput, extra: true }), /invalidos/i);
  assert.throws(() => parseStartRunInput({ ...startInput, dangerFullAccess: true }), /confirma/i);
  assert.throws(() => parseResumeRunInput({
    runId: '123e4567-e89b-42d3-a456-426614174000',
    verifyCommands: [],
    network: true,
    dangerFullAccess: true,
    dangerConfirmation: false,
    binary: null,
  }), /confirma/i);
});

test('desktop contracts reject malformed identifiers and oversized values', () => {
  assert.throws(() => parseRunId('../state.json'), /invalido/i);
  assert.throws(() => parseStartRunInput({ ...startInput, maxTurns: 1001 }), /invalidos/i);
  assert.throws(() => parseStartRunInput({ ...startInput, verifyCommands: Array.from({ length: 21 }, () => 'true') }), /invalidos/i);
  assert.throws(() => parseAttachRunInput({ ...startInput, threadId: '../thread\n' }), /invalidos/i);
  assert.throws(() => parseThreadId('01a0291b-9f2e-7152-9575-c8f7c545b84'), /invalido/i);
  assert.throws(() => parseThreadId('01a0291b-9f2e-7152-z575-c8f7c545b848'), /invalido/i);
  assert.throws(() => codexThreadDeepLink('https://example.com'), /invalido/i);
  assert.throws(() => parseAttachRunInput({ ...startInput, threadId: 'thread-ok', extra: true }), /invalidos/i);
  assert.throws(() => parseStartRunInput({ ...startInput, attachments: ['relative.txt'] }), /invalidos/i);
  assert.throws(() => parseAttachmentPaths(['C:\\file.txt', 'C:\\file.txt']), /invalidas/i);
  assert.throws(() => parseAttachmentPaths(['C:\\bad\nfile.txt']), /invalidas/i);
});

test('Codex Infinite deep links round-trip exact run and session targets', () => {
  const run = { kind: 'run', id: runId };
  const session = { kind: 'session', id: threadId };

  assert.equal(codexInfiniteDeepLink(run), `codex-infinite://run/${runId}`);
  assert.deepEqual(parseCodexInfiniteDeepLink(codexInfiniteDeepLink(run)), run);
  assert.equal(codexInfiniteDeepLink({ kind: 'session', id: threadId.toUpperCase() }), `codex-infinite://session/${threadId}`);
  assert.deepEqual(parseCodexInfiniteDeepLink(codexInfiniteDeepLink(session)), session);
  assert.deepEqual(parseDesktopNavigationTarget({ kind: 'run', id: runId.toUpperCase() }), run);
  assert.equal(DESKTOP_ORIGIN, 'codex-infinite-app://app');
});

test('Codex Infinite deep links reject non-canonical and ambiguous input', () => {
  const rejected = [
    null,
    '',
    `http://run/${runId}`,
    `codex-infinite-app://run/${runId}`,
    `codex-infinite://unknown/${runId}`,
    `codex-infinite://run/${runId}/`,
    `codex-infinite://run/${runId}?resume=true`,
    `codex-infinite://session/${threadId}#context`,
    `codex-infinite://run/${runId}%2Fextra`,
    'codex-infinite://run/not-a-uuid',
    'codex-infinite://run/123e4567-e89b-02d3-a456-426614174000',
    'codex-infinite://run/123e4567-e89b-42d3-7456-426614174000',
  ];

  for (const value of rejected) {
    assert.throws(() => parseCodexInfiniteDeepLink(value), /invalido/i);
  }
  assert.throws(() => parseDesktopNavigationTarget({ kind: 'run', id: runId, extra: true }), /invalido/i);
  assert.throws(() => parseDesktopNavigationTarget({ kind: 'session', id: '../session' }), /invalido/i);
});

test('OS argument parsing returns only exact deep links in launch order', () => {
  assert.deepEqual(parseCodexInfiniteDeepLinks([
    'CodexInfinite.exe',
    '--squirrel-firstrun',
    `codex-infinite://run/${runId}`,
    `codex-infinite://run/${runId}?unexpected=true`,
    `codex-infinite://session/${threadId.toUpperCase()}`,
  ]), [
    { kind: 'run', id: runId },
    { kind: 'session', id: threadId },
  ]);
});

test('recent context input is exact and normalizes the session identifier', () => {
  assert.deepEqual(parseRecentMessagesInput({
    binary: null,
    threadId: threadId.toUpperCase(),
    workspace: 'D:\\workspace',
  }), {
    binary: null,
    threadId,
    workspace: 'D:\\workspace',
  });
  assert.throws(() => parseRecentMessagesInput({ binary: null, threadId, workspace: null, extra: true }), /invalidos/i);
});

test('selected session outside the first page is refreshed exactly instead of retaining stale state', async () => {
  const nextSessions = Array.from({ length: 50 }, (_, index) => ({ thread: { id: `page-${index}` } }));
  const fresh = { thread: { id: threadId }, operationActive: true, canEnable: false };

  const result = await reconcileSelectedSession(nextSessions, threadId, async () => fresh, () => true);

  assert.equal(result[0], fresh);
  assert.equal(result.length, 51);
});

test('late exact session response is discarded when selection changes', async () => {
  let resolveExact;
  let current = true;
  const pending = reconcileSelectedSession(
    [],
    threadId,
    () => new Promise((resolve) => { resolveExact = resolve; }),
    () => current,
  );
  current = false;
  resolveExact({ thread: { id: threadId }, operationActive: true });

  assert.equal(await pending, null);
});

test('late exact session response from a previous binary is discarded', async () => {
  let resolveExact;
  let activeBinary = 'D:\\old-codex.exe';
  const capturedBinary = activeBinary;
  const pending = reconcileSelectedSession(
    [],
    threadId,
    () => new Promise((resolve) => { resolveExact = resolve; }),
    () => activeBinary === capturedBinary,
  );
  activeBinary = 'D:\\new-codex.exe';
  resolveExact({ thread: { id: threadId }, operationActive: true });

  assert.equal(await pending, null);
});

test('current binary input overrides an older detected binary without another doctor run', () => {
  assert.equal(effectiveDesktopBinary(' D:\\new-codex.exe ', 'D:\\old-codex.exe'), 'D:\\new-codex.exe');
  assert.equal(effectiveDesktopBinary('   ', 'D:\\old-codex.exe'), 'D:\\old-codex.exe');
});
