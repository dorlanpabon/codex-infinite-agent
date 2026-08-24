import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

test('desktop renderer modules and preload are included in the local protocol build', async () => {
  const [main, renderer, html] = await Promise.all([
    readFile(path.join(root, 'dist', 'desktop', 'main.js'), 'utf8'),
    readFile(path.join(root, 'dist', 'desktop', 'renderer', 'app.js'), 'utf8'),
    readFile(path.join(root, 'dist', 'desktop', 'renderer', 'index.html'), 'utf8'),
    access(path.join(root, 'dist', 'desktop', 'preload.cjs')),
  ]);
  const imports = [...renderer.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/gu)].map((match) => match[1]);
  assert.ok(imports.length > 0);
  for (const specifier of imports) {
    const pathname = new URL(specifier, 'codex-infinite://app/app.js').pathname;
    assert.match(main, new RegExp(`\\[['"]${pathname.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}['"]`));
  }
  assert.match(html, /frame-src 'none'; worker-src 'none'/u);
  assert.match(html, /id="resume-dialog"/u);
  assert.doesNotMatch(renderer, /\.innerHTML\b/u);
  assert.doesNotMatch(renderer, /verifyCommands:\s*run\.verifyCommands/u);
  assert.doesNotMatch(renderer, /network:\s*run\.network/u);
  assert.doesNotMatch(renderer, /dangerFullAccess:\s*run\.dangerFullAccess/u);
  assert.match(renderer, /network:\s*ui\.resumeNetwork\.checked/u);
});
