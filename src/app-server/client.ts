import type { EventEmitter } from 'node:events';
import { AppError, errorMessage } from '../errors.js';
import type { Logger } from '../log.js';
import { COMPLETION_SCHEMA } from '../decision.js';
import type { RpcMessage, ServerRequest } from './rpc.js';

export interface RpcTransport extends Pick<EventEmitter, 'on' | 'off'> {
  request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  respond(id: number | string, result: unknown): void;
  respondError(id: number | string, code: number, message: string): void;
  close(): Promise<void>;
}

export type GoalStatus = 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete';
export type TurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress';

export interface AccountInfo {
  account: null | { type: string; email?: string | null; planType?: string };
  requiresOpenaiAuth: boolean;
}

export interface ThreadInfo {
  id: string;
  preview: string;
  name: string | null;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  status: unknown;
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

export interface TurnOptions {
  threadId: string;
  prompt: string;
  workspace: string;
  network: boolean;
  dangerFullAccess: boolean;
  timeoutMs: number;
  model?: string;
  effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'ultra';
  onStarted?(turnId: string): Promise<void> | void;
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

export interface PersistedTurn {
  turnId: string;
  status: TurnStatus;
  finalText: string | null;
  error: string | null;
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

interface BufferedNotification {
  method: string;
  params: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AppError('INVALID_APP_SERVER_RESPONSE', `App Server devolvio ${label} invalido.`);
  }
  return value;
}

function recordThread(value: unknown): ThreadInfo {
  if (!isRecord(value)) throw new AppError('INVALID_APP_SERVER_RESPONSE', 'App Server devolvio un thread invalido.');
  return {
    id: requiredString(value.id, 'thread.id'),
    preview: typeof value.preview === 'string' ? value.preview : '',
    name: typeof value.name === 'string' ? value.name : null,
    cwd: requiredString(value.cwd, 'thread.cwd'),
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : 0,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
    status: value.status,
    source: value.source,
    ephemeral: value.ephemeral === true,
  };
}

function readThreadAndTurn(params: unknown): { threadId?: string; turnId?: string } {
  if (!isRecord(params)) return {};
  const turn = isRecord(params.turn) ? params.turn : undefined;
  return {
    threadId: typeof params.threadId === 'string' ? params.threadId : undefined,
    turnId: typeof params.turnId === 'string'
      ? params.turnId
      : turn && typeof turn.id === 'string' ? turn.id : undefined,
  };
}

function turnError(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (isRecord(value) && typeof value.message === 'string') return value.message;
  return JSON.stringify(value).slice(0, 2000);
}

export class CodexDesktopClient {
  private ownedThreadId: string | null = null;
  private activeTurnId: string | null = null;
  private interactionReason: string | null = null;
  private readonly onServerRequestBound: (request: ServerRequest) => void;

  constructor(private readonly rpc: RpcTransport, private readonly logger: Logger) {
    this.onServerRequestBound = (request) => { this.handleServerRequest(request); };
    this.rpc.on('request', this.onServerRequestBound);
  }

  async close(): Promise<void> {
    this.rpc.off('request', this.onServerRequestBound);
    await this.rpc.close();
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
    return thread;
  }

  async resumeThread(threadId: string, workspace: string, model?: string): Promise<ThreadInfo> {
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
    this.ownedThreadId = thread.id;
    return thread;
  }

  async readThread(threadId: string): Promise<ThreadInfo> {
    const response = await this.rpc.request<unknown>('thread/read', { threadId, includeTurns: false });
    if (!isRecord(response)) throw new AppError('INVALID_APP_SERVER_RESPONSE', 'Respuesta thread/read invalida.');
    return recordThread(response.thread);
  }

