import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FIXED_DESKTOP_BINARIES,
  isSupportedDesktopPlatform,
} from '../dist/app-server/binary.js';

test('Desktop bundle locations are fixed to official platform installs', () => {
  assert.equal(FIXED_DESKTOP_BINARIES.darwin, '/Applications/ChatGPT.app/Contents/Resources/codex');
  assert.equal(FIXED_DESKTOP_BINARIES.linux, '/usr/lib/chatgpt/resources/codex');
});

test('Desktop platform matrix fails closed', () => {
  assert.equal(isSupportedDesktopPlatform('win32', 'x64'), true);
  assert.equal(isSupportedDesktopPlatform('win32', 'arm64'), false);
  assert.equal(isSupportedDesktopPlatform('darwin', 'arm64'), true);
  assert.equal(isSupportedDesktopPlatform('darwin', 'x64'), true);
  assert.equal(isSupportedDesktopPlatform('linux', 'x64'), true);
  assert.equal(isSupportedDesktopPlatform('linux', 'arm64'), true);
  assert.equal(isSupportedDesktopPlatform('freebsd', 'x64'), false);
});
