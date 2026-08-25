import assert from 'node:assert/strict';
import test from 'node:test';
import {
  codexThreadDeepLink,
  parseAttachRunInput,
  parseAttachmentPaths,
  parseDoctorInput,
  parseResumeRunInput,
  parseRunId,
  parseStartRunInput,
  parseThreadId,
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

test('desktop contracts accept exact inputs without an artificial objective limit', () => {
  assert.deepEqual(parseStartRunInput(startInput), startInput);
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
  assert.throws(() => parseThreadId('01a0291b-9f2e-0152-9575-c8f7c545b848'), /invalido/i);
  assert.throws(() => parseThreadId('01a0291b-9f2e-7152-7575-c8f7c545b848'), /invalido/i);
  assert.throws(() => codexThreadDeepLink('https://example.com'), /invalido/i);
  assert.throws(() => parseAttachRunInput({ ...startInput, threadId: 'thread-ok', extra: true }), /invalidos/i);
  assert.throws(() => parseStartRunInput({ ...startInput, attachments: ['relative.txt'] }), /invalidos/i);
  assert.throws(() => parseAttachmentPaths(['C:\\file.txt', 'C:\\file.txt']), /invalidas/i);
  assert.throws(() => parseAttachmentPaths(['C:\\bad\nfile.txt']), /invalidas/i);
});
