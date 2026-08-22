import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const target = path.resolve(projectRoot, 'dist');

if (path.dirname(target) !== projectRoot || path.basename(target) !== 'dist') {
  throw new Error(`Refusing to clean unexpected path: ${target}`);
}

await rm(target, { recursive: true, force: true });
