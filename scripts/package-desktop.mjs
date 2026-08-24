import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const forgeConfig = require('../forge.config.cjs');
const electronVersion = require('electron/package.json').version;

const outputPaths = await packager({
  ...forgeConfig.packagerConfig,
  dir: root,
  out: path.join(root, 'out'),
  overwrite: true,
  platform: process.platform,
  arch: process.arch,
  electronVersion,
});

if (outputPaths.length !== 1) {
  throw new Error(`Se esperaba un paquete de escritorio y se obtuvieron ${outputPaths.length}.`);
}
process.stdout.write(`Paquete creado: ${outputPaths[0]}\n`);
