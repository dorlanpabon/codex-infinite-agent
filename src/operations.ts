import os from 'node:os';
import path from 'node:path';
import { CodexDesktopClient, type GoalInfo, type ModelInfo, type RecentMessage, type ThreadInfo } from './app-server/client.js';
import { discoverCodexBinary, type BinaryInfo } from './app-server/binary.js';
import { JsonRpcProcess } from './app-server/rpc.js';
import { validateAttachmentPaths } from './attachments.js';
import { AppError, errorMessage } from './errors.js';
import { resolveGitWorkspace } from './git.js';
import { sanitizeLog, type Logger } from './log.js';
import {
  acquireWorkspaceLock,
  createRunState,
  loadRun,
  listRuns,
  saveRun,
  type RunState,
  type WorkspaceLock,
} from './state.js';
import { supervise } from './supervisor.js';
import type { DesktopSessionInfo } from './desktop/contracts.js';

const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

export { validateAttachmentPaths } from './attachments.js';

export interface StartGoalOptions {
  objective: string;
  attachments?: string[];
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

export interface AttachGoalOptions extends StartGoalOptions {
  threadId: string;
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

function attachableThread(thread: ThreadInfo): boolean {
  return !thread.ephemeral && typeof thread.source === 'string'
    && new Set(['cli', 'vscode', 'appServer', 'codex_desktop_infinite_agent']).has(thread.source);
}

function attachableGoal(goal: GoalInfo | null): goal is GoalInfo & { status: 'paused' } {
  return goal !== null && goal.status === 'paused';
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
  if (!objective) throw new AppError('INVALID_OBJECTIVE', 'El objetivo no puede estar vacio.');
  if (options.model && options.model.length > 256) throw new AppError('INVALID_ARGUMENT', 'El modelo no puede exceder 256 caracteres.');
  if (options.effort && !EFFORTS.has(options.effort)) throw new AppError('INVALID_ARGUMENT', 'Nivel de esfuerzo invalido.');
  const baseline = await resolveGitWorkspace(options.directory, 120_000, signal);
  const dangerFullAccess = options.dangerFullAccess === true;
  const name = options.name?.trim() || `Infinite: ${objective.replace(/\s+/g, ' ').slice(0, 72)}`;
  if (name.length > 128) throw new AppError('INVALID_ARGUMENT', 'El nombre no puede exceder 128 caracteres.');
  const tokenBudget = options.tokenBudget ?? null;
  const attachments = await validateAttachmentPaths(options.attachments ?? []);
  if (tokenBudget !== null) positiveNumber(tokenBudget, 0, 'tokenBudget', true, 2_000_000_000);
  const state = createRunState({
    workspace: baseline.root,
    objective,
    attachments,
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

export async function attachGoal(
  options: AttachGoalOptions,
  signal: AbortSignal,
  logger: Logger,
  hooks?: OperationHooks,
): Promise<RunState> {
  const requestedObjective = options.objective.trim();
  if (!requestedObjective) throw new AppError('INVALID_OBJECTIVE', 'El objetivo no puede estar vacio.');
  if (!options.threadId || options.threadId.length > 128) throw new AppError('INVALID_ARGUMENT', 'Thread ID invalido.');
  if (options.model && options.model.length > 256) throw new AppError('INVALID_ARGUMENT', 'El modelo no puede exceder 256 caracteres.');
  if (options.effort && !EFFORTS.has(options.effort)) throw new AppError('INVALID_ARGUMENT', 'Nivel de esfuerzo invalido.');

  const requestedWorkspace = path.resolve(options.directory);
  const { client } = await openClient(requestedWorkspace, options.binary, logger);
  let state: RunState | null = null;
  let lock: WorkspaceLock | null = null;
  let finalState: RunState | null = null;
  let runError: unknown = null;
  let supervisionStarted = false;
  try {
    const thread = await client.readThread(options.threadId);
    if (!attachableThread(thread)) throw new AppError('THREAD_NOT_ATTACHABLE', 'Esta sesion no es un thread interactivo persistido que pueda administrarse.');
    if (normalizedPath(thread.cwd) !== normalizedPath(requestedWorkspace)) {
      throw new AppError('WORKSPACE_MISMATCH', 'La sesion pertenece a otro workspace.');
    }
    if ((await listRuns()).some((run) => run.threadId === thread.id)) {
      throw new AppError('RUN_ALREADY_EXISTS', 'Esta sesion ya tiene una ejecucion local; reanudala desde su historial.');
    }

    const remoteGoal = await client.getGoal(thread.id);
    if (remoteGoal !== null && !attachableGoal(remoteGoal)) {
      throw new AppError(
        'GOAL_NOT_ATTACHABLE',
        `El Goal remoto esta ${remoteGoal.status} y no se reemplazara.`,
      );
    }
    const baseline = await resolveGitWorkspace(thread.cwd, 120_000, signal);
    const initialTurns = await client.listRecentTurns(thread.id, 1);
    const dangerFullAccess = options.dangerFullAccess === true;
    const objective = remoteGoal?.objective ?? requestedObjective;
    const attachments = remoteGoal ? [] : await validateAttachmentPaths(options.attachments ?? []);
    const name = options.name?.trim() || thread.name?.trim() || `Infinite: ${objective.replace(/\s+/g, ' ').slice(0, 72)}`;
    if (name.length > 128) throw new AppError('INVALID_ARGUMENT', 'El nombre no puede exceder 128 caracteres.');
    const requestedTurns = positiveNumber(options.maxTurns, 30, 'maxTurns', true, 1000);
    const requestedTokenBudget = remoteGoal?.tokenBudget ?? options.tokenBudget ?? null;
    if (requestedTokenBudget !== null) positiveNumber(requestedTokenBudget, 0, 'tokenBudget', true, 2_000_000_000);

    state = createRunState({
      workspace: baseline.root,
      objective,
      attachments,
      name,
      maxTurns: requestedTurns,
      turnTimeoutMs: positiveNumber(options.turnMinutes, 45, 'turnMinutes', false, 1440) * 60_000,
      maxWallTimeMs: positiveNumber(options.maxHours, 8, 'maxHours', false, 720) * 60 * 60_000,
      tokenBudget: requestedTokenBudget,
      network: options.network === true || dangerFullAccess,
      dangerFullAccess,
      verifyCommands: validateVerificationCommands(options.verifyCommands ?? []),
      model: options.model ?? null,
      effort: options.effort ?? null,
      gitBaseline: baseline,
    });
    state.threadId = thread.id;
    state.turnBaselineId = initialTurns.at(-1)?.turnId ?? null;
    state.nativeGoalStatus = remoteGoal?.status ?? null;
    state.nativeGoalCreatedAt = remoteGoal?.createdAt ?? null;
    state.goalTokenBudget = remoteGoal?.tokenBudget ?? requestedTokenBudget;
    state.totalTokens = remoteGoal?.tokensUsed ?? 0;
    lock = await acquireWorkspaceLock(state.workspace, state.runId);
    await saveRun(state);
    notify(hooks, state, logger);

    const resumed = await client.resumeThread(thread.id, state.workspace, state.model ?? undefined);
    if (resumed.status.type === 'active') {
      logger.info('La sesion tiene un turno activo; el modo continuo esperara su finalizacion sin enviar mensajes.');
      await client.waitForThreadIdle(
        thread.id,
        Math.max(1, state.maxWallTimeMs - (Date.now() - Date.parse(state.startedAt))),
        signal,
      );
    } else if (resumed.status.type !== 'idle') {
      throw new AppError('REMOTE_STATE_UNCERTAIN', 'La sesion no alcanzo un estado seguro para activar el modo continuo.');
    }
    if (signal.aborted) throw new AppError('INTERRUPTED', 'Activacion interrumpida antes de modificar el Goal.', 130);

    const currentGoal = await client.getGoal(thread.id);
    const goalChanged = remoteGoal
      ? !currentGoal || currentGoal.createdAt !== remoteGoal.createdAt
        || currentGoal.objective !== remoteGoal.objective || currentGoal.status !== 'paused'
      : currentGoal !== null;
    if (goalChanged) {
      throw new AppError('GOAL_OWNERSHIP_MISMATCH', 'El Goal cambio mientras se esperaba el turno activo; no se modificara.');
    }

    const priorTurns = await client.listRecentTurns(thread.id, 1);
    state.turnBaselineId = priorTurns.at(-1)?.turnId ?? null;

    await saveRun(state);
    notify(hooks, state, logger);
    supervisionStarted = true;
    finalState = await supervise(client, state, logger, {
      resume: true,
      adopting: true,
      adoptingGoalMissing: remoteGoal === null,
      signal,
    });
    notify(hooks, finalState, logger);
  } catch (error) {
    runError = error;
    if (!supervisionStarted) client.releaseThreadOwnership(options.threadId);
    if (state) {
      state.status = signal.aborted ? 'paused' : 'failed';
      state.completedAt = signal.aborted ? null : new Date().toISOString();
      state.lastError = sanitizeLog(errorMessage(error), 4000);
      await saveRun(state).catch(() => undefined);
      notify(hooks, state, logger);
    }
    if (signal.aborted && state) return state;
    throw error;
  } finally {
    if (state && lock) await cleanupManagedRun({ client, hooks, lock, logger, runError, state });
    else await client.close().catch(() => undefined);
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

export async function listDesktopModels(
  workspace: string | null,
  explicitBinary: string | null,
  logger: Logger,
): Promise<ModelInfo[]> {
  const cwd = path.resolve(workspace ?? os.homedir());
  const { client } = await openClient(cwd, explicitBinary, logger);
  try {
    return await client.listModels();
  } finally {
    await client.close();
  }
}

export async function listRecentDesktopMessages(
  workspace: string | null,
  threadId: string,
  explicitBinary: string | null,
  logger: Logger,
): Promise<RecentMessage[]> {
  const cwd = path.resolve(workspace ?? os.homedir());
  const { client } = await openClient(cwd, explicitBinary, logger);
  try {
    return await client.listRecentMessages(threadId, 10);
  } finally {
    await client.close();
  }
}

export async function listDesktopSessions(
  workspace: string | null,
  limit: number,
  explicitBinary: string | null,
  logger: Logger,
  activeRunIds: ReadonlySet<string> = new Set(),
): Promise<DesktopSessionInfo[]> {
  const cwd = path.resolve(workspace ?? os.homedir());
  const { client } = await openClient(cwd, explicitBinary, logger);
  try {
    const [threads, runs] = await Promise.all([
      client.listThreads(workspace ? cwd : undefined, positiveNumber(limit, 50, 'limit', true, 100)),
      listRuns(),
    ]);
    const runByThread = new Map(runs.filter((run) => run.threadId).map((run) => [run.threadId!, run]));
    const activeWorkspace = new Map(runs
      .filter((run) => activeRunIds.has(run.runId))
      .map((run) => [normalizedPath(run.workspace), run.runId]));

    return await Promise.all(threads.map((thread) => describeDesktopSession(
      client,
      thread,
      runByThread,
      activeWorkspace,
      activeRunIds,
    )));
  } finally {
    await client.close();
  }
}

async function describeDesktopSession(
  client: CodexDesktopClient,
  thread: ThreadInfo,
  runByThread: ReadonlyMap<string, RunState>,
  activeWorkspace: ReadonlyMap<string, string>,
  activeRunIds: ReadonlySet<string>,
): Promise<DesktopSessionInfo> {
  let goal: GoalInfo | null = null;
  let goalError: string | null = null;
  try {
    goal = await client.getGoal(thread.id);
  } catch (error) {
    goalError = sanitizeLog(errorMessage(error), 1000);
  }
  const localRun = runByThread.get(thread.id) ?? null;
  const operationActive = localRun !== null && activeRunIds.has(localRun.runId);
  const workspaceOwner = activeWorkspace.get(normalizedPath(thread.cwd));
  let unavailableReason: string | null = null;
  if (goalError) unavailableReason = 'No se pudo confirmar el Goal remoto.';
  else if (!attachableThread(thread)) unavailableReason = 'Solo se pueden administrar sesiones interactivas persistidas.';
  else if (workspaceOwner && workspaceOwner !== localRun?.runId) unavailableReason = 'Otro objetivo ya administra este workspace.';
  else if (!localRun && goal !== null && !attachableGoal(goal)) {
    unavailableReason = goal.status === 'active'
      ? 'Este Goal esta activo fuera de esta instancia.'
      : `El Goal remoto esta ${goal.status}.`;
  } else if (localRun?.status === 'completed') unavailableReason = 'La ejecucion local ya esta completa.';
  else if (localRun?.status === 'budgetLimited') unavailableReason = 'La ejecucion alcanzo su limite y no puede reanudarse.';

  const canDisable = operationActive;
  const canEnable = !operationActive && unavailableReason === null
    && (localRun !== null || goal === null || attachableGoal(goal));
  return { thread, goal, goalError, localRun, operationActive, canEnable, canDisable, unavailableReason };
}

export async function getDesktopSession(
  workspace: string | null,
  threadId: string,
  explicitBinary: string | null,
  logger: Logger,
  activeRunIds: ReadonlySet<string> = new Set(),
): Promise<DesktopSessionInfo> {
  const cwd = path.resolve(workspace ?? os.homedir());
  const { client } = await openClient(cwd, explicitBinary, logger);
  try {
    const [thread, runs] = await Promise.all([client.readThread(threadId), listRuns()]);
    const runByThread = new Map(runs.filter((run) => run.threadId).map((run) => [run.threadId!, run]));
    const activeWorkspace = new Map(runs
      .filter((run) => activeRunIds.has(run.runId))
      .map((run) => [normalizedPath(run.workspace), run.runId]));
    return await describeDesktopSession(client, thread, runByThread, activeWorkspace, activeRunIds);
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
