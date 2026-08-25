import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './errors.js';

function normalizedPath(value: string): string {
  return process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
}

export async function validateAttachmentPaths(candidates: string[]): Promise<string[]> {
  if (candidates.length > 100) throw new AppError('INVALID_ATTACHMENT', 'Se admiten hasta 100 archivos adjuntos por objetivo.');
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 32_767
      || !path.isAbsolute(candidate) || /[\x00-\x1f\x7f]/u.test(candidate)) {
      throw new AppError('INVALID_ATTACHMENT', 'Cada adjunto debe ser una ruta absoluta valida.');
    }
    let resolved: string;
    try {
      resolved = await realpath(candidate);
      if (resolved.length > 32_767 || /[\x00-\x1f\x7f]/u.test(resolved)) throw new Error('invalid resolved path');
      const handle = await open(resolved, 'r');
      try {
        if (!(await handle.stat()).isFile()) throw new Error('not a regular file');
      } finally {
        await handle.close();
      }
    } catch (cause) {
      throw new AppError('INVALID_ATTACHMENT', `No se puede leer el archivo adjunto ${path.basename(candidate)}.`, 1, { cause });
    }
    const key = normalizedPath(resolved);
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(resolved);
  }
  return paths;
}
