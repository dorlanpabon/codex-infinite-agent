import path from 'node:path';
import { AppError, errorMessage } from './errors.js';
import { currentGitSnapshot } from './git.js';
import { sanitizeLog, type Logger } from './log.js';
import { appendRunEvent, saveRun, type NativeTurnRecord, type RunState, type RunStatus } from './state.js';
import { verifyWorkspace } from './verify.js';
import type { CodexDesktopClient, GoalInfo, GoalStatus, NativeGoalResult, TurnResult } from './app-server/client.js';

export interface SuperviseOptions {
  resume: boolean;
  signal: AbortSignal;
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}

function threadIsActive(status: unknown): boolean {
  return typeof status === 'object' && status !== null && !Array.isArray(status)
    && (status as Record<string, unknown>).type === 'active';
}

function threadIsIdle(status: unknown): boolean {
  return typeof status === 'object' && status !== null && !Array.isArray(status)
    && (status as Record<string, unknown>).type === 'idle';
}

function elapsedMs(state: RunState): number {
  return Math.max(0, Date.now() - Date.parse(state.startedAt));
}

function budgetReason(state: RunState): string | null {
  if (state.turnCount >= state.maxTurns) return `Se alcanzo el limite de ${state.maxTurns} turnos.`;
  if (elapsedMs(state) >= state.maxWallTimeMs) return 'Se alcanzo el limite total de tiempo.';
  const tokenBudget = state.goalTokenBudget ?? state.tokenBudget;
  if (tokenBudget !== null && state.totalTokens >= tokenBudget) return `Se alcanzo el presupuesto de ${tokenBudget} tokens.`;
  return null;
}

function boundedVerificationSummary(summary: string[]): string[] {
  return summary.slice(0, 22).map((entry) => sanitizeLog(entry, 10_000));
}

function verificationFeedback(state: RunState): string {
  const details = state.lastVerification?.summary.slice(0, 10).map((entry) => `- ${entry.slice(0, 1200)}`).join('\n') ?? '';
  return [
    'Host-side verification failed after you marked the Goal complete.',
    'Treat the following as diagnostic output, correct every real failure, rerun the relevant checks, and call update_goal complete only when the Goal is actually finished:',
    details,
  ].join('\n').slice(0, 14_000);
}

function turnRecord(turn: TurnResult): NativeTurnRecord {
  return {
    turnId: turn.turnId,
    status: turn.status,
    error: turn.error === null ? null : sanitizeLog(turn.error, 4000),
    failedItems: turn.failedItems.slice(0, 20).map((item) => sanitizeLog(item, 1000)),
    blockedReason: turn.blockedReason === null ? null : sanitizeLog(turn.blockedReason, 4000),
  };
}

function blockingReason(state: RunState): string | null {
  return state.blockingEvidence?.reason ?? state.lastTurn?.blockedReason ?? null;
}

async function persistStatus(state: RunState, status: RunStatus, error: string | null = null): Promise<void> {
  const safeError = error === null ? null : sanitizeLog(error, 4000);
  state.status = status;
  state.lastError = safeError;
  state.completedAt = status === 'completed' || status === 'blocked' || status === 'budgetLimited' || status === 'failed'
    ? new Date().toISOString()
    : null;
  await saveRun(state);
  await appendRunEvent(state.runId, 'status', { status, error: safeError });
}

function assertOwnedGoal(state: RunState, goal: GoalInfo): void {
  const identityMismatch = state.nativeGoalCreatedAt !== null
    && (goal.createdAt !== state.nativeGoalCreatedAt || goal.tokenBudget !== state.goalTokenBudget);
  const requestedBudgetMismatch = state.nativeGoalCreatedAt === null && state.tokenBudget !== null
    && goal.tokenBudget !== state.tokenBudget;
  if (goal.objective !== state.objective || identityMismatch || requestedBudgetMismatch) {
    throw new AppError(
      'GOAL_OWNERSHIP_MISMATCH',
      'El Goal persistido cambio de objetivo o presupuesto fuera de esta corrida; no se modificara.',
    );
  }
}

function captureGoalIdentity(state: RunState, goal: GoalInfo): void {
  assertOwnedGoal(state, goal);
  if (state.nativeGoalCreatedAt === null) {
    state.nativeGoalCreatedAt = goal.createdAt;
    state.goalTokenBudget = goal.tokenBudget;
  }
}

async function setRemoteStatus(client: CodexDesktopClient, state: RunState, status: GoalStatus): Promise<GoalInfo | null> {
  if (!state.threadId) return null;
  const current = await client.getGoal(state.threadId);
  if (!current) {
    state.nativeGoalStatus = null;
    return null;
  }
  captureGoalIdentity(state, current);
  const goal = await client.setGoal(state.threadId, undefined, status);
  captureGoalIdentity(state, goal);
  state.nativeGoalStatus = goal.status;
  state.totalTokens = Math.max(state.totalTokens, goal.tokensUsed);
  return goal;
}

