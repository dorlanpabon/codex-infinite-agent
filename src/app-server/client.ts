import type { EventEmitter } from 'node:events';
import { AppError, errorMessage } from '../errors.js';
import type { Logger } from '../log.js';
import type { RpcMessage, ServerRequest } from './rpc.js';

export interface RpcTransport extends Pick<EventEmitter, 'on' | 'off'> {
  request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  respond(id: number | string, result: unknown): void;
  respondError(id: number | string, code: number, message: string): void;
  close(): Promise<void>;
}

export type GoalStatus = 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete';
export type TurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress';
export type ThreadStatus = { type: 'notLoaded' | 'idle' | 'systemError' | 'active'; [key: string]: unknown };

export interface AccountInfo {
  account: null | { type: string; email?: string | null; planType?: string };
  requiresOpenaiAuth: boolean;
}

export interface ModelReasoningEffort {
  reasoningEffort: string;
  description: string | null;
}

export interface ModelInfo {
  id: string;
  model: string;
  displayName: string;
  hidden: boolean;
  defaultReasoningEffort: string | null;
  supportedReasoningEfforts: ModelReasoningEffort[];
  inputModalities: string[];
  supportsPersonality: boolean;
  isDefault: boolean;
}

export interface ThreadInfo {
  id: string;
  preview: string;
  name: string | null;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  status: ThreadStatus;
  source: unknown;
  ephemeral: boolean;
}

export interface GoalInfo {
  threadId: string;
  objective: string;
  status: GoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

export interface ThreadSettings {
  threadId: string;
  workspace: string;
  network: boolean;
  dangerFullAccess: boolean;
  model?: string;
  effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
}

export interface TurnResult {
  threadId: string;
  turnId: string;
  status: TurnStatus;
  finalText: string | null;
  totalTokens: number;
  error: string | null;
  failedItems: string[];
  blockedReason: string | null;
}

export type GoalStopReason = 'signal' | 'wall_timeout' | 'turn_timeout' | 'max_turns' | 'interaction_required' | null;

const STOP_REASON_PRIORITY: Record<Exclude<GoalStopReason, null>, number> = {
  signal: 1,
  max_turns: 2,
  wall_timeout: 3,
  turn_timeout: 4,
  interaction_required: 5,
};

function strongerStopReason(
  current: GoalStopReason,
  candidate: Exclude<GoalStopReason, null>,
): Exclude<GoalStopReason, null> {
  return current === null || STOP_REASON_PRIORITY[candidate] > STOP_REASON_PRIORITY[current] ? candidate : current;
}

export interface NativeGoalOptions {
  threadId: string;
  objective?: string;
  existingTurnId?: string;
  tokenBudget?: number;
  timeoutMs: number;
  turnTimeoutMs: number;
  maxTurns: number;
  signal: AbortSignal;
  onActivationAttempt?(): void;
  onActivated?(goal: GoalInfo): Promise<void> | void;
  onGoalUpdated?(goal: GoalInfo): Promise<void> | void;
  onTurnStarted?(turnId: string): Promise<void> | void;
  onBlockedEvidence?(reason: string, turnId: string): Promise<void> | void;
  onTurnCompleted?(turn: TurnResult): Promise<void> | void;
}

export interface NativeGoalResult {
  goal: GoalInfo;
  lastTurn: TurnResult | null;
  turnsStarted: number;
  activeTurnId: string | null;
  stopReason: GoalStopReason;
}

export interface PersistedTurn {
  turnId: string;
  status: TurnStatus;
  finalText: string | null;
  error: string | null;
  blockedReason: string | null;
}

const ALL_THREAD_SOURCE_KINDS = [
  'cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview',
  'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown',
] as const;

interface TurnWire {
  id?: unknown;
  status?: unknown;
  error?: unknown;
  items?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const GOAL_STATUSES = new Set<GoalStatus>(['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete']);

function recordGoal(value: unknown): GoalInfo {
  if (!isRecord(value) || typeof value.threadId !== 'string' || typeof value.objective !== 'string'
    || typeof value.status !== 'string' || !GOAL_STATUSES.has(value.status as GoalStatus)
    || !(value.tokenBudget === null || (Number.isSafeInteger(value.tokenBudget) && (value.tokenBudget as number) > 0))
    || !Number.isSafeInteger(value.tokensUsed) || (value.tokensUsed as number) < 0
    || typeof value.timeUsedSeconds !== 'number' || value.timeUsedSeconds < 0
    || typeof value.createdAt !== 'number' || typeof value.updatedAt !== 'number') {
    throw new AppError('INVALID_APP_SERVER_RESPONSE', 'App Server devolvio un Goal invalido.');
  }
  return value as unknown as GoalInfo;
}

function recordTurnStatus(value: unknown): TurnStatus {
  if (value !== 'completed' && value !== 'interrupted' && value !== 'failed' && value !== 'inProgress') {
    throw new AppError('INVALID_APP_SERVER_RESPONSE', 'Estado de turno invalido.');
  }
  return value;
}

function collectTurnItems(items: unknown, failedItems: Set<string>): string | null {
  let finalText: string | null = null;
  if (!Array.isArray(items)) return finalText;
  for (const item of items) {
    if (!isRecord(item)) continue;
    if (item.type === 'agentMessage' && typeof item.text === 'string'
      && (item.phase === 'final_answer' || finalText === null)) finalText = item.text.slice(0, 100_000);
    if (item.status !== 'failed') continue;
    if (item.type === 'commandExecution') {
      failedItems.add(`command:${typeof item.command === 'string' ? item.command.slice(0, 900) : 'unknown'}`);
    } else if (item.type === 'fileChange' || item.type === 'mcpToolCall') {
      failedItems.add(String(item.type));
    }
  }
  return finalText;
}

function durableBlockedReason(items: unknown): string | null {
  if (!Array.isArray(items)) return null;
  for (const item of items) {
    if (!isRecord(item) || item.status !== 'declined') continue;
    if (item.type === 'commandExecution' || item.type === 'fileChange') {
      return `approval_declined:${item.type}`;
    }
  }
  return null;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AppError('INVALID_APP_SERVER_RESPONSE', `App Server devolvio ${label} invalido.`);
  }
  return value;
}

function boundedWireString(value: unknown, label: string, maximum: number): string {
  const parsed = requiredString(value, label);
  if (parsed.length > maximum || /[\x00-\x1f\x7f]/u.test(parsed)) {
    throw new AppError('INVALID_APP_SERVER_RESPONSE', `App Server devolvio ${label} invalido.`);
  }
  return parsed;
}

function recordModel(value: unknown): ModelInfo {
  if (!isRecord(value)) throw new AppError('INVALID_APP_SERVER_RESPONSE', 'App Server devolvio un modelo invalido.');
  const id = boundedWireString(value.id, 'model.id', 256);
  const model = typeof value.model === 'string' ? boundedWireString(value.model, 'model.model', 256) : id;
  const displayName = typeof value.displayName === 'string'
    ? boundedWireString(value.displayName, 'model.displayName', 256)
    : model;
  if (value.defaultReasoningEffort !== null && value.defaultReasoningEffort !== undefined
    && typeof value.defaultReasoningEffort !== 'string') {
    throw new AppError('INVALID_APP_SERVER_RESPONSE', 'App Server devolvio model.defaultReasoningEffort invalido.');
  }
  const defaultReasoningEffort = typeof value.defaultReasoningEffort === 'string'
    ? boundedWireString(value.defaultReasoningEffort, 'model.defaultReasoningEffort', 64)
    : null;
  if (value.supportedReasoningEfforts !== undefined && !Array.isArray(value.supportedReasoningEfforts)) {
    throw new AppError('INVALID_APP_SERVER_RESPONSE', 'App Server devolvio model.supportedReasoningEfforts invalido.');
  }
  const supportedReasoningEfforts = (value.supportedReasoningEfforts ?? []).map((entry: unknown): ModelReasoningEffort => {
    if (!isRecord(entry)) throw new AppError('INVALID_APP_SERVER_RESPONSE', 'App Server devolvio un esfuerzo de modelo invalido.');
    return {
      reasoningEffort: boundedWireString(entry.reasoningEffort, 'model.reasoningEffort', 64),
      description: typeof entry.description === 'string'
        ? boundedWireString(entry.description, 'model.reasoningEffort.description', 1000)
        : null,
    };
  });
  if (supportedReasoningEfforts.length > 32) {
    throw new AppError('INVALID_APP_SERVER_RESPONSE', 'App Server devolvio demasiados esfuerzos para un modelo.');
  }
  if (value.inputModalities !== undefined && (!Array.isArray(value.inputModalities)
    || value.inputModalities.length > 16 || !value.inputModalities.every((entry) => typeof entry === 'string'))) {
    throw new AppError('INVALID_APP_SERVER_RESPONSE', 'App Server devolvio model.inputModalities invalido.');
  }
  const inputModalities = (value.inputModalities ?? ['text', 'image'])
    .map((entry: unknown) => boundedWireString(entry, 'model.inputModalities', 64));
  return {
    id,
    model,
    displayName,
    hidden: value.hidden === true,
    defaultReasoningEffort,
    supportedReasoningEfforts,
    inputModalities,
    supportsPersonality: value.supportsPersonality === true,
    isDefault: value.isDefault === true,
  };
}

function recordThread(value: unknown): ThreadInfo {
  if (!isRecord(value)) throw new AppError('INVALID_APP_SERVER_RESPONSE', 'App Server devolvio un thread invalido.');
  if (!isRecord(value.status)
    || (value.status.type !== 'notLoaded' && value.status.type !== 'idle'
      && value.status.type !== 'systemError' && value.status.type !== 'active')) {
    throw new AppError('INVALID_APP_SERVER_RESPONSE', 'App Server devolvio un estado de thread invalido.');
  }
  return {
    id: requiredString(value.id, 'thread.id'),
    preview: typeof value.preview === 'string' ? value.preview : '',
    name: typeof value.name === 'string' ? value.name : null,
    cwd: requiredString(value.cwd, 'thread.cwd'),
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : 0,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
    status: value.status as ThreadStatus,
    source: value.source,
    ephemeral: value.ephemeral === true,
  };
}

function readThreadAndTurn(params: unknown): { threadId?: string; turnId?: string } {
  if (!isRecord(params)) return {};
  const turn = isRecord(params.turn) ? params.turn : undefined;
  return {
    threadId: typeof params.threadId === 'string'
      ? params.threadId
      : typeof params.conversationId === 'string' ? params.conversationId : undefined,
    turnId: typeof params.turnId === 'string'
      ? params.turnId
      : turn && typeof turn.id === 'string' ? turn.id : undefined,
  };
}

function turnError(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.slice(0, 4000);
  if (isRecord(value) && typeof value.message === 'string') return value.message.slice(0, 4000);
  return JSON.stringify(value).slice(0, 2000);
}

export class CodexDesktopClient {
  private ownedThreadId: string | null = null;
  private ownedWorkspace: string | null = null;
  private activeTurnId: string | null = null;
  private interactionReason: string | null = null;
  private blockedEvidenceHandler: ((reason: string, turnId: string) => Promise<void>) | null = null;
  private readonly onServerRequestBound: (request: ServerRequest) => void;

