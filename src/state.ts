import { randomUUID, createHash } from 'node:crypto';
import { appendFile, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { GoalStatus, TurnStatus } from './app-server/client.js';
import { AppError } from './errors.js';
import type { GitBaseline } from './git.js';
import { sanitizeLog } from './log.js';

const WINDOWS_GUARD_DRAIN_GRACE_MS = 8500;

export function staleWorkspaceLockMustQuarantine(platform: NodeJS.Platform): boolean {
  return platform !== 'win32';
}

export type RunStatus = 'initializing' | 'running' | 'verifying' | 'paused' | 'blocked' | 'budgetLimited' | 'completed' | 'failed';

export interface VerificationRecord {
  ok: boolean;
  checkedAt: string;
  summary: string[];
}

export interface NativeTurnRecord {
  turnId: string;
  status: TurnStatus;
  error: string | null;
  failedItems: string[];
  blockedReason: string | null;
}

export interface BlockingEvidence {
  turnId: string;
  reason: string;
  recordedAt: string;
}

export interface RunState {
  schemaVersion: 2;
  runId: string;
  threadId: string | null;
  activeTurnId: string | null;
  goalActivationPending: boolean;
  nativeGoalStatus: GoalStatus | null;
  nativeGoalCreatedAt: number | null;
  goalTokenBudget: number | null;
  observedTurnIds: string[];
  acknowledgedBlockingTurnIds: string[];
  workspace: string;
  objective: string;
  name: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string;
  completedAt: string | null;
  turnCount: number;
  maxTurns: number;
  turnTimeoutMs: number;
  maxWallTimeMs: number;
  tokenBudget: number | null;
  totalTokens: number;
  verificationAttempts: number;
  network: boolean;
  dangerFullAccess: boolean;
  verifyCommands: string[];
  model: string | null;
  effort: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'ultra' | null;
  gitBaseline: GitBaseline;
  gitFinal: GitBaseline | null;
  lastTurn: NativeTurnRecord | null;
  blockingEvidence: BlockingEvidence | null;
  lastVerification: VerificationRecord | null;
  lastError: string | null;
}

interface LockPayload {
  token: string;
  pid: number;
  runId: string;
  workspace: string;
  createdAt: string;
  quarantined?: boolean;
  reason?: string;
}

export interface WorkspaceLock {
  path: string;
  quarantine(reason: string): Promise<void>;
  release(): Promise<void>;
}

function dataRoot(): string {
  const codexHome = process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(os.homedir(), '.codex');
  return path.join(codexHome, 'infinite-agent');
}

function runsRoot(): string {
  return path.join(dataRoot(), 'runs');
}

function runPath(runId: string): string {
  if (!validRunId(runId)) {
    throw new AppError('INVALID_RUN_ID', 'Run ID invalido.');
  }
  return path.join(runsRoot(), `${runId}.json`);
}

function validRunId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function ensureDataDirs(): Promise<void> {
  await mkdir(runsRoot(), { recursive: true, mode: 0o700 });
  await mkdir(path.join(dataRoot(), 'locks'), { recursive: true, mode: 0o700 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown, maxLength: number): boolean {
  return value === null || (typeof value === 'string' && value.length <= maxLength);
}

function validDate(value: unknown): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validGitBaseline(value: unknown, workspace: string): boolean {
  if (!isRecord(value) || typeof value.root !== 'string' || !path.isAbsolute(value.root)
    || !nullableString(value.branch, 500) || !nullableString(value.head, 128) || typeof value.dirty !== 'boolean') return false;
  const normalize = (candidate: string) => process.platform === 'win32' ? path.resolve(candidate).toLowerCase() : path.resolve(candidate);
  return normalize(value.root) === normalize(workspace);
}

function validateState(value: unknown): asserts value is RunState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new AppError('INVALID_STATE', 'Estado de ejecucion invalido.');
  const item = value as Record<string, unknown>;
  if (item.blockingEvidence === undefined) {
    item.blockingEvidence = isRecord(item.lastTurn) && typeof item.lastTurn.turnId === 'string'
      && typeof item.lastTurn.blockedReason === 'string' && item.lastTurn.blockedReason.length > 0
      ? { turnId: item.lastTurn.turnId, reason: item.lastTurn.blockedReason, recordedAt: item.updatedAt }
      : null;
  }
  if (item.acknowledgedBlockingTurnIds === undefined) item.acknowledgedBlockingTurnIds = [];
  const statuses = new Set<RunStatus>(['initializing', 'running', 'verifying', 'paused', 'blocked', 'budgetLimited', 'completed', 'failed']);
  const goalStatuses = new Set<GoalStatus>(['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete']);
  const turnStatuses = new Set<TurnStatus>(['completed', 'interrupted', 'failed', 'inProgress']);
  const efforts = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'ultra']);
  const validLastTurn = item.lastTurn === null || (isRecord(item.lastTurn)
    && nullableString(item.lastTurn.turnId, 128) && typeof item.lastTurn.turnId === 'string' && item.lastTurn.turnId.length > 0
    && typeof item.lastTurn.status === 'string' && turnStatuses.has(item.lastTurn.status as TurnStatus)
    && nullableString(item.lastTurn.error, 4000)
    && Array.isArray(item.lastTurn.failedItems) && item.lastTurn.failedItems.length <= 20
    && item.lastTurn.failedItems.every((entry) => typeof entry === 'string' && entry.length <= 1000)
    && nullableString(item.lastTurn.blockedReason, 4000));
  const validVerification = item.lastVerification === null || (isRecord(item.lastVerification)
    && typeof item.lastVerification.ok === 'boolean' && validDate(item.lastVerification.checkedAt)
    && Array.isArray(item.lastVerification.summary) && item.lastVerification.summary.length <= 22
    && item.lastVerification.summary.every((entry) => typeof entry === 'string' && entry.length <= 10_000));
  const validBlockingEvidence = item.blockingEvidence === null || (isRecord(item.blockingEvidence)
    && typeof item.blockingEvidence.turnId === 'string' && item.blockingEvidence.turnId.length > 0 && item.blockingEvidence.turnId.length <= 128
    && typeof item.blockingEvidence.reason === 'string' && item.blockingEvidence.reason.length > 0 && item.blockingEvidence.reason.length <= 4000
    && validDate(item.blockingEvidence.recordedAt));
  const validNumbers = Number.isSafeInteger(item.turnCount) && (item.turnCount as number) >= 0
    && Number.isSafeInteger(item.maxTurns) && (item.maxTurns as number) > 0 && (item.maxTurns as number) <= 1000
    && typeof item.turnTimeoutMs === 'number' && item.turnTimeoutMs > 0 && item.turnTimeoutMs <= 24 * 60 * 60_000
    && typeof item.maxWallTimeMs === 'number' && item.maxWallTimeMs > 0 && item.maxWallTimeMs <= 720 * 60 * 60_000
    && Number.isSafeInteger(item.totalTokens) && (item.totalTokens as number) >= 0
    && Number.isSafeInteger(item.verificationAttempts) && (item.verificationAttempts as number) >= 0 && (item.verificationAttempts as number) <= 1000
    && (item.tokenBudget === null || (Number.isSafeInteger(item.tokenBudget) && (item.tokenBudget as number) > 0 && (item.tokenBudget as number) <= 2_000_000_000));
  const terminalStatus = item.status === 'completed' || item.status === 'blocked'
    || item.status === 'budgetLimited' || item.status === 'failed';
  const completedAtConsistent = terminalStatus ? validDate(item.completedAt) : item.completedAt === null;
  const completionConsistent = item.status !== 'completed' || (
    item.nativeGoalStatus === 'complete'
    && typeof item.nativeGoalCreatedAt === 'number'
    && item.activeTurnId === null
    && item.goalActivationPending === false
    && item.blockingEvidence === null
    && isRecord(item.lastTurn) && item.lastTurn.status === 'completed'
    && item.lastTurn.error === null && item.lastTurn.blockedReason === null
    && Array.isArray(item.observedTurnIds) && item.observedTurnIds.includes(item.lastTurn.turnId)
    && isRecord(item.lastVerification) && item.lastVerification.ok === true
    && item.gitFinal !== null
  );
  const workspace = typeof item.workspace === 'string' ? item.workspace : '';
  if (item.schemaVersion !== 2 || !validRunId(item.runId) || !path.isAbsolute(workspace)
    || typeof item.objective !== 'string' || item.objective.length < 1 || item.objective.length > 4000
    || typeof item.name !== 'string' || item.name.length < 1 || item.name.length > 128
    || typeof item.status !== 'string' || !statuses.has(item.status as RunStatus)
    || !nullableString(item.threadId, 128) || !nullableString(item.activeTurnId, 128)
    || typeof item.goalActivationPending !== 'boolean'
    || !(item.nativeGoalStatus === null || (typeof item.nativeGoalStatus === 'string' && goalStatuses.has(item.nativeGoalStatus as GoalStatus)))
    || !(item.nativeGoalCreatedAt === null || (Number.isFinite(item.nativeGoalCreatedAt) && (item.nativeGoalCreatedAt as number) >= 0))
    || !(item.goalTokenBudget === null || (Number.isSafeInteger(item.goalTokenBudget) && (item.goalTokenBudget as number) > 0 && (item.goalTokenBudget as number) <= 2_000_000_000))
    || !Array.isArray(item.observedTurnIds) || item.observedTurnIds.length > 1000
    || !item.observedTurnIds.every((entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= 128)
    || new Set(item.observedTurnIds).size !== item.observedTurnIds.length
    || !Array.isArray(item.acknowledgedBlockingTurnIds) || item.acknowledgedBlockingTurnIds.length > 1000
    || !item.acknowledgedBlockingTurnIds.every((entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= 128)
    || new Set(item.acknowledgedBlockingTurnIds).size !== item.acknowledgedBlockingTurnIds.length
    || item.turnCount !== item.observedTurnIds.length
    || !validDate(item.createdAt) || !validDate(item.updatedAt) || !validDate(item.startedAt)
    || !(item.completedAt === null || validDate(item.completedAt)) || !completedAtConsistent || !completionConsistent || !validNumbers
    || typeof item.network !== 'boolean' || typeof item.dangerFullAccess !== 'boolean'
    || !Array.isArray(item.verifyCommands) || item.verifyCommands.length > 20
    || !item.verifyCommands.every((entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= 4000)
    || !(item.model === null || (typeof item.model === 'string' && item.model.length <= 500))
    || !(item.effort === null || (typeof item.effort === 'string' && efforts.has(item.effort)))
    || !validGitBaseline(item.gitBaseline, workspace)
    || !(item.gitFinal === null || validGitBaseline(item.gitFinal, workspace))
    || !validLastTurn || !validBlockingEvidence || !validVerification || !nullableString(item.lastError, 4000)) {
    throw new AppError('INVALID_STATE', 'Estado de ejecucion incompatible o corrupto.');
  }
}

export function createRunState(input: Omit<RunState, 'schemaVersion' | 'runId' | 'threadId' | 'activeTurnId' | 'goalActivationPending' | 'nativeGoalStatus' | 'nativeGoalCreatedAt' | 'goalTokenBudget' | 'observedTurnIds' | 'acknowledgedBlockingTurnIds' | 'status' | 'createdAt' | 'updatedAt' | 'startedAt' | 'completedAt' | 'turnCount' | 'totalTokens' | 'verificationAttempts' | 'gitFinal' | 'lastTurn' | 'blockingEvidence' | 'lastVerification' | 'lastError'>): RunState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 2,
    runId: randomUUID(),
    threadId: null,
    activeTurnId: null,
    goalActivationPending: false,
    nativeGoalStatus: null,
    nativeGoalCreatedAt: null,
    goalTokenBudget: input.tokenBudget,
    observedTurnIds: [],
    acknowledgedBlockingTurnIds: [],
    status: 'initializing',
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    completedAt: null,
    turnCount: 0,
    totalTokens: 0,
    verificationAttempts: 0,
    gitFinal: null,
    lastTurn: null,
    blockingEvidence: null,
    lastVerification: null,
    lastError: null,
    ...input,
  };
}

export async function saveRun(state: RunState): Promise<void> {
  await ensureDataDirs();
  state.updatedAt = new Date().toISOString();
  validateState(state);
  const target = runPath(state.runId);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch((cleanupError) => {
      if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') throw cleanupError;
    });
    throw error;
  }
}

