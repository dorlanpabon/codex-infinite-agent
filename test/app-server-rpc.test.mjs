import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundedJsonLineFramer } from '../dist/app-server/rpc.js';

test('bounded JSON line framing preserves fragmented UTF-8 and CRLF messages', () => {
  const framer = new BoundedJsonLineFramer();
  const lines = [];
  const first = Buffer.from('{"id":1,"result":"café"}\r\n');

  framer.push(first.subarray(0, first.indexOf(0xc3) + 1), (line) => lines.push(line));
  framer.push(Buffer.concat([
    first.subarray(first.indexOf(0xc3) + 1),
    Buffer.from('{"id":2,"result":true}\n'),
  ]), (line) => lines.push(line));

  assert.deepEqual(lines, [
    '{"id":1,"result":"café"}',
    '{"id":2,"result":true}',
  ]);
});

test('bounded JSON line framing rejects fragmented input above 16 MiB before newline', () => {
  const framer = new BoundedJsonLineFramer();
  const chunk = Buffer.alloc(64 * 1024, 0x61);

  for (let index = 0; index < 256; index += 1) framer.push(chunk, () => assert.fail('unexpected line'));

  assert.throws(
    () => framer.push(Buffer.from('b'), () => assert.fail('unexpected line')),
    (error) => error?.code === 'RPC_MESSAGE_TOO_LARGE',
  );
});