  constructor(private readonly rpc: RpcTransport, private readonly logger: Logger) {
    this.onServerRequestBound = (request) => { this.handleServerRequest(request); };
    this.rpc.on('request', this.onServerRequestBound);
  }

  async close(): Promise<void> {
    const failures: string[] = [];
    if (this.ownedThreadId) {
      try {
        await this.prepareThreadForTerminal(this.ownedThreadId);
      } catch (error) {
        failures.push(`preparacion segura: ${errorMessage(error)}`);
      }
    }
    this.rpc.off('request', this.onServerRequestBound);
    try {
      await this.rpc.close();
    } catch (error) {
      failures.push(`proceso: ${errorMessage(error)}`);
    }
    if (failures.length > 0) {
      throw new AppError('PRIVILEGE_CLEANUP_UNCERTAIN', `No se pudo confirmar el cierre seguro: ${failures.join(' ')}`);
    }
  }

  async account(): Promise<AccountInfo> {
    const response = await this.rpc.request<unknown>('account/read', { refreshToken: false });
    if (!isRecord(response)) throw new AppError('INVALID_APP_SERVER_RESPONSE', 'Respuesta account/read invalida.');
    const account = response.account;
    if (account !== null && !isRecord(account)) throw new AppError('INVALID_APP_SERVER_RESPONSE', 'Cuenta de Codex invalida.');
    return {
      account: account === null ? null : {
        type: requiredString(account.type, 'account.type'),
        ...(typeof account.email === 'string' || account.email === null ? { email: account.email } : {}),
        ...(typeof account.planType === 'string' ? { planType: account.planType } : {}),
      },
      requiresOpenaiAuth: response.requiresOpenaiAuth === true,
    };
  }