  async readTurn(threadId: string, turnId: string): Promise<PersistedTurn | null> {
    const response = await this.rpc.request<unknown>('thread/read', { threadId, includeTurns: true }, 60_000);
    if (!isRecord(response) || !isRecord(response.thread) || !Array.isArray(response.thread.turns)) {
      throw new AppError('INVALID_APP_SERVER_RESPONSE', 'Respuesta thread/read invalida para reconciliacion.');
    }
    const turn = response.thread.turns.find((candidate) => isRecord(candidate) && candidate.id === turnId);
    if (!isRecord(turn)) return null;
    const status = turn.status;
    if (status !== 'completed' && status !== 'interrupted' && status !== 'failed' && status !== 'inProgress') {
      throw new AppError('INVALID_APP_SERVER_RESPONSE', 'Estado persistido de turno invalido.');
    }
    let finalText: string | null = null;
    if (Array.isArray(turn.items)) {
      for (const item of turn.items) {
        if (isRecord(item) && item.type === 'agentMessage' && typeof item.text === 'string'
          && (item.phase === 'final_answer' || finalText === null)) finalText = item.text;
      }
    }
    return { turnId, status, finalText, error: turnError(turn.error) };
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

  async setThreadName(threadId: string, name: string): Promise<void> {
    await this.rpc.request('thread/name/set', { threadId, name });
  }

  async setGoal(threadId: string, objective: string | undefined, status: GoalStatus, tokenBudget?: number): Promise<GoalInfo> {
    const response = await this.rpc.request<unknown>('thread/goal/set', {
      threadId,
      ...(objective !== undefined ? { objective } : {}),
      status,
      ...(tokenBudget !== undefined ? { tokenBudget } : {}),
    });
    if (!isRecord(response) || !isRecord(response.goal)) {
      throw new AppError('INVALID_APP_SERVER_RESPONSE', 'Respuesta thread/goal/set invalida.');
    }
    return response.goal as unknown as GoalInfo;
  }

  async getGoal(threadId: string): Promise<GoalInfo | null> {
    const response = await this.rpc.request<unknown>('thread/goal/get', { threadId });
    if (!isRecord(response)) throw new AppError('INVALID_APP_SERVER_RESPONSE', 'Respuesta thread/goal/get invalida.');
    return isRecord(response.goal) ? response.goal as unknown as GoalInfo : null;
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    await this.rpc.request('turn/interrupt', { threadId, turnId }, 10_000);
  }

  async runTurn(options: TurnOptions): Promise<TurnResult> {
    if (this.ownedThreadId !== options.threadId) {
      throw new AppError('THREAD_NOT_OWNED', 'El cliente no posee el thread solicitado.');
    }
    if (this.activeTurnId) throw new AppError('TURN_ALREADY_ACTIVE', 'Ya hay un turno activo en este supervisor.');

    this.interactionReason = null;
    const buffered: BufferedNotification[] = [];
    let turnId: string | null = null;
    let finalText: string | null = null;
    let totalTokens = 0;
    const failedItems: string[] = [];
    let settled = false;
    let completionResolve: ((value: TurnResult) => void) | undefined;
    let completionReject: ((reason: unknown) => void) | undefined;

    const completion = new Promise<TurnResult>((resolve, reject) => {
      completionResolve = resolve;
      completionReject = reject;
    });

    const consume = (message: BufferedNotification): void => {
      const ids = readThreadAndTurn(message.params);
      if (ids.threadId !== options.threadId || !turnId || ids.turnId !== turnId || !isRecord(message.params)) return;

      if (message.method === 'item/completed' && isRecord(message.params.item)) {
        const item = message.params.item;
        if (item.type === 'agentMessage' && typeof item.text === 'string' && (item.phase === 'final_answer' || finalText === null)) {
          finalText = item.text;
        }
        if (item.type === 'commandExecution' && item.status === 'failed') {
          failedItems.push(`command:${typeof item.command === 'string' ? item.command.slice(0, 500) : 'unknown'}`);
        }
        if (item.type === 'fileChange' && item.status === 'failed') failedItems.push('fileChange');
        if (item.type === 'mcpToolCall' && item.status === 'failed') failedItems.push('mcpToolCall');
      }

      if (message.method === 'thread/tokenUsage/updated' && isRecord(message.params.tokenUsage)) {
        const usage = message.params.tokenUsage;
        if (isRecord(usage.total) && typeof usage.total.totalTokens === 'number') totalTokens = usage.total.totalTokens;
      }

      if (message.method === 'turn/completed' && isRecord(message.params.turn)) {
        const turn = message.params.turn as TurnWire;
        const status = turn.status;
        if (status !== 'completed' && status !== 'interrupted' && status !== 'failed' && status !== 'inProgress') {
          settled = true;
          completionReject?.(new AppError('INVALID_APP_SERVER_RESPONSE', 'Estado final de turno invalido.'));
          return;
        }
        settled = true;
        completionResolve?.({
          threadId: options.threadId,
          turnId,
          status,
          finalText,
          totalTokens,
          error: turnError(turn.error),
          failedItems,
          blockedReason: this.interactionReason,
        });
      }
    };

    const listener = (message: RpcMessage) => {
      if (typeof message.method !== 'string') return;
      const notification = { method: message.method, params: message.params };
      if (!turnId) buffered.push(notification);
      else consume(notification);
    };
    this.rpc.on('notification', listener);
    const closedListener = (error: unknown) => {
      if (settled) return;
      settled = true;
      completionReject?.(error instanceof Error ? error : new AppError('APP_SERVER_CLOSED', 'App Server se cerro durante el turno.'));
    };
    this.rpc.on('closed', closedListener);

    let timeout: NodeJS.Timeout | undefined;
    let timeoutGrace: NodeJS.Timeout | undefined;
    try {
      const response = await this.rpc.request<unknown>('turn/start', {
        threadId: options.threadId,
        input: [{ type: 'text', text: options.prompt, text_elements: [] }],
        cwd: options.workspace,
        runtimeWorkspaceRoots: [options.workspace],
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandboxPolicy: options.dangerFullAccess ? { type: 'dangerFullAccess' } : {
          type: 'workspaceWrite',
          writableRoots: [options.workspace],
          networkAccess: options.network,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        },
        outputSchema: COMPLETION_SCHEMA,
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
      }, 60_000);
      if (!isRecord(response) || !isRecord(response.turn)) {
        throw new AppError('INVALID_APP_SERVER_RESPONSE', 'Respuesta turn/start invalida.');
      }
      turnId = requiredString(response.turn.id, 'turn.id');
      this.activeTurnId = turnId;
      await options.onStarted?.(turnId);
      for (const message of buffered) consume(message);
      buffered.length = 0;

      timeout = setTimeout(() => {
        if (settled || !turnId) return;
        this.interactionReason = this.interactionReason ?? 'turn_timeout';
        void this.interrupt(options.threadId, turnId).catch((error) => {
          this.logger.warn(`No se pudo interrumpir el turno vencido: ${errorMessage(error)}`);
        });
        timeoutGrace = setTimeout(() => {
          if (settled) return;
          settled = true;
          completionReject?.(new AppError('TURN_TIMEOUT', 'El turno excedio el tiempo limite y no confirmo su interrupcion.'));
        }, 10_000);
        timeoutGrace.unref();
      }, options.timeoutMs);
      timeout.unref();

      return await completion;
    } finally {
      if (timeout) clearTimeout(timeout);
      if (timeoutGrace) clearTimeout(timeoutGrace);
      this.rpc.off('notification', listener);
      this.rpc.off('closed', closedListener);
      this.activeTurnId = null;
    }
  }

  private handleServerRequest(request: ServerRequest): void {
    const ids = readThreadAndTurn(request.params);
    const connectionRequest = request.method === 'currentTime/read'
      || request.method === 'account/chatgptAuthTokens/refresh'
      || request.method === 'attestation/generate';
    if (!connectionRequest && this.ownedThreadId && ids.threadId !== this.ownedThreadId) {
      this.rpc.respondError(request.id, -32600, 'Thread no administrado por este cliente.');
      return;
    }
    const affectsActiveTurn = ids.threadId === this.ownedThreadId && (!ids.turnId || ids.turnId === this.activeTurnId);

    if (request.method === 'currentTime/read') {
      this.rpc.respond(request.id, { currentTimeAt: Math.floor(Date.now() / 1000) });
      return;
    }
    if (request.method === 'item/commandExecution/requestApproval'
      || request.method === 'item/fileChange/requestApproval') {
      if (affectsActiveTurn) this.interactionReason = `approval_denied:${request.method}`;
      this.rpc.respond(request.id, { decision: 'decline' });
      return;
    }
    if (request.method === 'applyPatchApproval' || request.method === 'execCommandApproval') {
      if (affectsActiveTurn) this.interactionReason = `approval_denied:${request.method}`;
      this.rpc.respond(request.id, { decision: { denied: { rejection: 'Denied in unattended mode.' } } });
      return;
    }
    if (request.method === 'mcpServer/elicitation/request') {
      if (affectsActiveTurn) this.interactionReason = 'mcp_elicitation_required';
      this.rpc.respond(request.id, { action: 'cancel', content: null, _meta: null });
      return;
    }
    if (request.method === 'item/permissions/requestApproval') {
      if (affectsActiveTurn) this.interactionReason = 'permission_escalation_denied';
      this.rpc.respond(request.id, { permissions: {}, scope: 'turn' });
      return;
    }
    if (request.method === 'item/tool/call') {
      if (affectsActiveTurn) this.interactionReason = 'dynamic_tool_unavailable';
      this.rpc.respond(request.id, {
        contentItems: [{ type: 'inputText', text: 'Tool unavailable in unattended mode.' }],
        success: false,
      });
      return;
    }
    if (request.method === 'item/tool/requestUserInput') {
      if (affectsActiveTurn) this.interactionReason = 'user_input_required';
      this.rpc.respondError(request.id, -32001, 'User input is unavailable in unattended mode.');
      if (affectsActiveTurn && this.ownedThreadId && this.activeTurnId) {
        void this.interrupt(this.ownedThreadId, this.activeTurnId).catch(() => undefined);
      }
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
    this.rpc.respondError(request.id, -32601, `Server request no soportado: ${request.method}`);
  }
}
