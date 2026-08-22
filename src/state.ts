import { randomUUID, createHash } from 'node:crypto';
import { appendFile, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppError } from './errors.js';
import type { AgentDecision } from './decision.js';
import type { GitBaseline } from './git.js';
import { sanitizeLog } from './log.js';

export type RunStatus = 'initializing' | 'running' | 'verifying' | 'paused' | 'blocked' | 'budgetLimited' | 'completed' | 'failed';

export interface VerificationRecord {
  ok: boolean;
  checkedAt: string;
  summary: string[];
}

export interface RunState {
  schemaVersion: 1;
  runId: string;
  threadId: string | null;
  activeTurnId: string | null;
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
  network: boolean;
  dangerFullAccess: boolean;
  verifyCommands: string[];
  model: string | null;
  effort: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'ultra' | null;
  gitBaseline: GitBaseline;
  gitFinal: GitBaseline | null;
  lastDecision: AgentDecision | null;
  lastVerification: VerificationRecord | null;
  lastError: string | null;
}

interface LockPayload {
  token: string;
  pid: number;
  runId: string;
  workspace: string;
  createdAt: string;
}

export interface WorkspaceLock {
  path: string;
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
  if (!/^[0-9a-f-]{36}$/i.test(runId)) throw new AppError('INVALID_RUN_ID', 'Run ID invalido.');
  return path.join(runsRoot(), `${runId}.json`);
}

async function ensureDataDirs(): Promise<void> {
  await mkdir(runsRoot(), { recursive: true, mode: 0o700 });
  await mkdir(path.join(dataRoot(), 'locks'), { recursive: true, mode: 0o700 });
}

function validateState(value: unknown): asserts value is RunState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new AppError('INVALID_STATE', 'Estado de ejecucion invalido.');
  const item = value as Record<string, unknown>;
  if (item.schemaVersion !== 1 || typeof item.runId !== 'string' || typeof item.workspace !== 'string'
    || typeof item.objective !== 'string' || typeof item.status !== 'string' || typeof item.turnCount !== 'number') {
    throw new AppError('INVALID_STATE', 'Estado de ejecucion incompatible o corrupto.');
  }
}

export function createRunState(input: Omit<RunState, 'schemaVersion' | 'runId' | 'threadId' | 'activeTurnId' | 'status' | 'createdAt' | 'updatedAt' | 'startedAt' | 'completedAt' | 'turnCount' | 'totalTokens' | 'gitFinal' | 'lastDecision' | 'lastVerification' | 'lastError'>): RunState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    runId: randomUUID(),
    threadId: null,
    activeTurnId: null,
    status: 'initializing',
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    completedAt: null,
    turnCount: 0,
    totalTokens: 0,
    gitFinal: null,
    lastDecision: null,
    lastVerification: null,
    lastError: null,
    ...input,
  };
}

export async function saveRun(state: RunState): Promise<void> {
  await ensureDataDirs();
  state.updatedAt = new Date().toISOString();
  const target = runPath(state.runId);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
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
  const common = { timestamp: new Date().toISOString(), runId, event };
  let line = JSON.stringify({ ...common, ...details });
  if (line.length > 32 * 1024) line = JSON.stringify({ ...common, detailsTruncated: true });
  await appendFile(path.join(runsRoot(), `${runId}.jsonl`), `${line}\n`, { encoding: 'utf8', mode: 0o600 });
}

function processExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function acquireWorkspaceLock(workspace: string, runId: string): Promise<WorkspaceLock> {
  await ensureDataDirs();
  const hash = createHash('sha256').update(process.platform === 'win32' ? workspace.toLowerCase() : workspace).digest('hex');
  const lockPath = path.join(dataRoot(), 'locks', `${hash}.lock`);
  const payload: LockPayload = { token: randomUUID(), pid: process.pid, runId, workspace, createdAt: new Date().toISOString() };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(payload)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      return {
        path: lockPath,
        release: async () => {
          try {
            const current = JSON.parse(await readFile(lockPath, 'utf8')) as Partial<LockPayload>;
            if (current.token === payload.token) await unlink(lockPath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let existing: Partial<LockPayload> = {};
      try {
        existing = JSON.parse(await readFile(lockPath, 'utf8')) as Partial<LockPayload>;
      } catch {
        throw new AppError('WORKSPACE_LOCKED', `El workspace tiene un lock ilegible: ${lockPath}`);
      }
      if (typeof existing.pid === 'number' && processExists(existing.pid)) {
        throw new AppError('WORKSPACE_LOCKED', sanitizeLog(`El workspace ya esta supervisado por PID ${existing.pid} (run ${String(existing.runId ?? 'desconocido')}).`));
      }
      await unlink(lockPath);
    }
  }
  throw new AppError('WORKSPACE_LOCKED', 'No se pudo adquirir el lock exclusivo del workspace.');
}