  async startThread(workspace: string, model?: string): Promise<ThreadInfo> {
    const response = await this.rpc.request<unknown>('thread/start', {
      cwd: workspace,
      runtimeWorkspaceRoots: [workspace],
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: 'workspace-write',
      ephemeral: false,
      threadSource: 'codex_desktop_infinite_agent',
      ...(model ? { model } : {}),
    });
    if (!isRecord(response)) throw new AppError('INVALID_APP_SERVER_RESPONSE', 'Respuesta thread/start invalida.');
    const thread = recordThread(response.thread);
    this.ownedThreadId = thread.id;
    this.ownedWorkspace = thread.cwd;
    return thread;
  }

  async resumeThread(threadId: string, workspace: string, model?: string): Promise<ThreadInfo> {
    const previousOwnedThreadId = this.ownedThreadId;
    const previousOwnedWorkspace = this.ownedWorkspace;
    this.ownedThreadId = threadId;
    try {
      const response = await this.rpc.request<unknown>('thread/resume', {
        threadId,
        cwd: workspace,
        runtimeWorkspaceRoots: [workspace],
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandbox: 'workspace-write',
        excludeTurns: true,
        ...(model ? { model } : {}),
      }, 60_000);
      if (!isRecord(response)) throw new AppError('INVALID_APP_SERVER_RESPONSE', 'Respuesta thread/resume invalida.');
      const thread = recordThread(response.thread);
      if (thread.id !== threadId) throw new AppError('THREAD_ID_MISMATCH', 'App Server reanudo un thread distinto al solicitado.');
      this.ownedWorkspace = thread.cwd;
      return thread;
    } catch (error) {
      this.ownedThreadId = previousOwnedThreadId;
      this.ownedWorkspace = previousOwnedWorkspace;
      throw error;
    }
  }

  releaseThreadOwnership(threadId: string): void {
    if (this.ownedThreadId !== threadId || this.activeTurnId !== null) return;
    this.ownedThreadId = null;
    this.ownedWorkspace = null;
  }

  async readThread(threadId: string, timeoutMs = 30_000): Promise<ThreadInfo> {
    const response = await this.rpc.request<unknown>('thread/read', { threadId, includeTurns: false }, timeoutMs);
    if (!isRecord(response)) throw new AppError('INVALID_APP_SERVER_RESPONSE', 'Respuesta thread/read invalida.');
    const thread = recordThread(response.thread);
    if (thread.id !== threadId) throw new AppError('THREAD_ID_MISMATCH', 'App Server devolvio un thread distinto al solicitado.');
    return thread;
  }

  async waitForThreadIdle(threadId: string, timeoutMs: number, signal: AbortSignal): Promise<ThreadInfo> {
    if (this.ownedThreadId !== threadId) throw new AppError('THREAD_NOT_OWNED', 'El cliente no posee el thread que debe observar.');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new AppError('INVALID_THREAD_TIMEOUT', 'El limite para esperar el thread debe ser positivo.');
    }
    if (signal.aborted) throw new AppError('INTERRUPTED', 'Espera de thread interrumpida.', 130);

