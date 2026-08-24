import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'src', 'desktop', 'renderer');
const destination = path.join(root, 'dist', 'desktop', 'renderer');

await mkdir(destination, { recursive: true });
await Promise.all([
  copyFile(path.join(source, 'index.html'), path.join(destination, 'index.html')),
  copyFile(path.join(source, 'app.css'), path.join(destination, 'app.css')),
]);
