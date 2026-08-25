import { readFileSync } from 'node:fs';
import path from 'node:path';
import { AppError, errorMessage } from './errors.js';
import { createLogger, sanitizeLog } from './log.js';
import {
  listRuns,
  loadRun,
  type RunState,
} from './state.js';
import {
  doctorDesktop,
  listDesktopThreads,
  resumeGoal,
  startGoal,
  terminalExitCode,
} from './operations.js';

const packageMetadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as unknown;
if (typeof packageMetadata !== 'object' || packageMetadata === null
  || !('version' in packageMetadata) || typeof packageMetadata.version !== 'string') {
  throw new Error('package.json no contiene una versión válida.');
}
const VERSION = packageMetadata.version;
const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Set<string>;
  values: Map<string, string[]>;
}

const HELP = `Codex Desktop Infinite Agent ${VERSION}

Uso:
  codex-infinite run "objetivo" [opciones]
  codex-infinite resume <run-id> [--dir ruta] [opciones]
  codex-infinite status <run-id>
  codex-infinite runs
  codex-infinite threads [--dir ruta] [--limit n]
  codex-infinite doctor [--dir ruta] [--bin ruta]

Opciones de run:
  --dir ruta                  Repositorio Git (predeterminado: directorio actual)
  --name texto                Nombre visible del thread en Codex Desktop
  --max-turns n               Limite durable de turnos (30)
  --max-hours n               Limite total en horas (8)
  --turn-minutes n            Limite por turno en minutos (45)
  --token-budget n            Presupuesto nativo de Goal
  --verify comando            Verificacion host; se puede repetir
  --model id                  Modelo de Codex
  --effort nivel              minimal|low|medium|high|xhigh|max|ultra
  --network                   Habilitar red dentro del sandbox
  --danger-full-access        Desactivar el sandbox del workspace
  --bin ruta                  Binario App Server explicito
  --verbose                   Diagnostico adicional
`;

const COMMAND_OPTIONS: Record<string, { flags: Set<string>; values: Set<string>; repeatable?: Set<string> }> = {
  run: {
    flags: new Set(['network', 'danger-full-access', 'verbose']),
    values: new Set(['dir', 'name', 'max-turns', 'max-hours', 'turn-minutes', 'token-budget', 'verify', 'model', 'effort', 'bin']),
    repeatable: new Set(['verify']),
  },
  resume: {
    flags: new Set(['network', 'danger-full-access', 'verbose']),
    values: new Set(['dir', 'verify', 'bin']),
    repeatable: new Set(['verify']),
  },
  status: { flags: new Set(), values: new Set() },
  runs: { flags: new Set(), values: new Set() },
  threads: { flags: new Set(['verbose']), values: new Set(['dir', 'limit', 'bin']) },
  doctor: { flags: new Set(['verbose']), values: new Set(['dir', 'bin']) },
};

function parseArgs(argv: string[]): ParsedArgs {
  const first = argv[0];
  if (!first || first === '--help' || first === '-h') return { command: 'help', positionals: [], flags: new Set(), values: new Map() };
  if (first === '--version' || first === '-v') return { command: 'version', positionals: [], flags: new Set(), values: new Map() };
  const spec = COMMAND_OPTIONS[first];
  if (!spec) throw new AppError('UNKNOWN_COMMAND', `Comando desconocido: ${first}`);
  const result: ParsedArgs = { command: first, positionals: [], flags: new Set(), values: new Map() };

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === '--help' || token === '-h') return { command: 'help', positionals: [], flags: new Set(), values: new Map() };
    if (!token.startsWith('--')) {
      result.positionals.push(token);
      continue;
    }
    const equals = token.indexOf('=');
    const name = token.slice(2, equals === -1 ? undefined : equals);
    if (spec.flags.has(name)) {
      if (equals !== -1) throw new AppError('INVALID_ARGUMENT', `--${name} no recibe valor.`);
      result.flags.add(name);
      continue;
    }
    if (!spec.values.has(name)) throw new AppError('UNKNOWN_OPTION', `Opcion desconocida para ${first}: --${name}`);
    const value = equals === -1 ? argv[++index] : token.slice(equals + 1);
    if (!value || value.startsWith('--')) throw new AppError('MISSING_OPTION_VALUE', `Falta el valor de --${name}.`);
    const existing = result.values.get(name) ?? [];
    if (existing.length > 0 && !spec.repeatable?.has(name)) throw new AppError('DUPLICATE_OPTION', `--${name} no se puede repetir.`);
    existing.push(value);
    result.values.set(name, existing);
  }
  return result;
}

function value(args: ParsedArgs, name: string): string | undefined {
  return args.values.get(name)?.[0];
}

function positiveNumber(raw: string | undefined, fallback: number, name: string, integer = false, maximum = Number.MAX_SAFE_INTEGER): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > maximum || (integer && !Number.isSafeInteger(parsed))) {
    throw new AppError('INVALID_ARGUMENT', `--${name} debe ser un numero positivo${integer ? ' entero' : ''}.`);
  }
  return parsed;
}