    return new Promise<ThreadInfo>((resolve, reject) => {
      let settled = false;
      let reading = false;
      let inspectAgain = false;
      const finish = (error: unknown, thread?: ThreadInfo): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.rpc.off('notification', listener);
        signal.removeEventListener('abort', abortListener);
        if (error) reject(error);
        else resolve(thread!);
      };
      const inspect = (): void => {
        if (settled) return;
        if (reading) {
          inspectAgain = true;
          return;
        }
        reading = true;
        void this.readThread(threadId, Math.min(30_000, timeoutMs)).then((thread) => {
          reading = false;
          if (thread.status.type === 'idle') finish(null, thread);
          else if (thread.status.type !== 'active') {
            finish(new AppError('REMOTE_STATE_UNCERTAIN', `El thread cambio a ${thread.status.type} mientras esperaba su turno activo.`));
          } else if (inspectAgain) {
            inspectAgain = false;
            inspect();
          }
        }, (error) => finish(error));
      };
      const listener = (message: RpcMessage): void => {
        if (typeof message.method !== 'string' || !isRecord(message.params)) return;
        const ids = readThreadAndTurn(message.params);
        if (ids.threadId !== threadId) return;
        if (message.method === 'turn/completed' || message.method === 'thread/status/changed') inspect();
      };
      const abortListener = (): void => finish(new AppError('INTERRUPTED', 'Espera de thread interrumpida.', 130));
      const timer = setTimeout(() => finish(new AppError(
        'THREAD_IDLE_TIMEOUT',
        'El turno activo no termino dentro del limite configurado; no se activo el modo continuo.',
      )), timeoutMs);
      timer.unref();
      this.rpc.on('notification', listener);
      signal.addEventListener('abort', abortListener, { once: true });
      inspect();
    });
  }

  async readTurn(threadId: string, turnId: string, timeoutMs = 60_000): Promise<PersistedTurn | null> {
    return (await this.listTurns(threadId, 1000, timeoutMs)).find((turn) => turn.turnId === turnId) ?? null;
  }

  async listTurns(threadId: string, maximum = 1000, timeoutMs = 60_000): Promise<PersistedTurn[]> {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1001) {
      throw new AppError('INVALID_TURN_HISTORY_LIMIT', 'El limite de reconciliacion debe estar entre 1 y 1001 turnos.');
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new AppError('INVALID_TURN_HISTORY_TIMEOUT', 'El tiempo de reconciliacion debe ser positivo.');
    }
    const result: PersistedTurn[] = [];
    const deadline = Date.now() + timeoutMs;
    let cursor: string | null = null;
    do {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new AppError('TURN_HISTORY_TIMEOUT', 'Tiempo agotado al reconciliar turnos durables.');
      const response: unknown = await this.rpc.request('thread/turns/list', {
        threadId,
        cursor,
        limit: Math.min(100, maximum - result.length),
        sortDirection: 'asc',
        itemsView: 'full',
      }, Math.min(60_000, remaining));
      if (Date.now() > deadline) throw new AppError('TURN_HISTORY_TIMEOUT', 'Tiempo agotado al reconciliar turnos durables.');
      if (!isRecord(response) || !Array.isArray(response.data)) {
        throw new AppError('INVALID_APP_SERVER_RESPONSE', 'Respuesta thread/turns/list invalida.');
      }
      if (!response.data.every(isRecord)) {
        throw new AppError('INVALID_APP_SERVER_RESPONSE', 'thread/turns/list contiene un turno invalido.');
      }
      result.push(...response.data.map((turn) => this.parsePersistedTurn(turn)));
      if (result.length > maximum) {
        throw new AppError('TURN_HISTORY_LIMIT', `El thread excede el limite reconciliable de ${maximum} turnos.`);
      }
      cursor = typeof response.nextCursor === 'string' ? response.nextCursor : null;
    } while (cursor && result.length < maximum);
    if (cursor) throw new AppError('TURN_HISTORY_LIMIT', `El thread excede el limite reconciliable de ${maximum} turnos.`);
    return result;
  }

  private parsePersistedTurn(turn: Record<string, unknown>): PersistedTurn {
    const turnId = requiredString(turn.id, 'turn.id');
    const status = turn.status;
    if (status !== 'completed' && status !== 'interrupted' && status !== 'failed' && status !== 'inProgress') {
      throw new AppError('INVALID_APP_SERVER_RESPONSE', 'Estado persistido de turno invalido.');
    }
    let finalText: string | null = null;
    if (Array.isArray(turn.items)) {
      for (const item of turn.items) {
        if (isRecord(item) && item.type === 'agentMessage' && typeof item.text === 'string'
          && (item.phase === 'final_answer' || finalText === null)) finalText = item.text.slice(0, 100_000);
      }
    }
    return {
      turnId,
      status,
      finalText,
      error: turnError(turn.error),
      blockedReason: durableBlockedReason(turn.items),
    };
  }

  async listThreads(workspace?: string, limit = 100): Promise<ThreadInfo[]> {
    const result: ThreadInfo[] = [];
    let cursor: string | null = null;
    do {
      const response: unknown = await this.rpc.request('thread/list', {
        cursor,
        limit: Math.min(100, limit - result.length),
        sortKey: 'updated_at',
        sortDirection: 'desc',
        sourceKinds: ALL_THREAD_SOURCE_KINDS,
        archived: false,
        ...(workspace ? { cwd: workspace } : {}),
      });
      if (!isRecord(response) || !Array.isArray(response.data)) {
        throw new AppError('INVALID_APP_SERVER_RESPONSE', 'Respuesta thread/list invalida.');
      }
      result.push(...response.data.map(recordThread));
      cursor = typeof response.nextCursor === 'string' ? response.nextCursor : null;
    } while (cursor && result.length < limit);
    return result.slice(0, limit);
  }

  async listModels(maximum = 200): Promise<ModelInfo[]> {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 500) {
      throw new AppError('INVALID_MODEL_LIMIT', 'El limite de modelos debe estar entre 1 y 500.');
    }
    const result: ModelInfo[] = [];
    const seenModels = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const response: unknown = await this.rpc.request('model/list', {
        cursor,
        limit: Math.min(100, maximum - result.length),
        includeHidden: false,
      });
      if (!isRecord(response) || !Array.isArray(response.data)) {
        throw new AppError('INVALID_APP_SERVER_RESPONSE', 'Respuesta model/list invalida.');
      }
      for (const item of response.data) {
        const model = recordModel(item);
        if (model.hidden || seenModels.has(model.model)) continue;
        seenModels.add(model.model);
        result.push(model);
        if (result.length === maximum) break;
      }
      cursor = typeof response.nextCursor === 'string' && response.nextCursor.length > 0
        ? response.nextCursor
        : null;
      if (cursor) {
        if (seenCursors.has(cursor)) throw new AppError('INVALID_APP_SERVER_RESPONSE', 'model/list repitio un cursor.');
        seenCursors.add(cursor);
      }
    } while (cursor && result.length < maximum);
    return result;
  }

  async setThreadName(threadId: string, name: string): Promise<void> {
    await this.rpc.request('thread/name/set', { threadId, name });
  }

  async injectText(threadId: string, text: string): Promise<void> {
    if (this.ownedThreadId !== threadId) throw new AppError('THREAD_NOT_OWNED', 'El cliente no posee el thread solicitado.');
    await this.rpc.request('thread/inject_items', {
      threadId,
      items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }],
    }, 30_000);
  }

  async configureThread(settings: ThreadSettings): Promise<void> {
    if (this.ownedThreadId !== settings.threadId) {
      throw new AppError('THREAD_NOT_OWNED', 'El cliente no posee el thread solicitado.');
    }
    await this.rpc.request('thread/settings/update', {
      threadId: settings.threadId,
      cwd: settings.workspace,
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandboxPolicy: settings.dangerFullAccess ? { type: 'dangerFullAccess' } : {
        type: 'workspaceWrite',
        writableRoots: [settings.workspace],
        networkAccess: settings.network,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      },
      ...(settings.model ? { model: settings.model } : {}),
      ...(settings.effort ? { effort: settings.effort } : {}),
    }, 30_000);
  }

  async restoreSafeThreadSettings(threadId: string, timeoutMs = 15_000): Promise<void> {
    if (this.ownedThreadId !== threadId || !this.ownedWorkspace) {
      throw new AppError('THREAD_NOT_OWNED', 'No se puede restaurar la politica de un thread no administrado.');
    }
    await this.rpc.request('thread/settings/update', {
      threadId,
      cwd: this.ownedWorkspace,
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: [this.ownedWorkspace],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      },
    }, timeoutMs);
  }

  async prepareThreadForTerminal(threadId: string, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    await this.restoreSafeThreadSettings(threadId, Math.max(1, deadline - Date.now()));
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new AppError('SAFE_CLEANUP_TIMEOUT', 'Tiempo agotado al limpiar terminales de fondo.');
    await this.rpc.request('thread/backgroundTerminals/clean', { threadId }, remaining);
  }

  async setGoal(
    threadId: string,
    objective: string | undefined,
    status: GoalStatus,
    tokenBudget?: number,
    timeoutMs = 30_000,
  ): Promise<GoalInfo> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new AppError('INVALID_GOAL_TIMEOUT', 'El limite de thread/goal/set debe ser positivo.');
    }
    const response = await this.rpc.request<unknown>('thread/goal/set', {
      threadId,
      ...(objective !== undefined ? { objective } : {}),
      status,
      ...(tokenBudget !== undefined ? { tokenBudget } : {}),
    }, timeoutMs);
    if (!isRecord(response) || !isRecord(response.goal)) {
      throw new AppError('INVALID_APP_SERVER_RESPONSE', 'Respuesta thread/goal/set invalida.');
    }
    const goal = recordGoal(response.goal);
    if (goal.threadId !== threadId) throw new AppError('THREAD_ID_MISMATCH', 'App Server actualizo un Goal de otro thread.');
    return goal;
  }

  async getGoal(threadId: string, timeoutMs = 30_000): Promise<GoalInfo | null> {
    const response = await this.rpc.request<unknown>('thread/goal/get', { threadId }, timeoutMs);
    if (!isRecord(response)) throw new AppError('INVALID_APP_SERVER_RESPONSE', 'Respuesta thread/goal/get invalida.');
    if (response.goal === null) return null;
    const goal = recordGoal(response.goal);
    if (goal.threadId !== threadId) throw new AppError('THREAD_ID_MISMATCH', 'App Server devolvio un Goal de otro thread.');
    return goal;
  }

  async interrupt(threadId: string, turnId: string, timeoutMs = 10_000): Promise<void> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new AppError('INVALID_TURN_TIMEOUT', 'El limite de turn/interrupt debe ser positivo.');
    }
    await this.rpc.request('turn/interrupt', { threadId, turnId }, timeoutMs);
  }

  async runNativeGoal(options: NativeGoalOptions): Promise<NativeGoalResult> {
    if (this.ownedThreadId !== options.threadId) {
      throw new AppError('THREAD_NOT_OWNED', 'El cliente no posee el thread solicitado.');
    }
    if (this.activeTurnId) throw new AppError('TURN_ALREADY_ACTIVE', 'Ya hay un turno activo en este supervisor.');
    if (!Number.isSafeInteger(options.maxTurns) || options.maxTurns < 1) {
      throw new AppError('INVALID_GOAL_LIMIT', 'El Goal requiere al menos un turno disponible.');
    }
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0
      || !Number.isFinite(options.turnTimeoutMs) || options.turnTimeoutMs <= 0) {
      throw new AppError('INVALID_GOAL_TIMEOUT', 'Los limites de tiempo del Goal deben ser positivos.');
    }

    let activated = false;
    let settled = false;
    let activeTurnId: string | null = options.existingTurnId ?? null;
    let lastGoal: GoalInfo | null = null;
    let terminalGoal: GoalInfo | null = null;
    let lastTurn: TurnResult | null = null;
    let turnsStarted = 0;
    let totalTokens = 0;
    let stopReason: GoalStopReason = null;
    let requestedStop: { status: Exclude<GoalStatus, 'active' | 'complete'>; reason: Exclude<GoalStopReason, null> } | null = null;
    let stopPromise: Promise<void> | null = null;
    let stopDeadlineAt: number | null = null;
    let callbackChain = Promise.resolve();
    const seenTurnIds = new Set<string>(options.existingTurnId ? [options.existingTurnId] : []);
    const completedTurnIds = new Set<string>();
    const failedByTurn = new Map<string, Set<string>>();
    const finalTextByTurn = new Map<string, string>();
    let turnTimer: NodeJS.Timeout | undefined;
    let turnDeadlineAt: number | null = null;
    const wallDeadlineAt = Date.now() + options.timeoutMs;
    let wallTimer: NodeJS.Timeout | undefined;
    let terminalGrace: NodeJS.Timeout | undefined;
    let terminalQuiescence: Promise<void> | null = null;
    let terminalQuiescent = false;
    let activationCloseStarted = false;
    let rejectActivationAbort: ((reason: unknown) => void) | null = null;
    const activationAbort = new Promise<never>((_resolve, reject) => {
      rejectActivationAbort = reject;
    });
    let completionResolve: ((value: NativeGoalResult) => void) | undefined;
    let completionReject: ((reason: unknown) => void) | undefined;
    const completion = new Promise<NativeGoalResult>((resolve, reject) => {
      completionResolve = resolve;
      completionReject = reject;
    });
    void completion.catch(() => undefined);

    const clearTurnTimers = (): void => {
      if (turnTimer) clearTimeout(turnTimer);
      turnTimer = undefined;
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      completionReject?.(error instanceof Error ? error : new AppError('GOAL_FAILED', String(error)));
    };
    const enqueue = (callback: (() => Promise<void> | void) | undefined): void => {
      if (!callback) return;
      callbackChain = callbackChain.then(callback);
      void callbackChain.catch(fail);
    };
    const shutdownDeadline = (): number => {
      stopDeadlineAt ??= Date.now() + Math.max(1000, Math.min(15_000, options.turnTimeoutMs));
      return stopDeadlineAt;
    };
    const startTerminalQuiescence = (): void => {
      if (terminalQuiescence || settled) return;
      terminalQuiescence = (async () => {
        const deadline = shutdownDeadline();
        let idleSince: number | null = null;
        let lastInterruptFailure: string | null = null;
        const lastInterruptAt = new Map<string, number>();
        while (!settled && Date.now() < deadline) {
          const remaining = deadline - Date.now();
          const turns = await this.listTurns(options.threadId, 1001, Math.max(1, remaining));
          const inProgress = turns.filter((turn) => turn.status === 'inProgress');
          const byId = new Map(turns.map((turn) => [turn.turnId, turn]));
          const interruptIds = new Set<string>();
          if (activeTurnId) {
            const active = byId.get(activeTurnId);
            if (!active || active.status === 'inProgress') interruptIds.add(activeTurnId);
          }
          for (const turn of inProgress) interruptIds.add(turn.turnId);
          if (interruptIds.size > 0) {
            terminalQuiescent = false;
            idleSince = null;
            for (const pendingTurnId of interruptIds) {
              activeTurnId = pendingTurnId;
              this.activeTurnId = pendingTurnId;
              if (!seenTurnIds.has(pendingTurnId)) {
                seenTurnIds.add(pendingTurnId);
                turnsStarted += 1;
                enqueue(options.onTurnStarted ? () => options.onTurnStarted!(pendingTurnId) : undefined);
              }
              if (!failedByTurn.has(pendingTurnId)) failedByTurn.set(pendingTurnId, new Set());
              if (Date.now() - (lastInterruptAt.get(pendingTurnId) ?? 0) < 500) continue;
              lastInterruptAt.set(pendingTurnId, Date.now());
              try {
                await this.interrupt(options.threadId, pendingTurnId, Math.max(1, Math.min(10_000, deadline - Date.now())));
                lastInterruptFailure = null;
              } catch (error) {
                lastInterruptFailure = errorMessage(error);
              }
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
            continue;
          }
          if (activeTurnId) {
            const persisted = turns.find((turn) => turn.turnId === activeTurnId);
            if (!persisted) {
              idleSince = null;
              await new Promise((resolve) => setTimeout(resolve, 100));
              continue;
            }
            if (persisted.status !== 'inProgress') {
              acceptCompletedTurn({
                threadId: options.threadId,
                turnId: persisted.turnId,
                status: persisted.status,
                finalText: persisted.finalText,
                totalTokens: Math.max(totalTokens, terminalGoal?.tokensUsed ?? 0),
                error: persisted.error,
                failedItems: [],
                blockedReason: this.interactionReason ?? persisted.blockedReason,
              });
            }
          }
          const thread = await this.readThread(options.threadId, Math.max(1, deadline - Date.now()));
          const active = isRecord(thread.status) && thread.status.type === 'active';
          const idle = isRecord(thread.status) && thread.status.type === 'idle';
          if (idle && activeTurnId === null) {
            idleSince ??= Date.now();
            if (Date.now() - idleSince >= 250) {
              terminalQuiescent = true;
              return;
            }
          } else if (!active) {
            throw new AppError('REMOTE_STATE_UNCERTAIN', 'El thread no alcanzo el estado idle durante la terminacion del Goal.');
          } else {
            idleSince = null;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (!settled) {
          throw new AppError(
            'GOAL_TURN_AMBIGUOUS',
            `No se pudo confirmar que el thread quedara inactivo despues del stop${lastInterruptFailure ? `: ${lastInterruptFailure}` : '.'}`,
          );
        }
      })();
      void terminalQuiescence.then(() => {
        terminalQuiescence = null;
        finishIfTerminal();
      }, fail);
    };
    const finishIfTerminal = (): void => {
      if (settled || !activated || !terminalGoal) return;
      if (requestedStop) {
        if (stopPromise) return;
        if (!terminalQuiescent) {
          startTerminalQuiescence();
          return;
        }
      }
      if (activeTurnId) {
        if (!terminalGrace) {
          const deadline = stopReason
            ? Date.now() + Math.max(1000, Math.min(15_000, options.turnTimeoutMs))
            : Math.min(turnDeadlineAt ?? Date.now() + options.turnTimeoutMs, wallDeadlineAt);
          const schedulePoll = (poll: () => void): void => {
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
              fail(new AppError('GOAL_TURN_AMBIGUOUS', 'El Goal termino pero su ultimo turno sigue sin estado durable.'));
              return;
            }
            terminalGrace = setTimeout(poll, Math.min(250, Math.max(1, Math.floor(remaining / 2))));
          };
          const poll = (): void => {
            if (settled || !activeTurnId) return;
            const turnId = activeTurnId;
            const remaining = deadline - Date.now();
            void this.readTurn(options.threadId, turnId, Math.max(1, remaining)).then((persisted) => {
              if (Date.now() > deadline) {
                fail(new AppError('GOAL_TURN_AMBIGUOUS', 'El turno final no quedo durable dentro de su limite de tiempo.'));
                return;
              }
              if (!persisted || persisted.status === 'inProgress') {
                schedulePoll(poll);
                return;
              }
              acceptCompletedTurn({
                threadId: options.threadId,
                turnId,
                status: persisted.status,
                finalText: persisted.finalText,
                totalTokens: Math.max(totalTokens, terminalGoal?.tokensUsed ?? 0),
                error: persisted.error,
                failedItems: [],
                blockedReason: this.interactionReason ?? persisted.blockedReason,
              });
            }).catch(fail);
          };
          schedulePoll(poll);
        }
        return;
      }
      settled = true;
      void callbackChain.then(() => completionResolve?.({
        goal: terminalGoal!,
        lastTurn,
        turnsStarted,
        activeTurnId,
        stopReason,
      }), completionReject);
    };
    const acceptGoal = (goal: GoalInfo): void => {
      lastGoal = goal;
      totalTokens = Math.max(totalTokens, goal.tokensUsed);
      enqueue(options.onGoalUpdated ? () => options.onGoalUpdated!(goal) : undefined);
      if (goal.status !== 'active') {
        terminalGoal = goal;
        if (!activeTurnId) {
          clearTurnTimers();
          if (wallTimer) clearTimeout(wallTimer);
        }
        if (goal.status === 'paused' && activeTurnId && requestedStop === null) {
          void this.interrupt(options.threadId, activeTurnId).catch(fail);
        }
        finishIfTerminal();
      }
    };
    const requestStop = (
      status: Exclude<GoalStatus, 'active' | 'complete'>,
      reason: Exclude<GoalStopReason, null>,
    ): void => {
      if (settled) return;
      const effectiveReason = strongerStopReason(stopReason, reason);
      stopReason = effectiveReason;
      if (!requestedStop || effectiveReason === reason) requestedStop = { status, reason: effectiveReason };
      shutdownDeadline();
      if (!activated) return;
      if (terminalGoal?.status === 'complete') {
        if (activeTurnId) void this.interrupt(
          options.threadId,
          activeTurnId,
          Math.max(1, Math.min(10_000, shutdownDeadline() - Date.now())),
        ).catch(fail);
        finishIfTerminal();
        return;
      }
      if (stopPromise) return;
      stopPromise = (async () => {
        while (requestedStop) {
          const target: { status: Exclude<GoalStatus, 'active' | 'complete'>; reason: Exclude<GoalStopReason, null> } = requestedStop;
          const remaining = shutdownDeadline() - Date.now();
          if (remaining <= 0) throw new AppError('GOAL_TIMEOUT', 'Tiempo agotado al detener el Goal.');
          const goal = await this.setGoal(
            options.threadId,
            undefined,
            target.status,
            undefined,
            Math.max(1, remaining),
          );
          acceptGoal(goal);
          if (requestedStop === target) break;
        }
        stopPromise = null;
        finishIfTerminal();
      })().catch((error) => {
        stopPromise = null;
        fail(error);
      });
    };
    const acceptCompletedTurn = (result: TurnResult): void => {
      if (completedTurnIds.has(result.turnId)) return;
      if (activeTurnId && activeTurnId !== result.turnId) return;
      if (!seenTurnIds.has(result.turnId)) return;
      completedTurnIds.add(result.turnId);
      const terminalCauseExplainsTurnStop = terminalGoal !== null
        && terminalGoal.status !== 'active'
        && terminalGoal.status !== 'complete';
      if (!requestedStop && !terminalCauseExplainsTurnStop && !result.blockedReason
        && (result.status === 'failed' || result.status === 'interrupted')) {
        const failureReason = `turn_${result.status}`;
        result = { ...result, blockedReason: failureReason };
        void persistBlockedEvidence(failureReason, result.turnId).catch(fail);
      }
      const completedAt = Date.now();
      let wallExceeded = false;
      if (completedAt > wallDeadlineAt) {
        wallExceeded = true;
        stopReason = strongerStopReason(stopReason, 'wall_timeout');
      } else if (turnDeadlineAt !== null && completedAt > turnDeadlineAt) {
        stopReason = strongerStopReason(stopReason, 'turn_timeout');
        result = { ...result, blockedReason: result.blockedReason ?? 'turn_timeout' };
        void persistBlockedEvidence('turn_timeout', result.turnId).catch(fail);
      }
      lastTurn = result;
      activeTurnId = null;
      this.activeTurnId = null;
      turnDeadlineAt = null;
      if (terminalGrace) clearTimeout(terminalGrace);
      terminalGrace = undefined;
      clearTurnTimers();
      enqueue(options.onTurnCompleted ? () => options.onTurnCompleted!(result) : undefined);
      if (wallExceeded) {
        requestStop('budgetLimited', 'wall_timeout');
      } else if (result.blockedReason) {
        requestStop('blocked', 'interaction_required');
      } else if (turnsStarted >= options.maxTurns && (!lastGoal || lastGoal.status === 'active')) {
        requestStop('budgetLimited', 'max_turns');
      }
      finishIfTerminal();
    };
    const persistBlockedEvidence = async (reason: string, turnId: string): Promise<void> => {
      this.interactionReason = reason;
      const task = callbackChain.then(() => options.onBlockedEvidence?.(reason, turnId));
      callbackChain = task.then(() => undefined);
      void callbackChain.catch(fail);
      await task;
    };
    const blockedEvidenceHandler = async (reason: string, turnId: string): Promise<void> => {
      await persistBlockedEvidence(reason, turnId);
      requestStop('blocked', 'interaction_required');
      await this.interrupt(options.threadId, turnId).catch(() => undefined);
    };
    this.blockedEvidenceHandler = blockedEvidenceHandler;

    const listener = (message: RpcMessage): void => {
      if (settled || typeof message.method !== 'string' || !isRecord(message.params)) return;
      const ids = readThreadAndTurn(message.params);
      if (ids.threadId !== options.threadId) return;

      try {
        if (message.method === 'thread/goal/updated' && isRecord(message.params.goal)) {
          const goal = recordGoal(message.params.goal);
          if (goal.threadId !== options.threadId) throw new AppError('THREAD_ID_MISMATCH', 'Notificacion Goal de otro thread.');
          acceptGoal(goal);
          return;
        }

        if (message.method === 'thread/tokenUsage/updated' && isRecord(message.params.tokenUsage)) {
          const usage = message.params.tokenUsage;
          if (isRecord(usage.total) && typeof usage.total.totalTokens === 'number') {
            totalTokens = Math.max(totalTokens, usage.total.totalTokens);
          }
          return;
        }

        if (message.method === 'turn/started' && isRecord(message.params.turn)) {
          const turnId = requiredString(message.params.turn.id, 'turn.id');
          if (activeTurnId && activeTurnId !== turnId) {
            if (!requestedStop && !terminalGoal) {
              fail(new AppError('OVERLAPPING_TURNS', 'Codex inicio dos turnos simultaneos en el Goal administrado.'));
              return;
            }
          }
          activeTurnId = turnId;
          this.activeTurnId = turnId;
          if (terminalGrace) clearTimeout(terminalGrace);
          terminalGrace = undefined;
          terminalQuiescent = false;
          this.interactionReason = null;
          if (!seenTurnIds.has(turnId)) {
            seenTurnIds.add(turnId);
            turnsStarted += 1;
            enqueue(options.onTurnStarted ? () => options.onTurnStarted!(turnId) : undefined);
          }
          if (!failedByTurn.has(turnId)) failedByTurn.set(turnId, new Set());
          if (turnsStarted > options.maxTurns) {
            requestStop('budgetLimited', 'max_turns');
            return;
          }
          if (turnTimer) clearTimeout(turnTimer);
          turnDeadlineAt = Date.now() + options.turnTimeoutMs;
          turnTimer = setTimeout(() => {
            const timedOutTurnId = activeTurnId;
            if (!timedOutTurnId) return;
            void persistBlockedEvidence('turn_timeout', timedOutTurnId)
              .then(() => requestStop('blocked', 'turn_timeout'), fail);
          }, options.turnTimeoutMs);
          turnTimer.unref();
          if (requestedStop) requestStop(requestedStop.status, requestedStop.reason);
          if (terminalGoal) void this.interrupt(options.threadId, turnId).catch(fail);
          return;
        }

        if (message.method === 'item/completed' && ids.turnId && isRecord(message.params.item)) {
          const failures = failedByTurn.get(ids.turnId) ?? new Set<string>();
          failedByTurn.set(ids.turnId, failures);
          const finalText = collectTurnItems([message.params.item], failures);
          if (finalText) finalTextByTurn.set(ids.turnId, finalText);
          return;
        }

        if (message.method === 'turn/completed' && isRecord(message.params.turn)) {
          const turn = message.params.turn as TurnWire;
          const turnId = requiredString(turn.id, 'turn.id');
          if (activeTurnId && activeTurnId !== turnId) return;
          const failures = failedByTurn.get(turnId) ?? new Set<string>();
          const finalText = collectTurnItems(turn.items, failures) ?? finalTextByTurn.get(turnId) ?? null;
          const status = recordTurnStatus(turn.status);
          if (status === 'inProgress') throw new AppError('INVALID_APP_SERVER_RESPONSE', 'turn/completed contiene un turno inProgress.');
          const result: TurnResult = {
            threadId: options.threadId,
            turnId,
            status,
            finalText,
            totalTokens: Math.max(totalTokens, lastGoal?.tokensUsed ?? 0),
            error: turnError(turn.error),
            failedItems: [...failures].slice(0, 20).map((item) => item.slice(0, 1000)),
            blockedReason: this.interactionReason,
          };
          acceptCompletedTurn(result);
        }
      } catch (error) {
        fail(error);
      }
    };
    const closedListener = (error: unknown): void => {
      fail(error instanceof Error ? error : new AppError('APP_SERVER_CLOSED', 'App Server se cerro durante el Goal.'));
    };
    const abortListener = (): void => {
      requestStop('paused', 'signal');
      if (!activated && !activationCloseStarted) {
        activationCloseStarted = true;
        void this.rpc.close().then(
          () => rejectActivationAbort?.(new AppError(
            'REMOTE_STATE_UNCERTAIN',
            'Se cerro el App Server durante una activacion Goal sin respuesta para impedir trabajo tardio.',
          )),
          (error) => rejectActivationAbort?.(new AppError(
            'REMOTE_STATE_UNCERTAIN',
            `No se pudo confirmar el cierre durante la activacion Goal: ${errorMessage(error)}`,
            1,
            { cause: error },
          )),
        );
      }
    };
    this.rpc.on('notification', listener);
    this.rpc.on('closed', closedListener);
    options.signal.addEventListener('abort', abortListener, { once: true });
    wallTimer = setTimeout(() => {
      requestStop('budgetLimited', 'wall_timeout');
    }, options.timeoutMs);
    wallTimer.unref();

    try {
      if (options.signal.aborted) throw new AppError('INTERRUPTED', 'Interrumpido antes de activar el Goal.', 130);
      const activationRemaining = wallDeadlineAt - Date.now();
      if (activationRemaining <= 0) throw new AppError('GOAL_TIMEOUT', 'Tiempo agotado antes de activar el Goal.');
      let goal: GoalInfo;
      try {
        options.onActivationAttempt?.();
        goal = await Promise.race([
          this.setGoal(
            options.threadId,
            options.objective,
            'active',
            options.tokenBudget,
            Math.max(1, activationRemaining),
          ),
          activationAbort,
        ]);
      } catch (error) {
        if (error instanceof AppError && error.code === 'REMOTE_STATE_UNCERTAIN') throw error;
        if (options.signal.aborted) {
          throw new AppError(
            'REMOTE_STATE_UNCERTAIN',
            `La activacion Goal fue interrumpida antes de confirmar su estado: ${errorMessage(error)}`,
            1,
            { cause: error },
          );
        }
        if (!(error instanceof AppError) || error.code !== 'RPC_TIMEOUT') throw error;
        throw new AppError(
          'REMOTE_STATE_UNCERTAIN',
          `La activacion del Goal excedio su plazo; el supervisor cerrara el App Server para impedir trabajo tardio: ${error.message}`,
          1,
          { cause: error },
        );
      }
      enqueue(options.onActivated ? () => options.onActivated!(goal) : undefined);
      acceptGoal(goal);
      activated = true;
      if (activeTurnId && !turnTimer) {
        this.activeTurnId = activeTurnId;
        turnDeadlineAt = Date.now() + options.turnTimeoutMs;
        turnTimer = setTimeout(() => {
          const timedOutTurnId = activeTurnId;
          if (!timedOutTurnId) return;
          void persistBlockedEvidence('turn_timeout', timedOutTurnId)
            .then(() => requestStop('blocked', 'turn_timeout'), fail);
        }, options.turnTimeoutMs);
        turnTimer.unref();
      }
      const pendingStop = requestedStop as { status: Exclude<GoalStatus, 'active' | 'complete'>; reason: Exclude<GoalStopReason, null> } | null;
      if (pendingStop) requestStop(pendingStop.status, pendingStop.reason);
      finishIfTerminal();
      return await completion;
    } finally {
      settled = true;
      clearTurnTimers();
      if (wallTimer) clearTimeout(wallTimer);
      if (terminalGrace) clearTimeout(terminalGrace);
      this.rpc.off('notification', listener);
      this.rpc.off('closed', closedListener);
      options.signal.removeEventListener('abort', abortListener);
      if (this.blockedEvidenceHandler === blockedEvidenceHandler) this.blockedEvidenceHandler = null;
      this.activeTurnId = null;
    }
  }

  private handleServerRequest(request: ServerRequest): void {
    const ids = readThreadAndTurn(request.params);
    const connectionRequest = request.method === 'currentTime/read'
      || request.method === 'account/chatgptAuthTokens/refresh'
      || request.method === 'attestation/generate';
    if (!connectionRequest && this.ownedThreadId && ids.threadId !== undefined && ids.threadId !== this.ownedThreadId) {
      this.rpc.respondError(request.id, -32600, 'Thread no administrado por este cliente.');
      return;
    }
    const mayAffectActiveTurn = this.ownedThreadId !== null && this.activeTurnId !== null
      && (ids.threadId === undefined || ids.threadId === this.ownedThreadId)
      && (ids.turnId === undefined || ids.turnId === this.activeTurnId);
    const denyAfterEvidence = (reason: string, respond: () => void): void => {
      if (!mayAffectActiveTurn || !this.activeTurnId) {
        respond();
        return;
      }
      const turnId = this.activeTurnId;
      this.interactionReason = reason;
      if (!this.blockedEvidenceHandler) {
        respond();
        void this.interrupt(this.ownedThreadId!, turnId).catch(() => undefined);
        return;
      }
      void this.blockedEvidenceHandler(reason, turnId).then(respond, () => {
        respond();
        if (this.ownedThreadId) void this.interrupt(this.ownedThreadId, turnId).catch(() => undefined);
      });
    };

    if (request.method === 'currentTime/read') {
      this.rpc.respond(request.id, { currentTimeAt: Math.floor(Date.now() / 1000) });
      return;
    }
    if (request.method === 'item/commandExecution/requestApproval'
      || request.method === 'item/fileChange/requestApproval') {
      denyAfterEvidence(
        `approval_denied:${request.method}`,
        () => this.rpc.respond(request.id, { decision: 'decline' }),
      );
      return;
    }
    if (request.method === 'applyPatchApproval' || request.method === 'execCommandApproval') {
      denyAfterEvidence(
        `approval_denied:${request.method}`,
        () => this.rpc.respond(request.id, { decision: { denied: { rejection: 'Denied in unattended mode.' } } }),
      );
      return;
    }
    if (request.method === 'mcpServer/elicitation/request') {
      denyAfterEvidence(
        'mcp_elicitation_required',
        () => this.rpc.respond(request.id, { action: 'cancel', content: null, _meta: null }),
      );
      return;
    }
    if (request.method === 'item/permissions/requestApproval') {
      denyAfterEvidence(
        'permission_escalation_denied',
        () => this.rpc.respond(request.id, { permissions: {}, scope: 'turn' }),
      );
      return;
    }
    if (request.method === 'item/tool/call') {
      denyAfterEvidence('dynamic_tool_unavailable', () => this.rpc.respond(request.id, {
          contentItems: [{ type: 'inputText', text: 'Tool unavailable in unattended mode.' }],
          success: false,
        }));
      return;
    }
    if (request.method === 'item/tool/requestUserInput') {
      denyAfterEvidence(
        'user_input_required',
        () => this.rpc.respondError(request.id, -32001, 'User input is unavailable in unattended mode.'),
      );
      return;
    }
    if (request.method === 'account/chatgptAuthTokens/refresh') {
      this.rpc.respondError(request.id, -32001, 'External token refresh is not supported; use Codex Desktop managed authentication.');
      return;
    }
    if (request.method === 'attestation/generate') {
      this.rpc.respondError(request.id, -32001, 'Attestation is disabled for this client.');
      return;
    }
    denyAfterEvidence(
      `unsupported_server_request:${request.method.slice(0, 500)}`,
      () => this.rpc.respondError(request.id, -32601, `Server request no soportado: ${request.method}`),
    );
  }
}
