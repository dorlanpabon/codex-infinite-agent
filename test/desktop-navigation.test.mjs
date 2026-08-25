import assert from 'node:assert/strict';
import test from 'node:test';
import { DesktopNavigationQueue } from '../dist/desktop/navigation.js';

const run = (id) => ({ kind: 'run', id });

test('desktop navigation waits for renderer readiness and preserves launch order', () => {
  const queue = new DesktopNavigationQueue();
  queue.enqueue(run('first'));
  queue.enqueue(run('second'));

  assert.deepEqual(queue.takeReady(), []);
  assert.deepEqual(queue.markRendererReady(), [run('first'), run('second')]);
  assert.deepEqual(queue.takeReady(), []);

  queue.enqueue(run('warm'));
  assert.deepEqual(queue.takeReady(), [run('warm')]);
});

test('desktop navigation reset queues warm links until the replacement renderer is ready', () => {
  const queue = new DesktopNavigationQueue();
  queue.markRendererReady();
  queue.resetRenderer();
  queue.enqueue({ kind: 'session', id: 'after-reload' });

  assert.deepEqual(queue.takeReady(), []);
  assert.deepEqual(queue.markRendererReady(), [{ kind: 'session', id: 'after-reload' }]);
});

test('desktop navigation bounds pending OS links to the newest twenty', () => {
  const queue = new DesktopNavigationQueue();
  for (let index = 1; index <= 25; index += 1) queue.enqueue(run(String(index)));

  assert.deepEqual(queue.markRendererReady(), Array.from({ length: 20 }, (_, index) => run(String(index + 6))));
  assert.deepEqual(queue.takeReady(), []);
});
