import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);

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

test('desktop package uses a strict application allowlist', () => {
  const { makers, packagerConfig } = require('../forge.config.cjs');
  const isIgnored = (candidate) => packagerConfig.ignore.some((pattern) => pattern.test(candidate));

  assert.equal(isIgnored('/dist/desktop/main.js'), false);
  assert.equal(isIgnored('/node_modules/electron-squirrel-startup/index.js'), false);
  assert.equal(isIgnored('/node_modules/debug/src/index.js'), false);
  assert.equal(isIgnored('/node_modules/ms/index.js'), false);
  assert.equal(isIgnored('/NVIDIA Corporation/umdlogs'), true);
  assert.equal(isIgnored('/.gitignore'), true);
  assert.equal(isIgnored('/forge.config.cjs'), true);
  assert.equal(isIgnored('/node_modules/@electron-forge/cli/package.json'), true);
  assert.equal(
    isIgnored('/native/windows-job-wrapper/bin/windows-x64/codex-infinite-job-wrapper.exe'),
    process.platform !== 'win32',
  );
  const linuxMakers = makers.filter((maker) => maker.platforms?.includes('linux'));
  assert.equal(linuxMakers.length, 2);
  assert.equal(linuxMakers.every((maker) => maker.config.options.bin === packagerConfig.executableName), true);
});