function requirePositionals(args: ParsedArgs, count: number, usage: string): void {
  if (args.positionals.length !== count) throw new AppError('INVALID_ARGUMENT', `Uso: ${usage}`);
}

function createAbortController(): { controller: AbortController; cleanup(): void } {
  const controller = new AbortController();
  const abort = () => controller.abort(new AppError('INTERRUPTED', 'Interrumpido por el usuario.', 130));
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  return {
    controller,
    cleanup: () => {
      process.removeListener('SIGINT', abort);
      process.removeListener('SIGTERM', abort);
    },
  };
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function executeRun(args: ParsedArgs): Promise<number> {
  requirePositionals(args, 1, 'codex-infinite run "objetivo" [opciones]');
  const effortValue = value(args, 'effort');
  if (effortValue && !EFFORTS.has(effortValue)) throw new AppError('INVALID_ARGUMENT', 'Nivel --effort invalido.');
  const tokenBudgetRaw = value(args, 'token-budget');
  const tokenBudget = tokenBudgetRaw === undefined ? null : positiveNumber(tokenBudgetRaw, 0, 'token-budget', true, 2_000_000_000);
  const abort = createAbortController();
  const logger = createLogger(args.flags.has('verbose'));
  try {
    const state = await startGoal({
    objective: args.positionals[0]!,
    directory: value(args, 'dir') ?? process.cwd(),
    name: value(args, 'name'),
    maxTurns: positiveNumber(value(args, 'max-turns'), 30, 'max-turns', true, 1000),
    turnMinutes: positiveNumber(value(args, 'turn-minutes'), 45, 'turn-minutes', false, 1440),
    maxHours: positiveNumber(value(args, 'max-hours'), 8, 'max-hours', false, 720),
    tokenBudget,
    network: args.flags.has('network'),
    dangerFullAccess: args.flags.has('danger-full-access'),
    verifyCommands: args.values.get('verify') ?? [],
    model: value(args, 'model'),
    effort: effortValue ? effortValue as RunState['effort'] : null,
    binary: value(args, 'bin'),
    }, abort.controller.signal, logger);
    output(state);
    return terminalExitCode(state);
  } finally {
    abort.cleanup();
  }
}

async function executeResume(args: ParsedArgs): Promise<number> {
  requirePositionals(args, 1, 'codex-infinite resume <run-id>');
  const logger = createLogger(args.flags.has('verbose'));
  const abort = createAbortController();
  try {
    const state = await resumeGoal({
      runId: args.positionals[0]!,
      directory: value(args, 'dir') ?? process.cwd(),
      verifyCommands: args.values.get('verify') ?? [],
      network: args.flags.has('network'),
      dangerFullAccess: args.flags.has('danger-full-access'),
      binary: value(args, 'bin'),
    }, abort.controller.signal, logger);
    output(state);
    return terminalExitCode(state);
  } finally {
    abort.cleanup();
  }
}

async function executeThreads(args: ParsedArgs): Promise<number> {
  requirePositionals(args, 0, 'codex-infinite threads [opciones]');
  const directory = value(args, 'dir');
  const limit = positiveNumber(value(args, 'limit'), 50, 'limit', true);
  const logger = createLogger(args.flags.has('verbose'));
  output(await listDesktopThreads(directory ? path.resolve(directory) : null, limit, value(args, 'bin') ?? null, logger));
  return 0;
}

async function executeDoctor(args: ParsedArgs): Promise<number> {
  requirePositionals(args, 0, 'codex-infinite doctor [opciones]');
  const directory = value(args, 'dir');
  const logger = createLogger(args.flags.has('verbose'));
  const result = await doctorDesktop(directory ? path.resolve(directory) : null, value(args, 'bin') ?? null, logger);
  output(result);
  return result.ok ? 0 : 2;
}

export async function runCli(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.command === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.command === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (args.command === 'run') return executeRun(args);
  if (args.command === 'resume') return executeResume(args);
  if (args.command === 'status') {
    requirePositionals(args, 1, 'codex-infinite status <run-id>');
    output(await loadRun(args.positionals[0]!));
    return 0;
  }
  if (args.command === 'runs') {
    requirePositionals(args, 0, 'codex-infinite runs');
    output((await listRuns()).map(({ runId, threadId, name, workspace, status, turnCount, totalTokens, updatedAt }) => ({
      runId, threadId, name, workspace, status, turnCount, totalTokens, updatedAt,
    })));
    return 0;
  }
  if (args.command === 'threads') return executeThreads(args);
  if (args.command === 'doctor') return executeDoctor(args);
  throw new AppError('UNKNOWN_COMMAND', `Comando desconocido: ${args.command}`);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  try {
    process.exitCode = await runCli(argv);
  } catch (error) {
    const appError = error instanceof AppError ? error : new AppError('UNEXPECTED_ERROR', errorMessage(error));
    process.stderr.write(`${JSON.stringify({ error: appError.code, message: sanitizeLog(appError.message) })}\n`);
    process.exitCode = appError.exitCode;
  }
}
