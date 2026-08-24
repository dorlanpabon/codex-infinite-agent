import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseAttachRunInput,
  parseDoctorInput,
  parseResumeRunInput,
  parseRunId,
  parseStartRunInput,
} from '../dist/desktop/contracts.js';

const startInput = {
  objective: 'Termina la migracion y verifica el resultado',
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

test('desktop contracts accept bounded exact inputs', () => {
  assert.deepEqual(parseStartRunInput(startInput), startInput);
  assert.deepEqual(parseDoctorInput({ workspace: null, binary: null }), { workspace: null, binary: null });
  assert.equal(parseRunId('123e4567-e89b-42d3-a456-426614174000'), '123e4567-e89b-42d3-a456-426614174000');
  assert.deepEqual(parseAttachRunInput({ ...startInput, threadId: 'thread-existing' }), {
    ...startInput,
    threadId: 'thread-existing',
  });
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
  assert.throws(() => parseAttachRunInput({ ...startInput, threadId: 'thread-ok', extra: true }), /invalidos/i);
});
