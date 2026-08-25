import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);

test('desktop renderer modules and preload are included in the local protocol build', async () => {
  const [main, renderer, html, css, preload] = await Promise.all([
    readFile(path.join(root, 'dist', 'desktop', 'main.js'), 'utf8'),
    readFile(path.join(root, 'dist', 'desktop', 'renderer', 'app.js'), 'utf8'),
    readFile(path.join(root, 'dist', 'desktop', 'renderer', 'index.html'), 'utf8'),
    readFile(path.join(root, 'dist', 'desktop', 'renderer', 'app.css'), 'utf8'),
    readFile(path.join(root, 'dist', 'desktop', 'preload.cjs'), 'utf8'),
  ]);
  const imports = [...renderer.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/gu)].map((match) => match[1]);
  assert.ok(imports.length > 0);
  for (const specifier of imports) {
    const pathname = new URL(specifier, 'codex-infinite://app/app.js').pathname;
    assert.match(main, new RegExp(`\\[['"]${pathname.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}['"]`));
  }
  assert.match(html, /frame-src 'none'; worker-src 'none'/u);
  assert.match(html, /id="resume-dialog"/u);
  assert.match(html, /id="sessions-tab"/u);
  assert.match(html, /id="sessions-panel"/u);
  assert.match(html, /id="goal-thread"/u);
  assert.match(html, /id="attachment-dropzone"/u);
  assert.match(html, /id="attachment-picker-button"/u);
  assert.match(html, /id="goal-model"[^>]*list="goal-model-options"/u);
  assert.match(html, /id="goal-model-options"/u);
  assert.match(html, /id="models-refresh-button"/u);
  assert.match(html, /id="model-help"[^>]*aria-live="polite"/u);
  assert.match(html, /id="inspect-open-codex-button"[^>]*hidden/u);
  assert.doesNotMatch(html, /id="goal-objective"[^>]*maxlength=/u);
  assert.match(renderer, /Coloca el objetivo para activar/u);
  assert.match(renderer, /window\.setTimeout\(\(\) => ui\.objectiveInput\.focus\(\), 0\)/u);
  assert.match(renderer, /api\.pathForFile\(file\)/u);
  assert.match(renderer, /api\.inspectAttachments\(paths\)/u);
  assert.match(renderer, /if \(session\.goal\) \{\s*await activateExistingGoal\(session\)/su);
  assert.match(renderer, /setAttribute\('role', 'switch'\)/u);
  assert.match(renderer, /setAttribute\('aria-describedby', state\.id\)/u);
  assert.match(renderer, /pendingSwitchFocusThreadId/u);
  assert.match(renderer, /sessionsPanel\.setAttribute\('aria-busy', 'true'\)/u);
  assert.match(renderer, /api\.listSessions/u);
  assert.match(renderer, /api\.listModels/u);
  assert.match(renderer, /model\.isDefault/u);
  assert.match(renderer, /preferredNewModel/u);
  assert.match(renderer, /refreshModelsForConnectionChange/u);
  assert.match(renderer, /if \(!modelSelectionManual && !attachSession\)/u);
  assert.match(renderer, /model:\s*ui\.modelInput\.value\.trim\(\)\s*\|\|\s*null/u);
  assert.match(renderer, /supportedReasoningEfforts/u);
  assert.match(renderer, /Catálogo no disponible/u);
  assert.match(renderer, /api\.openCodexThread\(threadId\)/u);
  assert.match(renderer, /session-open-button/u);
  assert.match(renderer, /Abrir en Codex/u);
  assert.match(renderer, /toast\(message, true\)/u);
  assert.match(renderer, /sessionsRefreshInFlight/u);
  assert.match(renderer, /generation !== sessionsRefreshGeneration/u);
  assert.match(renderer, /active: 'Activa'/u);
  assert.doesNotMatch(renderer, /Tareas Desktop/u);
  assert.match(css, /\.session-switch\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px;/su);
  assert.match(css, /\.session-open-button\s*\{[^}]*min-height:\s*44px;/su);
  assert.match(css, /\.sessions-panel\s*\{[^}]*display:\s*flex;[^}]*overflow:\s*hidden;/su);
  assert.match(css, /\.session-list\s*\{[^}]*flex:\s*1;[^}]*overflow-y:\s*auto;/su);
  assert.match(html, /id="sessions-panel"[^>]*aria-busy="false"/u);
  assert.match(html, /id="thread-list"[^>]*aria-busy="false"/u);
  assert.doesNotMatch(renderer, /\.innerHTML\b/u);
  assert.doesNotMatch(renderer, /verifyCommands:\s*run\.verifyCommands/u);
  assert.doesNotMatch(renderer, /network:\s*run\.network/u);
  assert.doesNotMatch(renderer, /dangerFullAccess:\s*run\.dangerFullAccess/u);
  assert.match(renderer, /network:\s*ui\.resumeNetwork\.checked/u);
  assert.match(main, /shell\.openExternal\(deepLink\)/u);
  assert.match(main, /threads:open-in-codex/u);
  assert.match(main, /models:list/u);
  assert.match(preload, /threads:open-in-codex/u);
  assert.match(preload, /models:list/u);
  assert.doesNotMatch(preload, /openExternal/u);
});

test('desktop package uses a strict application allowlist', () => {
  const { makers, packagerConfig } = require('../forge.config.cjs');
  const isIgnored = (candidate) => packagerConfig.ignore.some((pattern) => pattern.test(candidate));

  assert.match(packagerConfig.name, /^[A-Za-z0-9._-]+$/u);
  assert.equal(packagerConfig.name, packagerConfig.executableName);
  assert.equal(packagerConfig.win32metadata.ProductName, 'Codex Infinite');
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
  const windowsMaker = makers.find((maker) => maker.platforms?.includes('win32'));
  assert.ok(windowsMaker);
  assert.equal(windowsMaker.config.title, 'Codex Infinite');
  assert.equal(linuxMakers.length, 2);
  assert.equal(linuxMakers.every((maker) => maker.config.options.bin === packagerConfig.executableName), true);
});
