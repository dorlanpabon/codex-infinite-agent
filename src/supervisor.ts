import path from 'node:path';
import { validateAttachmentPaths } from './attachments.js';
import { AppError, errorMessage } from './errors.js';
import { currentGitSnapshot } from './git.js';
import { sanitizeLog, type Logger } from './log.js';
import { appendRunEvent, saveRun, type NativeTurnRecord, type RunState, type RunStatus } from './state.js';
import { verifyWorkspace } from './verify.js';
import type { CodexDesktopClient, GoalInfo, GoalStatus, NativeGoalResult, PersistedTurn, TurnResult } from './app-server/client.js';

export interface SuperviseOptions {
  resume: boolean;
  adopting?: boolean;
  adoptingGoalMissing?: boolean;
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

function isUnownedActivityError(error: unknown): error is AppError {
  return error instanceof AppError && error.code === 'UNOWNED_THREAD_ACTIVITY';
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
  if (goal.objective !== state.goalObjective || identityMismatch || requestedBudgetMismatch) {
    throw new AppError(
      'GOAL_OWNERSHIP_MISMATCH',
      'El Goal persistido cambio de objetivo o presupuesto fuera de esta corrida; no se modificara.',
    );
  }
}

export function initialContextText(state: Pick<RunState, 'objective' | 'attachments'>): string {
  const files = state.attachments.length === 0
    ? 'Ninguno.'
    : state.attachments.map((attachment) => `- ${JSON.stringify(attachment)}`).join('\n');
  return [
    'CONTEXTO INICIAL AUTORITATIVO DE CODEX INFINITE',
    '',
    'OBJETIVO COMPLETO',
    state.objective,
    '',
    'ARCHIVOS ADJUNTOS',
    files,
    '',
    'Las rutas son absolutas. Lee cada archivo necesario con las herramientas del sistema antes de completar el objetivo.',
  ].join('\n');
}

async function injectInitialContext(client: CodexDesktopClient, state: RunState): Promise<void> {
  if (state.contextInjectionStatus === 'notRequired' || state.contextInjectionStatus === 'injected') return;
  if (state.contextInjectionStatus === 'pending') {
    throw new AppError(
      'CONTEXT_INJECTION_UNCERTAIN',
      'No se puede demostrar si el contexto inicial ya fue inyectado; no se repetira automaticamente.',
    );
  }
  if (state.attachments.length > 0) {
    const current = await validateAttachmentPaths(state.attachments);
    if (current.length !== state.attachments.length || current.some((entry, index) => entry !== state.attachments[index])) {
      throw new AppError('INVALID_ATTACHMENT', 'Los archivos adjuntos cambiaron mientras la sesion estaba ocupada; vuelve a seleccionarlos.');
    }
  }
  state.contextInjectionStatus = 'pending';
  await saveRun(state);
  await appendRunEvent(state.runId, 'context_injection_intent', {
    threadId: state.threadId,
    attachmentCount: state.attachments.length,
    objectiveCharacters: state.objective.length,
  });
  try {
    await client.injectText(state.threadId!, initialContextText(state));
  } catch (cause) {
    throw new AppError(
      'CONTEXT_INJECTION_UNCERTAIN',
      'No se pudo confirmar la inyeccion unica del contexto inicial; no se reintentara automaticamente.',
      1,
      { cause },
    );
  }
  state.contextInjectionStatus = 'injected';
  await saveRun(state);
  await appendRunEvent(state.runId, 'context_injected', {
    threadId: state.threadId,
    attachmentCount: state.attachments.length,
  });
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
  await assertTerminalMutationSafety(client, state);
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
  const ownedTurnId = state.activeTurnId;
  const expected = new Set<string>(ownedTurnId ? [ownedTurnId] : []);
  const lastInterruptAt = new Map<string, number>();
  let idleSince: number | null = null;
  let lastInterruptFailure: string | null = null;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    let turns;
    try {
      turns = await managedTurnsSinceBaseline(client, state, Math.max(1, Math.min(3000, remaining)));
    } catch (error) {
      if (isUnownedActivityError(error)) throw error;
      throw new AppError(
        'REMOTE_STATE_UNCERTAIN',
        `No se pudieron reconciliar los turnos durante el stop: ${errorMessage(error)}`,
        1,
        { cause: error },
      );
    }
    const byId = new Map(turns.map((turn) => [turn.turnId, turn]));
    const inProgress = turns.filter((turn) => turn.status === 'inProgress');
    const observedPrefixMatches = state.observedTurnIds.every(
      (turnId, index) => turns[index]?.turnId === turnId,
    );
    const unownedTurn = observedPrefixMatches
      ? turns.slice(state.observedTurnIds.length).find((turn) => turn.turnId !== ownedTurnId)
      : turns[0];
    if (unownedTurn) {
      throw new AppError(
        'UNOWNED_THREAD_ACTIVITY',
        `El turno ${unownedTurn.turnId} aparecio sin evidencia de propiedad; no se modificara ni se interrumpira.`,
      );
    }
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
  await assertTerminalMutationSafety(client, state);
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
    const turns = await managedTurnsSinceBaseline(client, state, 15_000);
    const snapshot = await client.readThread(state.threadId, 15_000);
    const observed = new Set(state.observedTurnIds);
    if (turns.some((turn) => turn.status === 'inProgress' || !observed.has(turn.turnId)) || !threadIsIdle(snapshot.status)) {
      throw new AppError(
        'REMOTE_STATE_UNCERTAIN',
        'El Goal desaparecio pero el thread conserva actividad remota; no se interrumpira sin propiedad confirmada.',
      );
    }
    await assertTerminalMutationSafety(client, state);
    await client.prepareThreadForTerminal(state.threadId);
    return;
  }
  captureGoalIdentity(state, current);
  state.totalTokens = Math.max(state.totalTokens, current.tokensUsed);
  if (current.status === 'active') {
    try {
      await assertTerminalMutationSafety(client, state);
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
    if (isUnownedActivityError(error)) throw error;
    failures.push(`no se pudo reconciliar turnos al pausar: ${errorMessage(error)}`);
  }
  try {
    await assertTerminalMutationSafety(client, state);
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
  await assertTerminalMutationSafety(client, state);
  const failures: string[] = [];
  try {
    const current = await client.getGoal(state.threadId);
    if (!current) {
      state.nativeGoalStatus = null;
    } else {
      captureGoalIdentity(state, current);
      state.totalTokens = Math.max(state.totalTokens, current.tokensUsed);
      if (current.status === 'active' || current.status === 'paused') {
        await assertTerminalMutationSafety(client, state);
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
    if (isUnownedActivityError(error)) throw error;
    failures.push(`turno: ${errorMessage(error)}`);
  }
  try {
    await assertTerminalMutationSafety(client, state);
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
  await assertTerminalMutationSafety(client, state);
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
    if (isUnownedActivityError(error)) throw error;
    failures.push(`turno: ${errorMessage(error)}`);
  }
  try {
    await assertTerminalMutationSafety(client, state);
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
  await assertTerminalMutationSafety(client, state);
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
    if (isUnownedActivityError(error)) throw error;
    failures.push(`turno: ${errorMessage(error)}`);
  }
  try {
    await assertTerminalMutationSafety(client, state);
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

const IN_PROGRESS_RECONCILIATION_ISSUE = 'Existe un turno previo inProgress tras reanudar; fue detenido para evitar duplicar acciones.';
const UNOWNED_IN_PROGRESS_RECONCILIATION_ISSUE = 'Se detecto un turno manual inProgress durante la reanudacion; no se modifico ni se interrumpio.';
type ReconciliationIssue = { kind: 'managed' | 'unowned'; reason: string };

function managedIssue(reason: string): ReconciliationIssue {
  return { kind: 'managed', reason };
}

function unownedIssue(reason: string): ReconciliationIssue {
  return { kind: 'unowned', reason };
}

async function managedTurnsSinceBaseline(
  client: CodexDesktopClient,
  state: RunState,
  timeoutMs = 15_000,
): Promise<PersistedTurn[]> {
  let turns: PersistedTurn[];
  try {
    turns = await client.listRecentTurns(
      state.threadId!,
      Math.min(2001, state.maxTurns + 2),
      timeoutMs,
    );
  } catch (error) {
    throw new AppError(
      'UNOWNED_THREAD_ACTIVITY',
      `No se pudo demostrar la propiedad del historial reciente; no se modificara: ${errorMessage(error)}`,
      1,
      { cause: error },
    );
  }
  if (state.turnBaselineId === null) return turns;
  const baselineIndex = turns.findIndex((turn) => turn.turnId === state.turnBaselineId);
  if (baselineIndex < 0) {
    throw new AppError(
      'UNOWNED_THREAD_ACTIVITY',
      'El historial reciente ya no contiene el limite durable previo a la adopcion; no se reclamaran turnos ambiguos.',
    );
  }
  return turns.slice(baselineIndex + 1);
}

async function activeTurnOwnershipIssue(client: CodexDesktopClient, state: RunState): Promise<string | null> {
  if (!state.activeTurnId) return UNOWNED_IN_PROGRESS_RECONCILIATION_ISSUE;
  try {
    const turns = await managedTurnsSinceBaseline(client, state, 15_000);
    const inProgress = turns.filter((turn) => turn.status === 'inProgress');
    const exactObservedSuffix = turns.length === state.observedTurnIds.length
      && turns.every((turn, index) => turn.turnId === state.observedTurnIds[index]);
    return exactObservedSuffix && inProgress.length === 1 && inProgress[0]!.turnId === state.activeTurnId
      ? null
      : UNOWNED_IN_PROGRESS_RECONCILIATION_ISSUE;
  } catch (error) {
    return `No se pudo demostrar la propiedad del turno activo; no se modifico: ${errorMessage(error)}`;
  }
}

async function unownedInProgressIssue(client: CodexDesktopClient, state: RunState): Promise<string | null> {
  try {
    const turns = await managedTurnsSinceBaseline(client, state, 15_000);
    return turns.some((turn) => turn.status === 'inProgress' && turn.turnId !== state.activeTurnId)
      ? UNOWNED_IN_PROGRESS_RECONCILIATION_ISSUE
      : null;
  } catch (error) {
    return `No se pudo confirmar la ausencia de actividad manual; no se modifico: ${errorMessage(error)}`;
  }
}

async function activationSafetyIssue(client: CodexDesktopClient, state: RunState): Promise<string | null> {
  const inspectTurns = async (): Promise<string | null> => {
    const turns = await managedTurnsSinceBaseline(client, state, 15_000);
    const exactObservedSuffix = turns.length === state.observedTurnIds.length
      && turns.every((turn, index) => turn.turnId === state.observedTurnIds[index]);
    return !exactObservedSuffix || turns.some((turn) => turn.status === 'inProgress')
      ? UNOWNED_IN_PROGRESS_RECONCILIATION_ISSUE
      : null;
  };
  try {
    const before = await inspectTurns();
    if (before) return before;
    const snapshot = await client.readThread(state.threadId!, 15_000);
    if (threadIsActive(snapshot.status)) return UNOWNED_IN_PROGRESS_RECONCILIATION_ISSUE;
    if (!threadIsIdle(snapshot.status)) {
      throw new AppError('REMOTE_STATE_UNCERTAIN', 'El thread dejo de estar disponible antes de activar el Goal.');
    }
    return await inspectTurns();
  } catch (error) {
    if (error instanceof AppError && error.code === 'REMOTE_STATE_UNCERTAIN') throw error;
    return `No se pudo confirmar que el thread siga inactivo; no se modifico: ${errorMessage(error)}`;
  }
}

async function assertActivationSafety(client: CodexDesktopClient, state: RunState): Promise<void> {
  const issue = await activationSafetyIssue(client, state);
  if (issue) throw new AppError('UNOWNED_THREAD_ACTIVITY', issue);
}

async function assertTerminalMutationSafety(client: CodexDesktopClient, state: RunState): Promise<void> {
  try {
    const inspect = async (): Promise<boolean> => {
      const turns = await managedTurnsSinceBaseline(client, state, 15_000);
      const expectedIds = state.activeTurnId === null
        ? state.observedTurnIds
        : state.observedTurnIds.filter((turnId) => turnId !== state.activeTurnId);
      const actualIds = turns
        .filter((turn) => turn.turnId !== state.activeTurnId)
        .map((turn) => turn.turnId);
      if (actualIds.length !== expectedIds.length
        || !actualIds.every((turnId, index) => turnId === expectedIds[index])) return false;
      return turns.every((turn) => turn.status !== 'inProgress' || turn.turnId === state.activeTurnId);
    };
    if (!await inspect()) throw new AppError('UNOWNED_THREAD_ACTIVITY', UNOWNED_IN_PROGRESS_RECONCILIATION_ISSUE);
    const snapshot = await client.readThread(state.threadId!, 15_000);
    if (threadIsActive(snapshot.status) && state.activeTurnId === null) {
      throw new AppError('UNOWNED_THREAD_ACTIVITY', UNOWNED_IN_PROGRESS_RECONCILIATION_ISSUE);
    }
    if (!threadIsIdle(snapshot.status) && !threadIsActive(snapshot.status)) {
      throw new AppError('UNOWNED_THREAD_ACTIVITY', 'No se pudo demostrar un estado seguro del thread antes de modificar el Goal.');
    }
    if (!await inspect()) throw new AppError('UNOWNED_THREAD_ACTIVITY', UNOWNED_IN_PROGRESS_RECONCILIATION_ISSUE);
  } catch (error) {
    if (isUnownedActivityError(error)) throw error;
    throw new AppError(
      'UNOWNED_THREAD_ACTIVITY',
      `No se pudo demostrar la propiedad antes de modificar el Goal: ${errorMessage(error)}`,
      1,
      { cause: error },
    );
  }
}

async function reconcileTurns(
  client: CodexDesktopClient,
  state: RunState,
  remoteActivationEvidence: boolean,
  goalWasMissing: boolean,
): Promise<ReconciliationIssue | null> {
  const activationWasPending = state.goalActivationPending && remoteActivationEvidence;
  const previouslyActive = state.activeTurnId;
  const previousLastTurn = state.lastTurn;
  const previousBlockingEvidence = state.blockingEvidence;
  const previousLastTurnId = previousLastTurn?.turnId ?? null;
  const turns = await managedTurnsSinceBaseline(client, state);
  const durableTurnIds = new Set(turns.map((turn) => turn.turnId));
  const missingObserved = state.observedTurnIds.filter((turnId) => !durableTurnIds.has(turnId));
  const observedPrefixMatches = state.observedTurnIds.every((turnId, index) => turns[index]?.turnId === turnId);
  const newlyDiscovered = observedPrefixMatches ? turns.slice(state.observedTurnIds.length) : [];
  const inProgress = turns.filter((turn) => turn.status === 'inProgress');
  if (!observedPrefixMatches || missingObserved.length > 0) {
    return unownedIssue('El historial durable ya no coincide con la secuencia de turnos administrados; no se usara evidencia local obsoleta ni ambigua.');
  }
  if (goalWasMissing && turns.length > 0) {
    return unownedIssue('El Goal durable no existe pero el thread conserva turnos; no se creara otro automaticamente.');
  }
  if (newlyDiscovered.length > 0 && !activationWasPending) {
    return unownedIssue('Se detectaron turnos ajenos posteriores al ultimo estado administrado; no se reclamaran automaticamente.');
  }
  if (turns.length > state.maxTurns) return managedIssue(`El historial administrado excede el limite de ${state.maxTurns} turnos.`);
  if (inProgress.some((turn) => turn.turnId !== previouslyActive)) {
    return unownedIssue(UNOWNED_IN_PROGRESS_RECONCILIATION_ISSUE);
  }
  for (const turn of turns) {
    if (!state.observedTurnIds.includes(turn.turnId) && state.observedTurnIds.length < state.maxTurns) {
      state.observedTurnIds.push(turn.turnId);
    }
  }
  state.turnCount = state.observedTurnIds.length;
  const latest = turns.at(-1) ?? null;
  const acknowledgedBlockingTurns = new Set(state.acknowledgedBlockingTurnIds);
  if (latest) {
    const blockedReason = acknowledgedBlockingTurns.has(latest.turnId)
      ? null
      : (latest.blockedReason
        ?? (previousLastTurn?.turnId === latest.turnId ? previousLastTurn.blockedReason : null));
    state.lastTurn = {
      turnId: latest.turnId,
      status: latest.status,
      error: latest.error === null ? null : sanitizeLog(latest.error, 4000),
      failedItems: [],
      blockedReason: blockedReason === null ? null : sanitizeLog(blockedReason, 4000),
    };
  }
  state.activeTurnId = inProgress.at(-1)?.turnId ?? null;
  state.goalActivationPending = false;
  if (previousLastTurnId !== null && !durableTurnIds.has(previousLastTurnId)) {
    return unownedIssue('El historial durable ya no contiene todos los turnos guardados; no se usara evidencia local obsoleta.');
  }
  if (previousBlockingEvidence && !state.acknowledgedBlockingTurnIds.includes(previousBlockingEvidence.turnId)
    && !durableTurnIds.has(previousBlockingEvidence.turnId)) {
    return unownedIssue('El turno asociado a la evidencia de bloqueo ya no existe en el historial durable.');
  }
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
    return managedIssue(`El turno ${blockedTurn.turnId} conserva una interaccion no disponible (solicitud de autoridad): ${reason}`);
  }
  if (previouslyActive && !turns.some((turn) => turn.turnId === previouslyActive)) {
    return unownedIssue('El turno activo guardado no existe en el historial durable; no se reactivara el Goal.');
  }
  if (inProgress.length > 0) return managedIssue(IN_PROGRESS_RECONCILIATION_ISSUE);
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
    return managedIssue(reason);
  }
  if (activationWasPending && newlyDiscovered.length === 0) {
    return managedIssue('La activacion anterior quedo sin un turno durable nuevo; no se reactivara automaticamente.');
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

async function reconcileAdoptionTurns(
  client: CodexDesktopClient,
  state: RunState,
  remoteActivationEvidence: boolean,
  goalWasMissing: boolean,
  signal: AbortSignal,
): Promise<ReconciliationIssue | null> {
  if (!state.goalActivationPending && state.observedTurnIds.length === 0) {
    while (true) {
      const unownedTurns = await managedTurnsSinceBaseline(client, state);
      if (unownedTurns.length === 0) return null;
      const snapshot = await client.readThread(state.threadId!);
      if (threadIsActive(snapshot.status)) {
        await appendRunEvent(state.runId, 'adoption_waiting_for_idle', { threadId: state.threadId });
        await client.waitForThreadIdle(
          state.threadId!,
          Math.max(1, state.maxWallTimeMs - elapsedMs(state)),
          signal,
        );
        continue;
      }
      if (!threadIsIdle(snapshot.status) || unownedTurns.some((turn) => turn.status === 'inProgress')) {
        return unownedIssue(UNOWNED_IN_PROGRESS_RECONCILIATION_ISSUE);
      }
      state.turnBaselineId = unownedTurns.at(-1)!.turnId;
      await saveRun(state);
      await appendRunEvent(state.runId, 'adoption_baseline_advanced', {
        threadId: state.threadId,
        turnBaselineId: state.turnBaselineId,
      });
    }
  }
  while (true) {
    const issue = await reconcileTurns(client, state, remoteActivationEvidence, goalWasMissing);
    if (issue?.reason !== IN_PROGRESS_RECONCILIATION_ISSUE
      && issue?.reason !== UNOWNED_IN_PROGRESS_RECONCILIATION_ISSUE) return issue;
    const snapshot = await client.readThread(state.threadId!);
    if (!threadIsActive(snapshot.status)) return issue;
    await appendRunEvent(state.runId, 'adoption_waiting_for_idle', { threadId: state.threadId });
    await client.waitForThreadIdle(
      state.threadId!,
      Math.max(1, state.maxWallTimeMs - elapsedMs(state)),
      signal,
    );
  }
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
  hooks: {
    beforeActivation?(signal: AbortSignal): Promise<void>;
    onActivationAttempt?(): void;
  } = {},
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
    beforeActivation: hooks.beforeActivation,
    onActivationAttempt: hooks.onActivationAttempt,
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
  onPolicyRestored: () => void,
): Promise<boolean> {
  await assertActivationSafety(client, state);
  await persistStatus(state, 'verifying');
  await assertTerminalMutationSafety(client, state);
  await client.prepareThreadForTerminal(
    state.threadId!,
    Math.max(1, Math.min(15_000, state.maxWallTimeMs - elapsedMs(state))),
  );
  onPolicyRestored();
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
  await assertActivationSafety(client, state);
  state.gitFinal = finalSnapshot;
  state.nativeGoalStatus = finalGoal.status;
  await persistStatus(state, 'completed');
  return true;
}

export async function supervise(client: CodexDesktopClient, state: RunState, logger: Logger, options: SuperviseOptions): Promise<RunState> {
  let activationAttempted = false;
  let adoptionPolicyConfigured = false;
  let normalPolicyConfigured = false;
  const managedPhase = (): boolean => !options.adopting || activationAttempted;
  const adoptionGoalMatches = (goal: GoalInfo | null): boolean => options.adoptingGoalMissing
    ? goal === null
    : goal?.status === 'paused';
  const configureManagedThread = async (): Promise<void> => {
    if (managedPhase()) normalPolicyConfigured = true;
    await client.configureThread({
      threadId: state.threadId!,
      workspace: state.workspace,
      network: state.network,
      dangerFullAccess: state.dangerFullAccess,
      ...(state.model ? { model: state.model } : {}),
      ...(state.effort ? { effort: state.effort } : {}),
    });
  };
  const restoreNormalPolicy = async (context: string): Promise<void> => {
    if (!normalPolicyConfigured || !state.threadId) return;
    try {
      await client.restoreSafeThreadSettings(state.threadId);
      normalPolicyConfigured = false;
    } catch (cause) {
      client.releaseThreadOwnership(state.threadId);
      const message = `No se pudo restaurar la politica segura ${context}: ${errorMessage(cause)}`;
      await persistStatus(state, 'failed', message).catch(() => undefined);
      throw new AppError('REMOTE_STATE_UNCERTAIN', message, 1, { cause });
    }
  };
  const blockForUnownedActivity = async (reason: string): Promise<RunState> => {
    state.goalActivationPending = false;
    if (adoptionPolicyConfigured) {
      try {
        await restoreAdoptionPolicy();
      } catch (cause) {
        if (state.threadId) client.releaseThreadOwnership(state.threadId);
        const message = `No se pudo restaurar la politica segura tras detectar actividad manual: ${errorMessage(cause)}`;
        await persistStatus(state, 'failed', message).catch(() => undefined);
        throw new AppError('REMOTE_STATE_UNCERTAIN', message, 1, { cause });
      }
    }
    await restoreNormalPolicy('tras detectar actividad manual');
    if (state.threadId) client.releaseThreadOwnership(state.threadId);
    await persistStatus(state, 'blocked', reason);
    return state;
  };
  const restoreAdoptionPolicy = async (): Promise<void> => {
    if (!adoptionPolicyConfigured || !state.threadId) return;
    await client.restoreSafeThreadSettings(state.threadId);
    adoptionPolicyConfigured = false;
  };
  const prepareAdoptionActivation = async (preactivationSignal: AbortSignal): Promise<void> => {
    const assertPreactivationOpen = (): void => {
      if (preactivationSignal.aborted || options.signal.aborted) {
        throw new AppError('INTERRUPTED', 'Activacion interrumpida antes de modificar el Goal.', 130);
      }
    };
    while (true) {
      assertPreactivationOpen();
      let snapshot = await client.readThread(state.threadId!);
      assertPreactivationOpen();
      if (threadIsActive(snapshot.status)) {
        await appendRunEvent(state.runId, 'adoption_waiting_for_idle', { threadId: state.threadId });
        snapshot = await client.waitForThreadIdle(
          state.threadId!,
          Math.max(1, state.maxWallTimeMs - elapsedMs(state)),
          options.signal,
        );
        assertPreactivationOpen();
      }
      if (!threadIsIdle(snapshot.status)) {
        throw new AppError('REMOTE_STATE_UNCERTAIN', 'La sesion dejo de estar inactiva antes de activar el modo continuo.');
      }
      const ownedGoal = await client.getGoal(state.threadId!);
      assertPreactivationOpen();
      if (!adoptionGoalMatches(ownedGoal)) {
        throw new AppError('GOAL_OWNERSHIP_MISMATCH', 'El Goal cambio antes de activar el modo continuo.');
      }
      if (ownedGoal) captureGoalIdentity(state, ownedGoal);
      const preconfigureSnapshot = await client.readThread(state.threadId!);
      assertPreactivationOpen();
      if (threadIsActive(preconfigureSnapshot.status)) {
        await appendRunEvent(state.runId, 'adoption_waiting_for_idle', { threadId: state.threadId });
        await client.waitForThreadIdle(
          state.threadId!,
          Math.max(1, state.maxWallTimeMs - elapsedMs(state)),
          options.signal,
        );
        continue;
      }
      if (!threadIsIdle(preconfigureSnapshot.status)) {
        throw new AppError('REMOTE_STATE_UNCERTAIN', 'La sesion dejo de estar inactiva antes de configurar el modo continuo.');
      }

      adoptionPolicyConfigured = true;
      assertPreactivationOpen();
      await configureManagedThread();
      assertPreactivationOpen();
      const configuredSnapshot = await client.readThread(state.threadId!);
      assertPreactivationOpen();
      if (threadIsActive(configuredSnapshot.status)) {
        await restoreAdoptionPolicy();
        await appendRunEvent(state.runId, 'adoption_waiting_for_idle', { threadId: state.threadId });
        await client.waitForThreadIdle(
          state.threadId!,
          Math.max(1, state.maxWallTimeMs - elapsedMs(state)),
          options.signal,
        );
        continue;
      }
      if (!threadIsIdle(configuredSnapshot.status)) {
        await restoreAdoptionPolicy();
        throw new AppError('REMOTE_STATE_UNCERTAIN', 'La sesion dejo de estar inactiva antes de activar el modo continuo.');
      }
      const preInjectionGoal = await client.getGoal(state.threadId!);
      assertPreactivationOpen();
      if (!adoptionGoalMatches(preInjectionGoal)) {
        await restoreAdoptionPolicy();
        throw new AppError('GOAL_OWNERSHIP_MISMATCH', 'El Goal cambio antes de inyectar el contexto inicial.');
      }
      if (preInjectionGoal) captureGoalIdentity(state, preInjectionGoal);
      assertPreactivationOpen();
      await injectInitialContext(client, state);
      assertPreactivationOpen();
      const activationGoal = await client.getGoal(state.threadId!);
      assertPreactivationOpen();
      if (!adoptionGoalMatches(activationGoal)) {
        await restoreAdoptionPolicy();
        throw new AppError('GOAL_OWNERSHIP_MISMATCH', 'El Goal cambio antes de activar el modo continuo.');
      }
      if (activationGoal) captureGoalIdentity(state, activationGoal);
      const activationSnapshot = await client.readThread(state.threadId!);
      assertPreactivationOpen();
      if (threadIsActive(activationSnapshot.status)) {
        await restoreAdoptionPolicy();
        await appendRunEvent(state.runId, 'adoption_waiting_for_idle', { threadId: state.threadId });
        await client.waitForThreadIdle(
          state.threadId!,
          Math.max(1, state.maxWallTimeMs - elapsedMs(state)),
          options.signal,
        );
        continue;
      }
      if (!threadIsIdle(activationSnapshot.status)) {
        await restoreAdoptionPolicy();
        throw new AppError('REMOTE_STATE_UNCERTAIN', 'La sesion dejo de estar inactiva antes de activar el modo continuo.');
      }
      assertPreactivationOpen();
      return;
    }
  };
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
      let snapshot = await client.readThread(state.threadId);
      if (!samePath(snapshot.cwd, state.workspace)) throw new AppError('WORKSPACE_MISMATCH', 'El thread persistido pertenece a otro workspace.');
      if (!threadIsActive(snapshot.status) && !threadIsIdle(snapshot.status)
        && (snapshot.status as { type?: unknown }).type !== 'notLoaded') {
        await persistStatus(state, 'blocked', 'El thread de Codex Desktop no esta disponible para reanudacion segura.');
        return state;
      }
      if (options.adopting && threadIsActive(snapshot.status)) {
        await appendRunEvent(state.runId, 'adoption_waiting_for_idle', { threadId: state.threadId });
        snapshot = await client.waitForThreadIdle(
          state.threadId,
          Math.max(1, state.maxWallTimeMs - elapsedMs(state)),
          options.signal,
        );
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
      const activeOwnershipIssue = threadIsActive(snapshot.status) && !options.adopting
        ? await activeTurnOwnershipIssue(client, state)
        : null;
      const canOwnActiveThread = existingGoal !== null && activeOwnershipIssue === null
        && (hasPriorGoalEvidence || state.goalActivationPending);
      if (threadIsActive(snapshot.status) && !canOwnActiveThread) {
        await persistStatus(state, 'blocked', activeOwnershipIssue
          ?? 'El thread tiene actividad sin evidencia suficiente de propiedad; no se modifico.');
        return state;
      }
      if (!existingGoal && hasPriorGoalEvidence && !options.adoptingGoalMissing) {
        await persistStatus(state, 'blocked', 'El Goal durable desaparecio despues de haber iniciado; no se creara otro automaticamente.');
        return state;
      }
      let resumedThread = await client.resumeThread(state.threadId, state.workspace, state.model ?? undefined);
      if (!samePath(resumedThread.cwd, state.workspace)) {
        throw new AppError('WORKSPACE_MISMATCH', 'El thread persistido pertenece a otro workspace.');
      }
      if (!threadIsActive(resumedThread.status) && !threadIsIdle(resumedThread.status)) {
        await persistStatus(state, 'blocked', 'Codex Desktop no cargo el thread en un estado seguro.');
        return state;
      }
      if (options.adopting && threadIsActive(resumedThread.status)) {
        await appendRunEvent(state.runId, 'adoption_waiting_for_idle', { threadId: state.threadId });
        resumedThread = await client.waitForThreadIdle(
          state.threadId,
          Math.max(1, state.maxWallTimeMs - elapsedMs(state)),
          options.signal,
        );
      }
      if (options.adopting) {
        existingGoal = await client.getGoal(state.threadId);
        if (!adoptionGoalMatches(existingGoal)) {
          client.releaseThreadOwnership(state.threadId);
          await persistStatus(state, 'blocked', 'El Goal cambio durante la adopcion; no se modifico ni se interrumpio el turno manual.');
          return state;
        }
        try {
          if (existingGoal) captureGoalIdentity(state, existingGoal);
        } catch (error) {
          client.releaseThreadOwnership(state.threadId);
          await persistStatus(state, 'blocked', errorMessage(error));
          return state;
        }
      }
      if (!options.adopting) {
        const unownedIssue = await unownedInProgressIssue(client, state);
        const resumedOwnershipIssue = unownedIssue === null && threadIsActive(resumedThread.status)
          ? await activeTurnOwnershipIssue(client, state)
          : unownedIssue;
        if (resumedOwnershipIssue) return blockForUnownedActivity(resumedOwnershipIssue);
      }
      if (options.signal.aborted) {
        if (options.adopting) {
          client.releaseThreadOwnership(state.threadId);
          await persistStatus(state, 'paused', 'Adopcion interrumpida sin modificar el turno manual.');
          return state;
        }
        await pauseForAbort(client, state);
        await persistStatus(state, 'paused', 'Ejecucion interrumpida por el usuario.');
        return state;
      }
      const resumableBlockingReason = blockingReason(state);
      const resumableBlockingTurnId = state.blockingEvidence?.turnId
        ?? (state.lastTurn?.blockedReason ? state.lastTurn.turnId : null);
      const resumableStoppedTurnId = (state.status === 'blocked' || state.status === 'paused' || state.status === 'failed')
        && (state.lastTurn?.status === 'failed' || state.lastTurn?.status === 'interrupted')
        ? state.lastTurn.turnId
        : null;
      const acknowledgedTurnId = resumableBlockingTurnId ?? resumableStoppedTurnId;
      if ((state.status === 'blocked' || state.status === 'paused' || state.status === 'failed') && acknowledgedTurnId
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
        if (!options.adopting && threadIsActive(resumedThread.status)) {
          const ownershipIssue = await activeTurnOwnershipIssue(client, state);
          if (ownershipIssue) return blockForUnownedActivity(ownershipIssue);
        }
        if (!existingGoal) throw new AppError('REMOTE_STATE_UNCERTAIN', 'El thread activo propio perdio su Goal durante la reanudacion.');
        if (existingGoal.status === 'active') {
          await assertTerminalMutationSafety(client, state);
          existingGoal = await client.setGoal(state.threadId, undefined, 'paused');
          captureGoalIdentity(state, existingGoal);
        }
        await drainTurnsAndConfirm(client, state);
        await assertTerminalMutationSafety(client, state);
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
      const remoteActivationEvidence = existingGoal !== null && existingGoal.status !== 'paused';
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
        if (state.goalActivationPending && !options.adopting) {
          const pendingIssue = await reconcileTurns(client, state, true, goalWasMissing);
          if (pendingIssue?.kind === 'unowned') return blockForUnownedActivity(pendingIssue.reason);
          if (pendingIssue) {
            state.goalActivationPending = false;
            client.releaseThreadOwnership(state.threadId);
            await persistStatus(state, 'blocked', pendingIssue.reason);
            return state;
          }
        }
        await assertTerminalMutationSafety(client, state);
        existingGoal = await client.setGoal(state.threadId, undefined, 'paused');
        captureGoalIdentity(state, existingGoal);
      }
      const reconciliationIssue = options.adopting
        ? await reconcileAdoptionTurns(
          client,
          state,
          remoteActivationEvidence,
          goalWasMissing && !options.adoptingGoalMissing,
          options.signal,
        )
        : await reconcileTurns(client, state, remoteActivationEvidence, goalWasMissing);
      if (reconciliationIssue) {
        if (reconciliationIssue.kind === 'unowned') {
          return blockForUnownedActivity(reconciliationIssue.reason);
        }
        if (options.adopting) throw new AppError('ADOPTION_RECONCILIATION_FAILED', reconciliationIssue.reason);
        state.goalActivationPending = false;
        client.releaseThreadOwnership(state.threadId);
        await persistStatus(state, 'blocked', reconciliationIssue.reason);
        return state;
      }
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

    let goal = await client.getGoal(state.threadId!);
    if (goal) await updateGoalSnapshot(state, goal);
    if (options.adopting && !adoptionGoalMatches(goal)) {
      throw new AppError('GOAL_OWNERSHIP_MISMATCH', 'El Goal cambio antes de activar el modo continuo.');
    }
    if (goal?.status === 'usageLimited' && !options.resume) {
      return finishBudget(client, state, 'Codex Desktop alcanzo el limite de uso de la cuenta.', 'usageLimited', true);
    }
    if (goal?.status === 'budgetLimited') {
      return finishBudget(client, state, 'Codex Desktop alcanzo el presupuesto nativo de Goal.', 'budgetLimited', true);
    }
    let shouldActivate = goal?.status !== 'complete';
    let pendingVerificationFeedback: string | null = null;

    while (true) {
      if (options.signal.aborted) {
        if (options.adopting && !activationAttempted) {
          await restoreAdoptionPolicy();
          client.releaseThreadOwnership(state.threadId!);
          await persistStatus(state, 'paused', 'Adopcion interrumpida sin modificar el turno manual.');
          return state;
        }
        await pauseForAbort(client, state);
        await persistStatus(state, 'paused', 'Ejecucion interrumpida por el usuario.');
        return state;
      }
      const exhausted = goal?.status === 'complete' ? completionResourceIssue(state) : budgetReason(state);
      if (exhausted) {
        if (options.adopting && !activationAttempted) {
          throw new AppError('GOAL_BUDGET_EXHAUSTED', exhausted);
        }
        return finishBudget(client, state, exhausted);
      }

      if (shouldActivate) {
        if (managedPhase()) {
          const safetyIssue = await activationSafetyIssue(client, state);
          if (safetyIssue) return blockForUnownedActivity(safetyIssue);
          await configureManagedThread();
        }
        const result = await observeGoal(
          client,
          state,
          options.signal,
          initialObjectiveRequired ? state.goalObjective : undefined,
          options.adopting && !activationAttempted ? {
            beforeActivation: prepareAdoptionActivation,
            onActivationAttempt: () => {
              activationAttempted = true;
              adoptionPolicyConfigured = false;
              normalPolicyConfigured = true;
            },
          } : {
            beforeActivation: async (preactivationSignal) => {
              const assertPreactivationOpen = (): void => {
                if (preactivationSignal.aborted || options.signal.aborted) {
                  throw new AppError('INTERRUPTED', 'Activacion interrumpida antes de modificar el Goal.', 130);
                }
              };
              if (managedPhase()) await assertActivationSafety(client, state);
              assertPreactivationOpen();
              await injectInitialContext(client, state);
              assertPreactivationOpen();
              if (pendingVerificationFeedback !== null) {
                const feedback = pendingVerificationFeedback;
                await client.injectText(state.threadId!, feedback);
                assertPreactivationOpen();
                pendingVerificationFeedback = null;
              }
              if (managedPhase()) await assertActivationSafety(client, state);
            },
          },
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
          await assertTerminalMutationSafety(client, state);
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
      if (await verifyCompletedGoal(client, state, options.signal, () => {
        normalPolicyConfigured = false;
      })) return state;
      if (options.signal.aborted) {
        await pauseForAbort(client, state);
        await persistStatus(state, 'paused', 'Ejecucion interrumpida durante la verificacion.');
        return state;
      }
      const afterVerificationBudget = budgetReason(state);
      if (afterVerificationBudget) return finishBudget(client, state, afterVerificationBudget);
      pendingVerificationFeedback = verificationFeedback(state);
      await persistStatus(state, 'running', 'La verificacion del host fallo; Codex continuara corrigiendo.');
      shouldActivate = true;
    }
  } catch (error) {
    const original = errorMessage(error);
    if (error instanceof AppError && error.code === 'UNOWNED_THREAD_ACTIVITY') {
      return blockForUnownedActivity(original);
    }
    if (options.adopting && !activationAttempted) {
      state.goalActivationPending = false;
      try {
        await restoreAdoptionPolicy();
      } catch (cleanupError) {
        const message = `No se pudo restaurar la politica segura tras abortar la adopcion: ${errorMessage(cleanupError)}`;
        await persistStatus(state, 'failed', message).catch(() => undefined);
        throw new AppError('REMOTE_STATE_UNCERTAIN', message, 1, { cause: cleanupError });
      }
      if (state.threadId) client.releaseThreadOwnership(state.threadId);
      if (options.signal.aborted) {
        await persistStatus(state, 'paused', 'Adopcion interrumpida sin modificar el turno manual.');
        return state;
      }
      await persistStatus(state, 'failed', original).catch(() => undefined);
      throw error;
    }
    await restoreNormalPolicy('tras un fallo del supervisor');
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
        if (isUnownedActivityError(blockedStopError)) return blockForUnownedActivity(errorMessage(blockedStopError));
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
        if (isUnownedActivityError(pauseError)) return blockForUnownedActivity(errorMessage(pauseError));
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
        if (isUnownedActivityError(stopError)) return blockForUnownedActivity(errorMessage(stopError));
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