export async function loadRun(runId: string): Promise<RunState> {
  let text: string;
  try {
    text = await readFile(runPath(runId), 'utf8');
  } catch (cause) {
    throw new AppError('RUN_NOT_FOUND', `No se encontro la ejecucion ${runId}.`, 1, { cause });
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new AppError('INVALID_STATE', 'El estado persistido no contiene JSON valido.', 1, { cause });
  }
  validateState(value);
  if (value.runId !== runId) throw new AppError('INVALID_STATE', 'El Run ID persistido no coincide con el archivo solicitado.');
  return value;
}

export async function listRuns(): Promise<RunState[]> {
  await ensureDataDirs();
  const entries = (await readdir(runsRoot())).filter((entry) => /^[0-9a-f-]{36}\.json$/i.test(entry));
  const states = await Promise.all(entries.map(async (entry) => {
    try {
      return await loadRun(entry.slice(0, -5));
    } catch {
      return null;
    }
  }));
  return states.filter((state): state is RunState => state !== null).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function appendRunEvent(runId: string, event: string, details: Record<string, unknown> = {}): Promise<void> {
  await ensureDataDirs();
  runPath(runId);
  const common = { timestamp: new Date().toISOString(), runId, event };
  let line = JSON.stringify({ ...common, ...details });
  if (line.length > 32 * 1024) line = JSON.stringify({ ...common, detailsTruncated: true });
  await appendFile(path.join(runsRoot(), `${runId}.jsonl`), `${line}\n`, { encoding: 'utf8', mode: 0o600 });
}

export async function acquireWorkspaceLock(workspace: string, runId: string): Promise<WorkspaceLock> {
  await ensureDataDirs();
  const hash = createHash('sha256').update(process.platform === 'win32' ? workspace.toLowerCase() : workspace).digest('hex');
  const lockPath = path.join(dataRoot(), 'locks', `${hash}.lock`);
  const payload: LockPayload = { token: randomUUID(), pid: process.pid, runId, workspace, createdAt: new Date().toISOString() };
  const endpoint = process.platform === 'win32'
    ? `\\\\.\\pipe\\codex-infinite-agent-${hash}`
    : { host: '127.0.0.1', port: 20_000 + (Number.parseInt(hash.slice(0, 8), 16) % 40_000), exclusive: true };
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off('listening', onListening);
      reject(error.code === 'EADDRINUSE'
        ? new AppError('WORKSPACE_LOCKED', 'El workspace ya esta supervisado por otro proceso.')
        : error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(endpoint);
  });

  const closeServer = async (): Promise<void> => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  const writePayload = async (value: LockPayload): Promise<void> => {
    const temporary = `${lockPath}.${payload.token}.tmp`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, lockPath);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  };

  let staleOwnerMetadata = false;
  try {
    const existing = JSON.parse(await readFile(lockPath, 'utf8')) as Partial<LockPayload>;
    if (existing.quarantined === true) {
      throw new AppError(
        'WORKSPACE_QUARANTINED',
        sanitizeLog(`El workspace esta en cuarentena por un cierre incierto: ${String(existing.reason ?? lockPath)}`),
      );
    }
    staleOwnerMetadata = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      await closeServer().catch(() => undefined);
      throw error;
    }
  }
  if (staleOwnerMetadata && process.platform === 'win32') {
    await new Promise((resolve) => setTimeout(resolve, WINDOWS_GUARD_DRAIN_GRACE_MS));
  }
  if (staleOwnerMetadata && staleWorkspaceLockMustQuarantine(process.platform)) {
    const reason = 'Metadatos de bloqueo huerfanos: no se puede demostrar que el grupo de procesos anterior termino.';
    await writePayload({ ...payload, quarantined: true, reason }).catch(async (error) => {
      await closeServer().catch(() => undefined);
      throw error;
    });
    await closeServer();
    throw new AppError('WORKSPACE_QUARANTINED', sanitizeLog(`El workspace esta en cuarentena: ${reason}`));
  }
  await writePayload(payload).catch(async (error) => {
    await closeServer().catch(() => undefined);
    throw error;
  });

  let preserveMetadata = false;
  let held = true;
  return {
    path: lockPath,
    quarantine: async (reason: string) => {
      preserveMetadata = true;
      await writePayload({ ...payload, quarantined: true, reason: sanitizeLog(reason, 2000) });
    },
    release: async () => {
      if (held) {
        held = false;
        await closeServer();
      }
      if (preserveMetadata) return;
      try {
        const current = JSON.parse(await readFile(lockPath, 'utf8')) as Partial<LockPayload>;
        if (current.token === payload.token) await unlink(lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    },
  };
}
