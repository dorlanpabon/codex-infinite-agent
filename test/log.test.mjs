import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeLog } from '../dist/log.js';

test('sanitizeLog removes terminal control characters and common credentials', () => {
  const value = '\u001b[31mBearer abc.def.ghi OPENAI_API_KEY=sk-abcdefghijklmnop\u0000';
  const sanitized = sanitizeLog(value);
  assert.doesNotMatch(sanitized, /abc\.def|sk-abcdef|\u001b|\u0000/);
  assert.match(sanitized, /\[REDACTED\]/);
});
