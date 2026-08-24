import os from 'node:os';
import path from 'node:path';
import { CodexDesktopClient, type ThreadInfo } from './app-server/client.js';
import { discoverCodexBinary, type BinaryInfo } from './app-server/binary.js';
import { JsonRpcProcess } from './app-server/rpc.js';
import { AppError, errorMessage } from './errors.js';
import { resolveGitWorkspace } from './git.js';
import { sanitizeLog, type Logger } from './log.js';
import {
  acquireWorkspaceLock,
  createRunState,
  loadRun,
  saveRun,
  type RunState,
  type WorkspaceLock,
} from './state.js';
import { supervise } from './supervisor.js';

const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'ultra']);

export interface StartGoalOptions {
  objective: string;
  directory: string;
  name?: string | null;
  maxTurns?: number;
  maxHours?: number;
  turnMinutes?: number;
  tokenBudget?: number | null;
  verifyCommands?: string[];
  model?: string | null;
  effort?: RunState['effort'];
  network?: boolean;
  dangerFullAccess?: boolean;
  binary?: string | null;
}

export interface ResumeGoalOptions {
  runId: string;
  directory?: string;
  verifyCommands?: string[];
  network?: boolean;
  dangerFullAccess?: boolean;
  binary?: string | null;
}

export interface OperationHooks {
  onRunChanged?(state: RunState): void;
}

export interface DoctorResult {
  ok: boolean;
  binary: BinaryInfo;
  authentication: string | null;
  planType: string | null;
  desktopThreadsVisible: boolean;
  dataDirectory: string;
}

interface OpenClientResult {
  binary: BinaryInfo;
  client: CodexDesktopClient;
}

interface ManagedCleanup {
  client: CodexDesktopClient | null;
  lock: WorkspaceLock;
  logger: Logger;
  runError: unknown;
  state: RunState;
  hooks?: OperationHooks;
}

function positiveNumber(value: number | undefined, fallback: number, name: string, integer = false, maximum = Number.MAX_SAFE_INTEGER): number {
  const parsed = value ?? fallback;
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > maximum || (integer && !Number.isSafeInteger(parsed))) {
    throw new AppError('INVALID_ARGUMENT', `${name} debe ser un numero positivo${integer ? ' entero' : ''}.`);
  }
  return parsed;
}

function normalizedPath(value: string): string {
  return process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
}

function validateVerificationCommands(commands: string[]): string[] {
  if (commands.length > 20 || commands.some((command) => !command || command.length > 4000)) {
    throw new AppError('INVALID_ARGUMENT', 'Se admiten hasta 20 comandos de verificacion de 4000 caracteres cada uno.');
  }
  return [...commands];
}

function notify(hooks: OperationHooks | undefined, state: RunState, logger: Logger): void {
  try {
    hooks?.onRunChanged?.(state);
  } catch (error) {
    logger.warn(`No se pudo publicar el estado local: ${sanitizeLog(errorMessage(error))}`);
  }
}

function requiresWorkspaceQuarantine(error: unknown): boolean {
  return error instanceof AppError && new Set([
    'HOST_PROCESS_UNCERTAIN',
    'PROCESS_TREE_TERMINATION_UNCERTAIN',
    'PRIVILEGE_CLEANUP_UNCERTAIN',
    'REMOTE_STATE_UNCERTAIN',
  ]).has(error.code);
}

