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
    const pathname = new URL(specifier, 'codex-infinite-app://app/app.js').pathname;
    assert.match(main, new RegExp(`\\[['"]${pathname.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}['"]`));
  }
  assert.match(html, /frame-src 'none'; worker-src 'none'/u);
  assert.match(html, /id="resume-dialog"/u);
  assert.match(html, /id="context-dialog"/u);
  assert.match(html, /id="copy-run-link-button"/u);
  assert.match(html, /id="run-context-button"/u);
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
  assert.match(renderer, /api\.recentMessages/u);
  assert.match(renderer, /reconcileSelectedSession\(/u);
  assert.doesNotMatch(renderer, /retainedSelection/u);
  assert.match(renderer, /binary:\s*currentBinary\(\)/u);
  assert.doesNotMatch(renderer, /doctorResult\?\.binary\.path/u);
  assert.match(renderer, /api\.copyDeepLink/u);
  assert.match(renderer, /contextTarget = null/u);
  assert.match(renderer, /contextMessageList\.replaceChildren\(\)/u);
  assert.match(renderer, /run\.status === 'completed' \|\| run\.status === 'budgetLimited'/u);
  assert.match(renderer, /run\.status === 'failed'\)\s*return 'Reintentar'/u);
  assert.match(renderer, /run\.status === 'blocked'\)\s*return 'Revisar y reanudar'/u);
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

test('desktop deep links cover cold, warm, and macOS launches without automatic actions', async () => {
  const [main, renderer, preload] = await Promise.all([
    readFile(path.join(root, 'dist', 'desktop', 'main.js'), 'utf8'),
    readFile(path.join(root, 'dist', 'desktop', 'renderer', 'app.js'), 'utf8'),
    readFile(path.join(root, 'dist', 'desktop', 'preload.cjs'), 'utf8'),
  ]);

  assert.match(main, /const startupArguments = squirrelStartup \? \[\] : \[\.\.\.process\.argv\]/u);
  assert.match(main, /app\.on\('open-url',[\s\S]*?receiveDeepLinks\(\[url\]\)/u);
  assert.match(main, /app\.on\('second-instance',[\s\S]*?receiveDeepLinks\(commandLine\)/u);
  assert.match(main, /receiveDeepLinks\(startupArguments\)/u);
  assert.match(main, /app\.setAsDefaultProtocolClient\('codex-infinite'/u);
  assert.match(main, /process\.argv\[1\]/u);
  assert.match(main, /--squirrel-install/u);
  assert.match(main, /--squirrel-updated/u);
  assert.match(main, /--squirrel-uninstall/u);
  assert.match(main, /app\.removeAsDefaultProtocolClient\('codex-infinite'\)/u);
  assert.match(main, /navigationQueue\.markRendererReady\(\)/u);
  assert.match(main, /if \(!desktopReady\)\s*return/u);
  assert.doesNotMatch(main, /setImmediate\(flushNavigationQueue\)/u);
  assert.match(preload, /navigationReady:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(CHANNELS\.navigationReady\)/u);
  assert.match(renderer, /const initialTargets = await api\.navigationReady\(\)/u);
  assert.match(renderer, /for \(const target of initialTargets\)\s*await scheduleNavigation\(target\)/u);
  assert.match(renderer, /case 'navigation-requested':[\s\S]*?scheduleNavigation\(event\.target\)/u);

  const start = renderer.indexOf('async function handleNavigationTarget');
  const end = renderer.indexOf('function scheduleNavigation', start);
  assert.ok(start >= 0 && end > start);
  const navigationHandler = renderer.slice(start, end);
  assert.match(navigationHandler, /api\.getRun\(target\.id\)/u);
  assert.match(navigationHandler, /api\.getSession\(/u);
  assert.doesNotMatch(navigationHandler, /api\.(?:attachRun|startRun|resumeRun|pauseRun)\(/u);
  assert.doesNotMatch(navigationHandler, /toggleSession\(|activateExistingGoal\(/u);
});

test('desktop package uses a strict application allowlist', () => {
  const { makers, packagerConfig } = require('../forge.config.cjs');
  const isIgnored = (candidate) => packagerConfig.ignore.some((pattern) => pattern.test(candidate));

  assert.match(packagerConfig.name, /^[A-Za-z0-9._-]+$/u);
  assert.equal(packagerConfig.name, packagerConfig.executableName);
  assert.equal(packagerConfig.win32metadata.ProductName, 'Codex Infinite');
  assert.deepEqual(packagerConfig.protocols, [{
    name: 'Codex Infinite run',
    schemes: ['codex-infinite'],
  }]);
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
  const debMaker = makers.find((maker) => maker.name === '@electron-forge/maker-deb');
  const rpmMaker = makers.find((maker) => maker.name === '@electron-forge/maker-rpm');
  const windowsMaker = makers.find((maker) => maker.platforms?.includes('win32'));
  assert.ok(windowsMaker);
  assert.ok(debMaker);
  assert.ok(rpmMaker);
  assert.equal(windowsMaker.config.title, 'Codex Infinite');
  assert.equal(linuxMakers.length, 2);
  assert.equal(linuxMakers.every((maker) => maker.config.options.bin === packagerConfig.executableName), true);
  assert.deepEqual(debMaker.config.options.mimeType, ['x-scheme-handler/codex-infinite']);
  assert.deepEqual(rpmMaker.config.options.mimeType, ['x-scheme-handler/codex-infinite']);
  assert.deepEqual(rpmMaker.config.options.execArguments, ['%U']);
});
