import path from 'node:path';
import os from 'node:os';
import { AppError, errorMessage } from './errors.js';
import { createLogger, sanitizeLog, type Logger } from './log.js';
import { discoverCodexBinary, type BinaryInfo } from './app-server/binary.js';
import { JsonRpcProcess } from './app-server/rpc.js';
import { CodexDesktopClient } from './app-server/client.js';
import { resolveGitWorkspace } from './git.js';
import {
  acquireWorkspaceLock,
  createRunState,
  listRuns,
  loadRun,
  saveRun,
  type RunState,
} from './state.js';
import { supervise } from './supervisor.js';

const VERSION = '1.0.0';
const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'ultra']);

interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Set<string>;
  values: Map<string, string[]>;
}

interface OpenClientResult {
  binary: BinaryInfo;
  client: CodexDesktopClient;
}

const HELP = `Codex Desktop Infinite Agent ${VERSION}

Uso:
  codex-infinite run "objetivo" [opciones]
  codex-infinite resume <run-id> [--bin ruta] [--verbose]
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
  --effort nivel              minimal|low|medium|high|xhigh|ultra
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
  resume: { flags: new Set(['verbose']), values: new Set(['bin']) },
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

async function openClient(cwd: string, explicitBinary: string | undefined, logger: Logger, requireChatGpt = true): Promise<OpenClientResult> {
  const binary = await discoverCodexBinary(explicitBinary);
  logger.info(`App Server ${binary.version} (${binary.source}${binary.signedByOpenAI === true ? ', firma OpenAI valida' : ''}).`);
  const rpc = await JsonRpcProcess.start(binary.path, cwd, logger);
  const client = new CodexDesktopClient(rpc, logger);
  try {
    const account = await client.account();
    if (requireChatGpt && account.account?.type !== 'chatgpt') {
      throw new AppError('DESKTOP_AUTH_REQUIRED', 'Codex App Server no esta autenticado con ChatGPT. Inicia sesion en Codex Desktop y vuelve a intentar.');
    }
    return { binary, client };
  } catch (error) {
    await client.close();
    throw error;
  }
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

function terminalExitCode(state: RunState): number {
  if (state.status === 'completed') return 0;
  if (state.status === 'paused') return 130;
  if (state.status === 'budgetLimited') return 3;
  return 2;
}

async function executeRun(args: ParsedArgs): Promise<number> {
  requirePositionals(args, 1, 'codex-infinite run "objetivo" [opciones]');
  const objective = args.positionals[0]!.trim();
  if (!objective || objective.length > 20_000) throw new AppError('INVALID_OBJECTIVE', 'El objetivo debe tener entre 1 y 20000 caracteres.');
  const baseline = await resolveGitWorkspace(value(args, 'dir') ?? process.cwd());
  const effortValue = value(args, 'effort');
  if (effortValue && !EFFORTS.has(effortValue)) throw new AppError('INVALID_ARGUMENT', 'Nivel --effort invalido.');
  const tokenBudgetRaw = value(args, 'token-budget');
  const tokenBudget = tokenBudgetRaw === undefined ? null : positiveNumber(tokenBudgetRaw, 0, 'token-budget', true, 2_000_000_000);
  const dangerFullAccess = args.flags.has('danger-full-access');
  const name = value(args, 'name')?.trim() || `Infinite: ${objective.replace(/\s+/g, ' ').slice(0, 72)}`;
  if (name.length > 128) throw new AppError('INVALID_ARGUMENT', '--name no puede exceder 128 caracteres.');
  const verifyCommands = args.values.get('verify') ?? [];
  if (verifyCommands.length > 20 || verifyCommands.some((command) => command.length > 4000)) {
    throw new AppError('INVALID_ARGUMENT', '--verify admite hasta 20 comandos de 4000 caracteres cada uno.');
  }
  const state = createRunState({
    workspace: baseline.root,
    objective,
    name,
    maxTurns: positiveNumber(value(args, 'max-turns'), 30, 'max-turns', true, 1000),
    turnTimeoutMs: positiveNumber(value(args, 'turn-minutes'), 45, 'turn-minutes', false, 1440) * 60_000,
    maxWallTimeMs: positiveNumber(value(args, 'max-hours'), 8, 'max-hours', false, 720) * 60 * 60_000,
    tokenBudget,
    network: args.flags.has('network') || dangerFullAccess,
    dangerFullAccess,
    verifyCommands,
    model: value(args, 'model') ?? null,
    effort: effortValue ? effortValue as RunState['effort'] : null,
    gitBaseline: baseline,
  });
  const logger = createLogger(args.flags.has('verbose'));
  const lock = await acquireWorkspaceLock(state.workspace, state.runId);
  const abort = createAbortController();
  let client: CodexDesktopClient | null = null;
  try {
    await saveRun(state);
    if (dangerFullAccess) logger.warn('danger-full-access habilitado explicitamente.');
    ({ client } = await openClient(state.workspace, value(args, 'bin'), logger));
    const finalState = await supervise(client, state, logger, { resume: false, signal: abort.controller.signal });
    output(finalState);
    return terminalExitCode(finalState);
  } catch (error) {
    state.status = 'failed';
    state.completedAt = new Date().toISOString();
    state.lastError = sanitizeLog(errorMessage(error), 4000);
    await saveRun(state).catch(() => undefined);
    throw error;
  } finally {
    abort.cleanup();
    if (client) await client.close().catch(() => undefined);
    await lock.release().catch((error) => logger.error(`No se pudo liberar el lock: ${errorMessage(error)}`));
  }
}

async function executeResume(args: ParsedArgs): Promise<number> {
  requirePositionals(args, 1, 'codex-infinite resume <run-id>');
  const state = await loadRun(args.positionals[0]!);
  if (state.status === 'completed') {
    output(state);
    return 0;
  }
  const baseline = await resolveGitWorkspace(state.workspace);
  const normalize = (candidate: string) => process.platform === 'win32' ? path.resolve(candidate).toLowerCase() : path.resolve(candidate);
  if (!path.isAbsolute(state.workspace) || normalize(baseline.root) !== normalize(state.workspace)) {
    throw new AppError('WORKSPACE_MISMATCH', 'El workspace guardado ya no coincide con su raiz Git.');
  }
  const logger = createLogger(args.flags.has('verbose'));
  const lock = await acquireWorkspaceLock(state.workspace, state.runId);
  const abort = createAbortController();
  let client: CodexDesktopClient | null = null;
  try {
    ({ client } = await openClient(state.workspace, value(args, 'bin'), logger));
    const finalState = await supervise(client, state, logger, { resume: true, signal: abort.controller.signal });
    output(finalState);
    return terminalExitCode(finalState);
  } catch (error) {
    state.status = 'failed';
    state.completedAt = new Date().toISOString();
    state.lastError = sanitizeLog(errorMessage(error), 4000);
    await saveRun(state).catch(() => undefined);
    throw error;
  } finally {
    abort.cleanup();
    if (client) await client.close().catch(() => undefined);
    await lock.release().catch((error) => logger.error(`No se pudo liberar el lock: ${errorMessage(error)}`));
  }
}

async function executeThreads(args: ParsedArgs): Promise<number> {
  requirePositionals(args, 0, 'codex-infinite threads [opciones]');
  const cwd = path.resolve(value(args, 'dir') ?? process.cwd());
  const limit = positiveNumber(value(args, 'limit'), 50, 'limit', true);
  const logger = createLogger(args.flags.has('verbose'));
  const { client } = await openClient(cwd, value(args, 'bin'), logger);
  try {
    output(await client.listThreads(value(args, 'dir') ? cwd : undefined, limit));
    return 0;
  } finally {
    await client.close();
  }
}

async function executeDoctor(args: ParsedArgs): Promise<number> {
  requirePositionals(args, 0, 'codex-infinite doctor [opciones]');
  const cwd = path.resolve(value(args, 'dir') ?? process.cwd());
  const logger = createLogger(args.flags.has('verbose'));
  const { binary, client } = await openClient(cwd, value(args, 'bin'), logger, false);
  try {
    const account = await client.account();
    const threads = await client.listThreads(undefined, 1);
    const ok = account.account?.type === 'chatgpt';
    output({
      ok,
      binary,
      authentication: account.account?.type ?? null,
      planType: account.account?.planType ?? null,
      desktopThreadsVisible: threads.length > 0,
      dataDirectory: path.join(process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(os.homedir(), '.codex'), 'infinite-agent'),
    });
    return ok ? 0 : 2;
  } finally {
    await client.close();
  }
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