async function openClient(cwd: string, explicitBinary: string | null | undefined, logger: Logger, requireChatGpt = true): Promise<OpenClientResult> {
  const binary = await discoverCodexBinary(explicitBinary ?? undefined);
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

async function cleanupManagedRun(context: ManagedCleanup): Promise<void> {
  const { client, hooks, lock, logger, runError, state } = context;
  let closeError: unknown = null;
  if (client) {
    try {
      await client.close();
    } catch (error) {
      closeError = error;
      state.status = 'failed';
      state.completedAt = new Date().toISOString();
      state.lastError = sanitizeLog(errorMessage(error), 4000);
      await saveRun(state).catch(() => undefined);
      notify(hooks, state, logger);
    }
  }
  const quarantineReason = closeError ?? (requiresWorkspaceQuarantine(runError) ? runError : null);
  let quarantineError: unknown = null;
  if (quarantineReason) {
    try {
      await lock.quarantine(errorMessage(quarantineReason));
    } catch (error) {
      quarantineError = error;
    }
  }
  await lock.release().catch((error) => logger.error(`No se pudo liberar el lock: ${errorMessage(error)}`));
  if (quarantineError) {
    throw new AppError('LOCK_QUARANTINE_FAILED', `No se pudo poner el workspace en cuarentena: ${errorMessage(quarantineError)}`, 1, { cause: quarantineError });
  }
  if (closeError) throw closeError;
}

export function terminalExitCode(state: RunState): number {
  if (state.status === 'completed') return 0;
  if (state.status === 'paused') return 130;
  if (state.status === 'budgetLimited') return 3;
  if (state.status === 'failed') return 1;
  return 2;
}

export async function startGoal(
  options: StartGoalOptions,
  signal: AbortSignal,
  logger: Logger,
  hooks?: OperationHooks,
): Promise<RunState> {
  const objective = options.objective.trim();
  if (!objective || objective.length > 4000) throw new AppError('INVALID_OBJECTIVE', 'El objetivo debe tener entre 1 y 4000 caracteres.');
  if (options.model && options.model.length > 256) throw new AppError('INVALID_ARGUMENT', 'El modelo no puede exceder 256 caracteres.');
  if (options.effort && !EFFORTS.has(options.effort)) throw new AppError('INVALID_ARGUMENT', 'Nivel de esfuerzo invalido.');
  const baseline = await resolveGitWorkspace(options.directory, 120_000, signal);
  const dangerFullAccess = options.dangerFullAccess === true;
  const name = options.name?.trim() || `Infinite: ${objective.replace(/\s+/g, ' ').slice(0, 72)}`;
  if (name.length > 128) throw new AppError('INVALID_ARGUMENT', 'El nombre no puede exceder 128 caracteres.');
  const tokenBudget = options.tokenBudget ?? null;
  if (tokenBudget !== null) positiveNumber(tokenBudget, 0, 'tokenBudget', true, 2_000_000_000);
  const state = createRunState({
    workspace: baseline.root,
    objective,
    name,
    maxTurns: positiveNumber(options.maxTurns, 30, 'maxTurns', true, 1000),
    turnTimeoutMs: positiveNumber(options.turnMinutes, 45, 'turnMinutes', false, 1440) * 60_000,
    maxWallTimeMs: positiveNumber(options.maxHours, 8, 'maxHours', false, 720) * 60 * 60_000,
    tokenBudget,
    network: options.network === true || dangerFullAccess,
    dangerFullAccess,
    verifyCommands: validateVerificationCommands(options.verifyCommands ?? []),
    model: options.model ?? null,
    effort: options.effort ?? null,
    gitBaseline: baseline,
  });
  const lock = await acquireWorkspaceLock(state.workspace, state.runId);
  let client: CodexDesktopClient | null = null;
  let finalState: RunState | null = null;
  let runError: unknown = null;
  try {
    await saveRun(state);
    notify(hooks, state, logger);
    if (dangerFullAccess) logger.warn('danger-full-access habilitado explicitamente.');
    ({ client } = await openClient(state.workspace, options.binary, logger));
    finalState = await supervise(client, state, logger, { resume: false, signal });
    notify(hooks, finalState, logger);
  } catch (error) {
    runError = error;
    state.status = 'failed';
    state.completedAt = new Date().toISOString();
    state.lastError = sanitizeLog(errorMessage(error), 4000);
    await saveRun(state).catch(() => undefined);
    notify(hooks, state, logger);
    throw error;
  } finally {
    await cleanupManagedRun({ client, hooks, lock, logger, runError, state });
  }
  return finalState!;
}

export async function resumeGoal(
  options: ResumeGoalOptions,
  signal: AbortSignal,
  logger: Logger,
  hooks?: OperationHooks,
): Promise<RunState> {
  const state = await loadRun(options.runId);
  if (state.status === 'completed') return state;
  const baseline = await resolveGitWorkspace(options.directory ?? state.workspace, 120_000, signal);
  if (!path.isAbsolute(state.workspace) || normalizedPath(baseline.root) !== normalizedPath(state.workspace)) {
    throw new AppError('WORKSPACE_MISMATCH', 'La ejecucion debe reanudarse desde su workspace original.');
  }
  state.verifyCommands = validateVerificationCommands(options.verifyCommands ?? []);
  state.dangerFullAccess = options.dangerFullAccess === true;
  state.network = options.network === true || state.dangerFullAccess;
  const lock = await acquireWorkspaceLock(state.workspace, state.runId);
  let client: CodexDesktopClient | null = null;
  let finalState: RunState | null = null;
  let runError: unknown = null;
  try {
    ({ client } = await openClient(state.workspace, options.binary, logger));
    finalState = await supervise(client, state, logger, { resume: true, signal });
    notify(hooks, finalState, logger);
  } catch (error) {
    runError = error;
    state.status = 'failed';
    state.completedAt = new Date().toISOString();
    state.lastError = sanitizeLog(errorMessage(error), 4000);
    await saveRun(state).catch(() => undefined);
    notify(hooks, state, logger);
    throw error;
  } finally {
    await cleanupManagedRun({ client, hooks, lock, logger, runError, state });
  }
  return finalState!;
}

export async function listDesktopThreads(
  workspace: string | null,
  limit: number,
  explicitBinary: string | null,
  logger: Logger,
): Promise<ThreadInfo[]> {
  const cwd = path.resolve(workspace ?? os.homedir());
  const { client } = await openClient(cwd, explicitBinary, logger);
  try {
    return await client.listThreads(workspace ? cwd : undefined, positiveNumber(limit, 50, 'limit', true, 100));
  } finally {
    await client.close();
  }
}

export async function doctorDesktop(
  workspace: string | null,
  explicitBinary: string | null,
  logger: Logger,
): Promise<DoctorResult> {
  const cwd = path.resolve(workspace ?? os.homedir());
  const { binary, client } = await openClient(cwd, explicitBinary, logger, false);
  try {
    const account = await client.account();
    const threads = await client.listThreads(undefined, 1);
    const ok = account.account?.type === 'chatgpt';
    return {
      ok,
      binary,
      authentication: account.account?.type ?? null,
      planType: account.account?.planType ?? null,
      desktopThreadsVisible: threads.length > 0,
      dataDirectory: path.join(process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(os.homedir(), '.codex'), 'infinite-agent'),
    };
  } finally {
    await client.close();
  }
}