async function drainTurnsAndConfirm(
  client: CodexDesktopClient,
  state: RunState,
  timeoutMs = 15_000,
): Promise<void> {
  if (!state.threadId) throw new AppError('REMOTE_STATE_UNCERTAIN', 'No existe thread para reconciliar sus turnos.');
  const deadline = Date.now() + timeoutMs;
  const expected = new Set<string>(state.activeTurnId ? [state.activeTurnId] : []);
  const lastInterruptAt = new Map<string, number>();
  let idleSince: number | null = null;
  let lastInterruptFailure: string | null = null;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    let turns;
    try {
      turns = await client.listTurns(state.threadId, 1001, Math.max(1, Math.min(3000, remaining)));
    } catch (error) {
      throw new AppError(
        'REMOTE_STATE_UNCERTAIN',
        `No se pudieron reconciliar los turnos durante el stop: ${errorMessage(error)}`,
        1,
        { cause: error },
      );
    }
    const byId = new Map(turns.map((turn) => [turn.turnId, turn]));
    const inProgress = turns.filter((turn) => turn.status === 'inProgress');
    for (const turn of inProgress) expected.add(turn.turnId);
    const interruptible = [...expected].filter((turnId) => {
      const turn = byId.get(turnId);
      return !turn || turn.status === 'inProgress';
    });
    if (interruptible.length > 0) {
      idleSince = null;
      for (const turnId of interruptible) {
        state.activeTurnId = turnId;
        if (!state.observedTurnIds.includes(turnId) && state.observedTurnIds.length < 1000) {
          state.observedTurnIds.push(turnId);
          state.turnCount = state.observedTurnIds.length;
          await saveRun(state);
        }
        if (Date.now() - (lastInterruptAt.get(turnId) ?? 0) < 500) continue;
        lastInterruptAt.set(turnId, Date.now());
        try {
          await client.interrupt(
            state.threadId,
            turnId,
            Math.max(1, Math.min(3000, deadline - Date.now())),
          );
          lastInterruptFailure = null;
        } catch (error) {
          lastInterruptFailure = errorMessage(error);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    if ([...expected].some((turnId) => !byId.has(turnId))) {
      idleSince = null;
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    let snapshot;
    try {
      snapshot = await client.readThread(state.threadId, Math.max(1, Math.min(3000, deadline - Date.now())));
    } catch (error) {
      throw new AppError(
        'REMOTE_STATE_UNCERTAIN',
        `No se pudo confirmar el estado del thread durante el stop: ${errorMessage(error)}`,
        1,
        { cause: error },
      );
    }
    if (threadIsIdle(snapshot.status)) {
      idleSince ??= Date.now();
      if (Date.now() - idleSince >= 250) {
        state.activeTurnId = null;
        return;
      }
    } else if (!threadIsActive(snapshot.status)) {
      throw new AppError('REMOTE_STATE_UNCERTAIN', 'El thread no alcanzo el estado idle durante el stop.');
    } else {
      idleSince = null;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new AppError(
    'REMOTE_STATE_UNCERTAIN',
    `El thread siguio activo o ambiguo tras detener sus turnos${lastInterruptFailure ? `: ${lastInterruptFailure}` : '.'}`,
  );
}

async function pauseForAbort(client: CodexDesktopClient, state: RunState): Promise<void> {
  const failures: string[] = [];
  if (!state.threadId) return;
  let current: GoalInfo | null;
  try {
    current = await client.getGoal(state.threadId);
  } catch (error) {
    throw new AppError('REMOTE_STATE_UNCERTAIN', `No se pudo confirmar la propiedad del Goal: ${errorMessage(error)}`, 1, { cause: error });
  }
  if (!current) {
    state.nativeGoalStatus = null;
    if (state.activeTurnId) {
      throw new AppError('REMOTE_STATE_UNCERTAIN', 'El Goal desaparecio mientras habia un turno local activo; no se interrumpira sin propiedad confirmada.');
    }
    const turns = await client.listTurns(state.threadId, 1001, 15_000);
    const snapshot = await client.readThread(state.threadId, 15_000);
    if (turns.some((turn) => turn.status === 'inProgress') || !threadIsIdle(snapshot.status)) {
      throw new AppError(
        'REMOTE_STATE_UNCERTAIN',
        'El Goal desaparecio pero el thread conserva actividad remota; no se interrumpira sin propiedad confirmada.',
      );
    }
    await client.prepareThreadForTerminal(state.threadId);
    return;
  }
  captureGoalIdentity(state, current);
  state.totalTokens = Math.max(state.totalTokens, current.tokensUsed);
  if (current.status === 'active') {
    try {
      const paused = await client.setGoal(state.threadId, undefined, 'paused');
      captureGoalIdentity(state, paused);
      state.nativeGoalStatus = paused.status;
      state.totalTokens = Math.max(state.totalTokens, paused.tokensUsed);
      if (paused.status !== 'paused') failures.push(`Goal remoto quedo ${paused.status}`);
    } catch (error) {
      failures.push(`no se pudo pausar el Goal: ${errorMessage(error)}`);
    }
  } else {
    state.nativeGoalStatus = current.status;
  }
  try {
    await drainTurnsAndConfirm(client, state);
  } catch (error) {
    failures.push(`no se pudo reconciliar turnos al pausar: ${errorMessage(error)}`);
  }
  try {
    await client.prepareThreadForTerminal(state.threadId);
  } catch (error) {
    failures.push(`no se pudo restaurar la politica segura: ${errorMessage(error)}`);
  }
  if (failures.length === 0) state.activeTurnId = null;
  if (failures.length > 0) {
    throw new AppError('REMOTE_STATE_UNCERTAIN', failures.join(' '));
  }
}

async function stopAfterFailure(client: CodexDesktopClient, state: RunState): Promise<void> {
  if (!state.threadId) return;
  const failures: string[] = [];
  try {
    const current = await client.getGoal(state.threadId);
    if (!current) {
      state.nativeGoalStatus = null;
    } else {
      captureGoalIdentity(state, current);
      state.totalTokens = Math.max(state.totalTokens, current.tokensUsed);
      if (current.status === 'active' || current.status === 'paused') {
        const blocked = await client.setGoal(state.threadId, undefined, 'blocked');
        captureGoalIdentity(state, blocked);
        state.nativeGoalStatus = blocked.status;
        state.totalTokens = Math.max(state.totalTokens, blocked.tokensUsed);
      } else {
        state.nativeGoalStatus = current.status;
      }
    }
  } catch (error) {
    failures.push(`Goal: ${errorMessage(error)}`);
  }
  try {
    await drainTurnsAndConfirm(client, state);
  } catch (error) {
    failures.push(`turno: ${errorMessage(error)}`);
  }
  try {
    await client.prepareThreadForTerminal(state.threadId);
  } catch (error) {
    failures.push(`politica: ${errorMessage(error)}`);
  }
  if (failures.length > 0) {
    throw new AppError('REMOTE_STATE_UNCERTAIN', failures.join(' '));
  }
}

async function finishBlocked(
  client: CodexDesktopClient,
  state: RunState,
  reason: string,
  remoteAlreadyBlocked = false,
): Promise<RunState> {
  state.goalActivationPending = false;
  const failures: string[] = [];
  try {
    if (!remoteAlreadyBlocked) await setRemoteStatus(client, state, 'blocked');
    else state.nativeGoalStatus = 'blocked';
  } catch (error) {
    failures.push(`Goal: ${errorMessage(error)}`);
  }
  try {
    await drainTurnsAndConfirm(client, state);
  } catch (error) {
    failures.push(`turno: ${errorMessage(error)}`);
  }
  try {
    await client.prepareThreadForTerminal(state.threadId!);
  } catch (error) {
    failures.push(`politica: ${errorMessage(error)}`);
  }
  if (failures.length > 0) throw new AppError('REMOTE_STATE_UNCERTAIN', failures.join(' '));
  await persistStatus(state, 'blocked', reason);
  return state;
}

async function finishBudget(
  client: CodexDesktopClient,
  state: RunState,
  reason: string,
  nativeStatus: 'budgetLimited' | 'usageLimited' = 'budgetLimited',
  remoteAlreadyTerminal = false,
): Promise<RunState> {
  state.goalActivationPending = false;
  const failures: string[] = [];
  try {
    if (!remoteAlreadyTerminal) await setRemoteStatus(client, state, nativeStatus);
    else state.nativeGoalStatus = nativeStatus;
  } catch (error) {
    failures.push(`Goal: ${errorMessage(error)}`);
  }
  try {
    await drainTurnsAndConfirm(client, state);
  } catch (error) {
    failures.push(`turno: ${errorMessage(error)}`);
  }
  try {
    await client.prepareThreadForTerminal(state.threadId!);
  } catch (error) {
    failures.push(`politica: ${errorMessage(error)}`);
  }
  if (failures.length > 0) throw new AppError('REMOTE_STATE_UNCERTAIN', failures.join(' '));
  await persistStatus(state, 'budgetLimited', reason);
  return state;
}

async function updateGoalSnapshot(state: RunState, goal: GoalInfo): Promise<void> {
  captureGoalIdentity(state, goal);
  const statusChanged = state.nativeGoalStatus !== goal.status;
  state.nativeGoalStatus = goal.status;
  state.totalTokens = Math.max(state.totalTokens, goal.tokensUsed);
  await saveRun(state);
  if (statusChanged) {
    await appendRunEvent(state.runId, 'goal_status', {
      threadId: state.threadId,
      status: goal.status,
      totalTokens: state.totalTokens,
    });
  }
}

async function reconcileTurns(
  client: CodexDesktopClient,
  state: RunState,
  activationWasPending: boolean,
  goalWasMissing: boolean,
): Promise<string | null> {
  const previouslyActive = state.activeTurnId;
  const previouslyObserved = new Set(state.observedTurnIds);
  const previousLastTurn = state.lastTurn;
  const previousBlockingEvidence = state.blockingEvidence;
  const previousLastTurnId = previousLastTurn?.turnId ?? null;
  const turns = await client.listTurns(state.threadId!, state.maxTurns + 1);
  const durableTurnIds = new Set(turns.map((turn) => turn.turnId));
  const missingObserved = state.observedTurnIds.filter((turnId) => !durableTurnIds.has(turnId));
  const newlyDiscovered = turns.filter((turn) => !previouslyObserved.has(turn.turnId));
  for (const turn of turns) {
    if (!state.observedTurnIds.includes(turn.turnId) && state.observedTurnIds.length < state.maxTurns) {
      state.observedTurnIds.push(turn.turnId);
    }
  }
  state.turnCount = state.observedTurnIds.length;
  const latest = turns.at(-1) ?? null;
  if (latest) {
    const blockedReason = latest.blockedReason
      ?? (previousLastTurn?.turnId === latest.turnId ? previousLastTurn.blockedReason : null);
    state.lastTurn = {
      turnId: latest.turnId,
      status: latest.status,
      error: latest.error === null ? null : sanitizeLog(latest.error, 4000),
      failedItems: [],
      blockedReason: blockedReason === null ? null : sanitizeLog(blockedReason, 4000),
    };
  }
  const inProgress = turns.filter((turn) => turn.status === 'inProgress');
  state.activeTurnId = inProgress.at(-1)?.turnId ?? null;
  state.goalActivationPending = false;
  if (goalWasMissing && turns.length > 0) {
    return 'El Goal durable no existe pero el thread conserva turnos; no se creara otro automaticamente.';
  }
  if (missingObserved.length > 0 || (previousLastTurnId !== null && !durableTurnIds.has(previousLastTurnId))) {
    return 'El historial durable ya no contiene todos los turnos guardados; no se usara evidencia local obsoleta.';
  }
  if (previousBlockingEvidence && !state.acknowledgedBlockingTurnIds.includes(previousBlockingEvidence.turnId)
    && !durableTurnIds.has(previousBlockingEvidence.turnId)) {
    return 'El turno asociado a la evidencia de bloqueo ya no existe en el historial durable.';
  }
  const acknowledgedBlockingTurns = new Set(state.acknowledgedBlockingTurnIds);
  const durableBlockedTurn = turns.find((turn) => !acknowledgedBlockingTurns.has(turn.turnId)
    && typeof turn.blockedReason === 'string' && turn.blockedReason.length > 0);
  const localBlockedTurn = previousLastTurn?.blockedReason && durableTurnIds.has(previousLastTurn.turnId)
    && !acknowledgedBlockingTurns.has(previousLastTurn.turnId)
    ? previousLastTurn
    : null;
  const unacknowledgedEvidence = previousBlockingEvidence
    && !acknowledgedBlockingTurns.has(previousBlockingEvidence.turnId)
    ? previousBlockingEvidence
    : null;
  if (unacknowledgedEvidence || durableBlockedTurn || localBlockedTurn) {
    const blockedTurn = unacknowledgedEvidence
      ? turns.find((turn) => turn.turnId === unacknowledgedEvidence.turnId)!
      : durableBlockedTurn ?? localBlockedTurn!;
    const reason = unacknowledgedEvidence?.reason ?? blockedTurn.blockedReason!;
    const durableMatch = turns.find((turn) => turn.turnId === blockedTurn.turnId);
    state.blockingEvidence ??= {
      turnId: blockedTurn.turnId,
      reason: sanitizeLog(reason, 4000),
      recordedAt: new Date().toISOString(),
    };
    state.lastTurn = {
      turnId: blockedTurn.turnId,
      status: durableMatch?.status ?? blockedTurn.status,
      error: durableMatch?.error ?? blockedTurn.error,
      failedItems: localBlockedTurn?.turnId === blockedTurn.turnId ? localBlockedTurn.failedItems : [],
      blockedReason: sanitizeLog(reason, 4000),
    };
    await saveRun(state);
    return `El turno ${blockedTurn.turnId} conserva una interaccion no disponible (solicitud de autoridad): ${reason}`;
  }
  if (previouslyActive && !turns.some((turn) => turn.turnId === previouslyActive)) {
    return 'El turno activo guardado no existe en el historial durable; no se reactivara el Goal.';
  }
  if (inProgress.length > 0) return 'Existe un turno previo inProgress tras reanudar; fue detenido para evitar duplicar acciones.';
  const unsafeRecoveredTurn = turns.find((turn) => !state.acknowledgedBlockingTurnIds.includes(turn.turnId)
    && (turn.status === 'failed' || turn.status === 'interrupted'));
  if (unsafeRecoveredTurn) {
    const reason = `El turno durable recuperado ${unsafeRecoveredTurn.turnId} termino ${unsafeRecoveredTurn.status}; se requiere revision antes de reactivar el Goal.`;
    state.blockingEvidence = {
      turnId: unsafeRecoveredTurn.turnId,
      reason,
      recordedAt: new Date().toISOString(),
    };
    state.lastTurn = {
      turnId: unsafeRecoveredTurn.turnId,
      status: unsafeRecoveredTurn.status,
      error: unsafeRecoveredTurn.error,
      failedItems: [],
      blockedReason: reason,
    };
    await saveRun(state);
    return reason;
  }
  if (activationWasPending && newlyDiscovered.length === 0) {
    return 'La activacion anterior quedo sin un turno durable nuevo; no se reactivara automaticamente.';
  }
  await saveRun(state);
  await appendRunEvent(state.runId, 'turns_reconciled', {
    threadId: state.threadId,
    persistedTurns: turns.length,
    observedTurns: state.turnCount,
    activeTurnId: state.activeTurnId,
  });
  return null;
}

function completionTurnIssue(state: RunState): string | null {
  if (state.activeTurnId) return 'El Goal declaro complete con un turno todavia activo.';
  if (state.blockingEvidence) return `El Goal solicito una interaccion no disponible: ${state.blockingEvidence.reason}`;
  if (!state.lastTurn) return 'El Goal declaro complete sin un turno durable asociado.';
  if (state.lastTurn.blockedReason) return `El Goal solicito una interaccion no disponible: ${state.lastTurn.blockedReason}`;
  if (state.lastTurn.status !== 'completed') return `El Goal declaro complete pero el ultimo turno termino ${state.lastTurn.status}.`;
  if (state.lastTurn.error) return `El Goal declaro complete pero el ultimo turno registro un error: ${state.lastTurn.error}`;
  return null;
}

function completionResourceIssue(state: RunState): string | null {
  if (elapsedMs(state) >= state.maxWallTimeMs) return 'El Goal termino despues del limite total de tiempo.';
  const tokenBudget = state.goalTokenBudget ?? state.tokenBudget;
  if (tokenBudget !== null && state.totalTokens >= tokenBudget) {
    return `El Goal alcanzo o excedio el presupuesto de ${tokenBudget} tokens.`;
  }
  return null;
}

async function observeGoal(
  client: CodexDesktopClient,
  state: RunState,
  signal: AbortSignal,
  objective?: string,
): Promise<NativeGoalResult> {
  const remainingTurns = state.maxTurns - state.turnCount;
  if (remainingTurns < 1) throw new AppError('GOAL_BUDGET_EXHAUSTED', `Se alcanzo el limite de ${state.maxTurns} turnos.`);
  state.goalActivationPending = true;
  await persistStatus(state, 'running');
  await appendRunEvent(state.runId, 'goal_activation_intent', { threadId: state.threadId, remainingTurns });

  return client.runNativeGoal({
    threadId: state.threadId!,
    ...(objective !== undefined ? { objective } : {}),
    ...(state.tokenBudget !== null ? { tokenBudget: state.tokenBudget } : {}),
    timeoutMs: Math.max(1, state.maxWallTimeMs - elapsedMs(state)),
    turnTimeoutMs: state.turnTimeoutMs,
    maxTurns: remainingTurns,
    signal,
    onActivated: async (goal) => {
      state.goalActivationPending = false;
      await updateGoalSnapshot(state, goal);
      await appendRunEvent(state.runId, 'goal_activated', { threadId: state.threadId });
    },
    onGoalUpdated: async (goal) => updateGoalSnapshot(state, goal),
    onTurnStarted: async (turnId) => {
      state.activeTurnId = turnId;
      if (!state.observedTurnIds.includes(turnId) && state.observedTurnIds.length < state.maxTurns) {
        state.observedTurnIds.push(turnId);
        state.turnCount = state.observedTurnIds.length;
      }
      await saveRun(state);
      await appendRunEvent(state.runId, 'turn_started', {
        threadId: state.threadId,
        turnId,
        turnCount: state.turnCount,
      });
    },
    onBlockedEvidence: async (reason, turnId) => {
      state.activeTurnId = turnId;
      if (!state.observedTurnIds.includes(turnId) && state.observedTurnIds.length < state.maxTurns) {
        state.observedTurnIds.push(turnId);
        state.turnCount = state.observedTurnIds.length;
      }
      state.blockingEvidence ??= {
        turnId,
        reason: sanitizeLog(reason, 4000),
        recordedAt: new Date().toISOString(),
      };
      const previous = state.lastTurn?.turnId === turnId ? state.lastTurn : null;
      state.lastTurn = {
        turnId,
        status: 'inProgress',
        error: previous?.error ?? null,
        failedItems: previous?.failedItems ?? [],
        blockedReason: sanitizeLog(reason, 4000),
      };
      await saveRun(state);
      await appendRunEvent(state.runId, 'blocked_evidence', {
        threadId: state.threadId,
        turnId,
        reason: state.blockingEvidence.reason,
      });
    },
    onTurnCompleted: async (turn) => {
      state.activeTurnId = null;
      state.lastTurn = turnRecord(turn);
      state.totalTokens = Math.max(state.totalTokens, turn.totalTokens);
      await saveRun(state);
      await appendRunEvent(state.runId, 'turn_completed', {
        threadId: state.threadId,
        turnId: turn.turnId,
        status: turn.status,
        totalTokens: state.totalTokens,
        failedItems: state.lastTurn.failedItems.length,
        blockedReason: turn.blockedReason,
      });
    },
  });
}

async function verifyCompletedGoal(
  client: CodexDesktopClient,
  state: RunState,
  signal: AbortSignal,
): Promise<boolean> {
  await persistStatus(state, 'verifying');
  await client.prepareThreadForTerminal(
    state.threadId!,
    Math.max(1, Math.min(15_000, state.maxWallTimeMs - elapsedMs(state))),
  );
  if (signal.aborted || completionResourceIssue(state)) return false;
  const quiescentGoal = await client.getGoal(
    state.threadId!,
    Math.max(1, Math.min(30_000, state.maxWallTimeMs - elapsedMs(state))),
  );
  const quiescentThread = await client.readThread(
    state.threadId!,
    Math.max(1, Math.min(30_000, state.maxWallTimeMs - elapsedMs(state))),
  );
  if (!quiescentGoal || quiescentGoal.status !== 'complete' || !threadIsIdle(quiescentThread.status)) {
    throw new AppError('GOAL_NOT_COMPLETE', 'El Goal o su thread no quedaron estables antes de la verificacion final.');
  }
  captureGoalIdentity(state, quiescentGoal);
  state.totalTokens = Math.max(state.totalTokens, quiescentGoal.tokensUsed);
  if (signal.aborted || completionResourceIssue(state)) return false;
  const verification = await verifyWorkspace(
    state.workspace,
    state.verifyCommands,
    Math.max(1, Math.min(15 * 60_000, state.maxWallTimeMs - elapsedMs(state))),
    signal,
  );
  state.verificationAttempts += 1;
  state.lastVerification = { ...verification, summary: boundedVerificationSummary(verification.summary) };
  await saveRun(state);
  await appendRunEvent(state.runId, 'verification', {
    attempt: state.verificationAttempts,
    ok: verification.ok,
    checks: state.lastVerification.summary.map((line) => line.split('\n', 1)[0]),
  });
  if (!verification.ok) return false;
  if (signal.aborted || completionResourceIssue(state)) return false;
  let currentGoal: GoalInfo | null;
  let confirmed: GoalInfo | null;
  try {
    currentGoal = await client.getGoal(
      state.threadId!,
      Math.max(1, Math.min(30_000, state.maxWallTimeMs - elapsedMs(state))),
    );
    if (currentGoal) {
      captureGoalIdentity(state, currentGoal);
      state.totalTokens = Math.max(state.totalTokens, currentGoal.tokensUsed);
    }
    if (signal.aborted || completionResourceIssue(state)) return false;
    if (!currentGoal || currentGoal.status !== 'complete') {
      throw new AppError('GOAL_NOT_COMPLETE', 'El Goal dejo de estar complete durante la verificacion independiente.');
    }
    confirmed = await client.getGoal(
      state.threadId!,
      Math.max(1, Math.min(30_000, state.maxWallTimeMs - elapsedMs(state))),
    );
  } catch (error) {
    if (signal.aborted || completionResourceIssue(state)) return false;
    throw error;
  }
  if (!confirmed) throw new AppError('GOAL_NOT_COMPLETE', 'Codex Desktop perdio el Goal antes de persistir el resultado.');
  captureGoalIdentity(state, confirmed);
  state.totalTokens = Math.max(state.totalTokens, confirmed.tokensUsed);
  if (signal.aborted || completionResourceIssue(state)) return false;
  if (confirmed.status !== 'complete') throw new AppError('GOAL_NOT_COMPLETE', 'Codex Desktop dejo de confirmar el estado complete.');
  const finalGuard = await verifyWorkspace(
    state.workspace,
    [],
    Math.max(1, Math.min(2 * 60_000, state.maxWallTimeMs - elapsedMs(state))),
    signal,
  );
  if (!finalGuard.ok) {
    state.lastVerification = { ...finalGuard, summary: boundedVerificationSummary(finalGuard.summary) };
    await saveRun(state);
    await appendRunEvent(state.runId, 'verification_final_guard', {
      ok: false,
      checks: state.lastVerification.summary.map((line) => line.split('\n', 1)[0]),
    });
    return false;
  }
  const finalSnapshot = await currentGitSnapshot(
    state.workspace,
    Math.max(1, state.maxWallTimeMs - elapsedMs(state)),
    signal,
  );
  if (signal.aborted || completionResourceIssue(state)) return false;
  const finalGoal = await client.getGoal(
    state.threadId!,
    Math.max(1, Math.min(30_000, state.maxWallTimeMs - elapsedMs(state))),
  );
  const finalThread = await client.readThread(
    state.threadId!,
    Math.max(1, Math.min(30_000, state.maxWallTimeMs - elapsedMs(state))),
  );
  if (!finalGoal || finalGoal.status !== 'complete' || !threadIsIdle(finalThread.status)) {
    throw new AppError('GOAL_NOT_COMPLETE', 'El Goal o su thread cambiaron durante la confirmacion final.');
  }
  captureGoalIdentity(state, finalGoal);
  state.totalTokens = Math.max(state.totalTokens, finalGoal.tokensUsed);
  if (signal.aborted || completionResourceIssue(state)) return false;
  state.gitFinal = finalSnapshot;
  state.nativeGoalStatus = finalGoal.status;
  await persistStatus(state, 'completed');
  return true;
}

export async function supervise(client: CodexDesktopClient, state: RunState, logger: Logger, options: SuperviseOptions): Promise<RunState> {
  try {
    if (options.signal.aborted && !options.resume) {
      if (state.threadId) {
        try {
          await pauseForAbort(client, state);
        } catch (pauseError) {
          const message = `No se pudo confirmar la pausa remota: ${errorMessage(pauseError)}`;
          await persistStatus(state, 'failed', message);
          return state;
        }
      }
      await persistStatus(state, 'paused', 'Ejecucion interrumpida por el usuario.');
      return state;
    }

    let initialObjectiveRequired = false;
    if (options.resume) {
      if (!state.threadId) throw new AppError('RUN_NOT_STARTED', 'La ejecucion guardada no tiene thread de Codex Desktop.');
      const snapshot = await client.readThread(state.threadId);
      if (!samePath(snapshot.cwd, state.workspace)) throw new AppError('WORKSPACE_MISMATCH', 'El thread persistido pertenece a otro workspace.');
      if (!threadIsActive(snapshot.status) && !threadIsIdle(snapshot.status)
        && (snapshot.status as { type?: unknown }).type !== 'notLoaded') {
        await persistStatus(state, 'blocked', 'El thread de Codex Desktop no esta disponible para reanudacion segura.');
        return state;
      }
      let existingGoal = await client.getGoal(state.threadId);
      const goalWasMissing = existingGoal === null;
      const hasPriorGoalEvidence = state.nativeGoalStatus !== null
        || state.nativeGoalCreatedAt !== null
        || state.observedTurnIds.length > 0
        || state.lastTurn !== null;
      if (existingGoal) {
        try {
          captureGoalIdentity(state, existingGoal);
        } catch (error) {
          await persistStatus(state, 'blocked', errorMessage(error));
          return state;
        }
      }
      const canOwnActiveThread = existingGoal !== null && (hasPriorGoalEvidence || state.goalActivationPending);
      if (threadIsActive(snapshot.status) && !canOwnActiveThread) {
        await persistStatus(state, 'blocked', 'El thread tiene actividad sin evidencia suficiente de propiedad; no se modifico.');
        return state;
      }
      if (!existingGoal && hasPriorGoalEvidence) {
        await persistStatus(state, 'blocked', 'El Goal durable desaparecio despues de haber iniciado; no se creara otro automaticamente.');
        return state;
      }
      const resumedThread = await client.resumeThread(state.threadId, state.workspace, state.model ?? undefined);
      if (!samePath(resumedThread.cwd, state.workspace)) {
        throw new AppError('WORKSPACE_MISMATCH', 'El thread persistido pertenece a otro workspace.');
      }
      if (!threadIsActive(resumedThread.status) && !threadIsIdle(resumedThread.status)) {
        await persistStatus(state, 'blocked', 'Codex Desktop no cargo el thread en un estado seguro.');
        return state;
      }
      if (options.signal.aborted) {
        await pauseForAbort(client, state);
        await persistStatus(state, 'paused', 'Ejecucion interrumpida por el usuario.');
        return state;
      }
      const resumableBlockingReason = blockingReason(state);
      const resumableBlockingTurnId = state.blockingEvidence?.turnId
        ?? (state.lastTurn?.blockedReason ? state.lastTurn.turnId : null);
      const resumableStoppedTurnId = (state.status === 'blocked' || state.status === 'paused')
        && (state.lastTurn?.status === 'failed' || state.lastTurn?.status === 'interrupted')
        ? state.lastTurn.turnId
        : null;
      const acknowledgedTurnId = resumableBlockingTurnId ?? resumableStoppedTurnId;
      if ((state.status === 'blocked' || state.status === 'paused') && acknowledgedTurnId
        && threadIsIdle(resumedThread.status)) {
        await appendRunEvent(state.runId, 'blocking_evidence_acknowledged', {
          threadId: state.threadId,
          turnId: acknowledgedTurnId,
          reason: resumableBlockingReason ?? state.lastTurn?.status ?? 'explicit_resume',
        });
        if (!state.acknowledgedBlockingTurnIds.includes(acknowledgedTurnId)) {
          if (state.acknowledgedBlockingTurnIds.length >= 1000) {
            throw new AppError('ACKNOWLEDGEMENT_LIMIT', 'Se alcanzo el limite de evidencias de bloqueo reconocidas.');
          }
          state.acknowledgedBlockingTurnIds.push(acknowledgedTurnId);
        }
        if (state.blockingEvidence?.turnId === acknowledgedTurnId) state.blockingEvidence = null;
        if (state.lastTurn?.turnId === acknowledgedTurnId) state.lastTurn.blockedReason = null;
        await saveRun(state);
      }
      if (blockingReason(state)) {
        return finishBlocked(
          client,
          state,
          `Se recupero evidencia durable de bloqueo: ${blockingReason(state)}`,
          existingGoal?.status === 'blocked',
        );
      }
      if (threadIsActive(snapshot.status) || threadIsActive(resumedThread.status)) {
        if (!existingGoal) throw new AppError('REMOTE_STATE_UNCERTAIN', 'El thread activo propio perdio su Goal durante la reanudacion.');
        if (existingGoal.status === 'active') {
          existingGoal = await client.setGoal(state.threadId, undefined, 'paused');
          captureGoalIdentity(state, existingGoal);
        }
        await drainTurnsAndConfirm(client, state);
        await client.prepareThreadForTerminal(state.threadId);
        state.goalActivationPending = false;
        if (existingGoal.status === 'paused') {
          state.nativeGoalStatus = 'paused';
          await persistStatus(state, 'paused', 'Se completo una pausa pendiente recuperada tras un crash.');
          return state;
        }
        if (existingGoal.status === 'blocked') {
          state.nativeGoalStatus = 'blocked';
          await persistStatus(state, 'blocked', 'Se completo un bloqueo pendiente recuperado tras un crash.');
          return state;
        }
        if (existingGoal.status === 'budgetLimited' || (existingGoal.status === 'usageLimited' && !options.resume)) {
          return finishBudget(
            client,
            state,
            'Se completo una detencion por limite pendiente recuperada tras un crash.',
            existingGoal.status,
            true,
          );
        }
      }
      const activationWasPending = state.goalActivationPending && existingGoal !== null;
      if (existingGoal?.status === 'active') {
        const latestSnapshot = await client.readThread(state.threadId);
        if (threadIsActive(latestSnapshot.status)) {
          return finishBlocked(
            client,
            state,
            'El Goal propio se activo durante la reanudacion y fue detenido para evitar trabajo duplicado.',
          );
        }
        if (!threadIsIdle(latestSnapshot.status)) {
          return finishBlocked(client, state, 'El thread dejo de estar disponible durante la reanudacion.');
        }
        existingGoal = await client.setGoal(state.threadId, undefined, 'paused');
        captureGoalIdentity(state, existingGoal);
      }
      const reconciliationIssue = await reconcileTurns(client, state, activationWasPending, goalWasMissing);
      if (reconciliationIssue) return finishBlocked(client, state, reconciliationIssue);
      initialObjectiveRequired = existingGoal === null;
      await appendRunEvent(state.runId, 'resumed', { threadId: state.threadId });
    } else {
      const thread = await client.startThread(state.workspace, state.model ?? undefined);
      state.threadId = thread.id;
      if (!samePath(thread.cwd, state.workspace)) throw new AppError('WORKSPACE_MISMATCH', 'Codex Desktop creo el thread en otro workspace.');
      initialObjectiveRequired = true;
      await saveRun(state);
      await client.setThreadName(thread.id, state.name);
      await appendRunEvent(state.runId, 'thread_started', { threadId: thread.id });
    }

    await client.configureThread({
      threadId: state.threadId!,
      workspace: state.workspace,
      network: state.network,
      dangerFullAccess: state.dangerFullAccess,
      ...(state.model ? { model: state.model } : {}),
      ...(state.effort ? { effort: state.effort } : {}),
    });

    let goal = await client.getGoal(state.threadId!);
    if (goal) await updateGoalSnapshot(state, goal);
    if (goal?.status === 'usageLimited' && !options.resume) {
      return finishBudget(client, state, 'Codex Desktop alcanzo el limite de uso de la cuenta.', 'usageLimited', true);
    }
    if (goal?.status === 'budgetLimited') {
      return finishBudget(client, state, 'Codex Desktop alcanzo el presupuesto nativo de Goal.', 'budgetLimited', true);
    }
    let shouldActivate = goal?.status !== 'complete';

    while (true) {
      if (options.signal.aborted) {
        await pauseForAbort(client, state);
        await persistStatus(state, 'paused', 'Ejecucion interrumpida por el usuario.');
        return state;
      }
      const exhausted = goal?.status === 'complete' ? completionResourceIssue(state) : budgetReason(state);
      if (exhausted) return finishBudget(client, state, exhausted);

      if (shouldActivate) {
        await client.configureThread({
          threadId: state.threadId!,
          workspace: state.workspace,
          network: state.network,
          dangerFullAccess: state.dangerFullAccess,
          ...(state.model ? { model: state.model } : {}),
          ...(state.effort ? { effort: state.effort } : {}),
        });
        const result = await observeGoal(
          client,
          state,
          options.signal,
          initialObjectiveRequired ? state.objective : undefined,
        );
        initialObjectiveRequired = false;
        state.goalActivationPending = false;
        state.activeTurnId = result.activeTurnId;
        goal = result.goal;
        await updateGoalSnapshot(state, goal);
        shouldActivate = false;

        if (blockingReason(state)) {
          return finishBlocked(
            client,
            state,
            `El Goal requiere una interaccion no disponible: ${blockingReason(state)}`,
            goal.status === 'blocked',
          );
        }
        if (result.stopReason === 'signal') {
          await pauseForAbort(client, state);
          await persistStatus(state, 'paused', 'Ejecucion interrumpida por el usuario.');
          return state;
        }
        if (result.stopReason === 'wall_timeout' || result.stopReason === 'max_turns') {
          return finishBudget(
            client,
            state,
            budgetReason(state) ?? 'El supervisor alcanzo un limite de ejecucion.',
            'budgetLimited',
            goal.status === 'budgetLimited',
          );
        }
        if (result.stopReason === 'turn_timeout') {
          return finishBlocked(client, state, 'El turno excedio el tiempo limite y fue interrumpido.');
        }
        if (result.stopReason === 'interaction_required') {
          return finishBlocked(
            client,
            state,
            'El Goal requiere una interaccion no disponible en modo desatendido.',
            goal.status === 'blocked',
          );
        }
        if (goal.status === 'blocked') return finishBlocked(client, state, 'Codex marco el Goal como bloqueado.', true);
        if (goal.status === 'usageLimited') {
          return finishBudget(client, state, 'Codex Desktop alcanzo el limite de uso de la cuenta.', 'usageLimited', true);
        }
        if (goal.status === 'budgetLimited') {
          return finishBudget(client, state, 'Codex Desktop alcanzo el presupuesto nativo de Goal.', 'budgetLimited', true);
        }
        if (goal.status === 'paused') {
          await drainTurnsAndConfirm(client, state);
          await client.prepareThreadForTerminal(state.threadId!);
          await persistStatus(state, 'paused', 'Codex Desktop pauso el Goal.');
          return state;
        }
        if (goal.status !== 'complete') throw new AppError('INVALID_GOAL_STATE', `Estado inesperado del Goal: ${goal.status}`);
      }

      if (!goal || goal.status !== 'complete') throw new AppError('GOAL_NOT_COMPLETE', 'El Goal no alcanzo un estado terminal verificable.');
      const turnIssue = completionTurnIssue(state);
      if (turnIssue) return finishBlocked(client, state, turnIssue);
      const resourceIssue = completionResourceIssue(state);
      if (resourceIssue) return finishBudget(client, state, resourceIssue);
      if (await verifyCompletedGoal(client, state, options.signal)) return state;
      if (options.signal.aborted) {
        await pauseForAbort(client, state);
        await persistStatus(state, 'paused', 'Ejecucion interrumpida durante la verificacion.');
        return state;
      }
      const afterVerificationBudget = budgetReason(state);
      if (afterVerificationBudget) return finishBudget(client, state, afterVerificationBudget);
      await client.injectText(state.threadId!, verificationFeedback(state));
      await persistStatus(state, 'running', 'La verificacion del host fallo; Codex continuara corrigiendo.');
      shouldActivate = true;
    }
  } catch (error) {
    const original = errorMessage(error);
    let stopFailure: string | null = null;
    const hostProcessUncertain = error instanceof AppError && error.code === 'HOST_PROCESS_UNCERTAIN';
    if (state.threadId && blockingReason(state) && !hostProcessUncertain) {
      try {
        return await finishBlocked(
          client,
          state,
          `La ejecucion conservo evidencia de bloqueo: ${blockingReason(state)}`,
          state.nativeGoalStatus === 'blocked',
        );
      } catch (blockedStopError) {
        stopFailure = errorMessage(blockedStopError);
      }
    }
    if (options.signal.aborted && !hostProcessUncertain) {
      try {
        await pauseForAbort(client, state);
        state.goalActivationPending = false;
        await persistStatus(state, 'paused', 'Ejecucion interrumpida por el usuario.');
        return state;
      } catch (pauseError) {
        const message = `Ejecucion interrumpida, pero el estado remoto es incierto: ${errorMessage(pauseError)}`;
        await persistStatus(state, 'failed', message).catch(() => undefined);
        throw new AppError('REMOTE_STATE_UNCERTAIN', message, 1, { cause: pauseError });
      }
    }
    if (state.threadId) {
      try {
        await stopAfterFailure(client, state);
        state.goalActivationPending = false;
      } catch (stopError) {
        stopFailure = errorMessage(stopError);
        logger.error(`No se pudo detener el Goal tras el fallo: ${stopFailure}`);
      }
    } else {
      state.goalActivationPending = false;
    }
    const message = stopFailure ? `${original} Estado remoto incierto: ${stopFailure}` : original;
    await persistStatus(state, 'failed', message).catch(() => undefined);
    if (stopFailure) throw new AppError('REMOTE_STATE_UNCERTAIN', message, 1, { cause: error });
    throw error;
  }
}
