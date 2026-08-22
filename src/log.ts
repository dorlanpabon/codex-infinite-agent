import { stripVTControlCharacters } from 'node:util';

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

export function sanitizeLog(value: string, maxLength = 4000): string {
  const clean = stripVTControlCharacters(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, '[REDACTED]')
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED]')
    .replace(/((?:OPENAI|CODEX)_API_KEY\s*[=:]\s*)\S+/gi, '$1[REDACTED]');
  return clean.length <= maxLength ? clean : `${clean.slice(0, maxLength)}...`;
}

export function createLogger(verbose = false): Logger {
  const line = (level: string, message: string) => {
    process.stderr.write(`[${new Date().toISOString()}] ${level} ${sanitizeLog(message)}\n`);
  };
  return {
    info: (message) => line('INFO ', message),
    warn: (message) => line('WARN ', message),
    error: (message) => line('ERROR', message),
    debug: (message) => { if (verbose) line('DEBUG', message); },
  };
}
