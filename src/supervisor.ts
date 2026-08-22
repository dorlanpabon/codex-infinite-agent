import path from 'node:path';
import { AppError, errorMessage } from './errors.js';
import { parseDecision, type AgentDecision } from './decision.js';
import { currentGitSnapshot } from './git.js';
import { sanitizeLog, type Logger } from './log.js';
import { continuationPrompt, initialPrompt } from './prompt.js';
import { appendRunEvent, saveRun, type RunState, type RunStatus } from './state.js';
import { verifyWorkspace } from './verify.js';
import type { CodexDesktopClient, GoalStatus, PersistedTurn, TurnResult } from './app-server/client.js';

export interface SuperviseOptions {
  resume: boolean;
  signal: AbortSignal;
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}

function elapsedMs(state: RunState): number {
  return Math.max(0, Date.now() - Date.parse(state.startedAt));
}

async function persistStatus(state: RunState, status: RunStatus, error: string | null = null): Promise<void> {
  const safeError = error === null ? null : sanitizeLog(error, 4000);
  state.status = status;
  state.lastError = safeError;
  if (status === 'completed' || status === 'blocked' || status === 'budgetLimited' || status === 'failed') {
    state.completedAt = new Date().toISOString();
  } else {
    state.completedAt = null;
  }
  await saveRun(state);
  await appendRunEvent(state.runId, 'status', { status, error: safeError });
}

async function safeSetGoal(client: CodexDesktopClient, state: RunState, status: GoalStatus, logger: Logger): Promise<void> {
  if (!state.threadId) return;
  try {
    await client.setGoal(state.threadId, undefined, status);
  } catch (error) {
    logger.warn(`No se pudo actualizar Goal a ${status}: ${errorMessage(error)}`);
  }
}

function budgetReason(state: RunState): string | null {
  if (state.turnCount >= state.maxTurns) return `Se alcanzo el limite de ${state.maxTurns} turnos.`;
  if (elapsedMs(state) >= state.maxWallTimeMs) return 'Se alcanzo el limite total de tiempo.';
  if (state.tokenBudget !== null && state.totalTokens >= state.tokenBudget) return `Se alcanzo el presupuesto de ${state.tokenBudget} tokens.`;
  return null;
}

function resultFromPersisted(state: RunState, turn: PersistedTurn): TurnResult {
  return {
    threadId: state.threadId ?? '',
    turnId: turn.turnId,
    status: turn.status,
    finalText: turn.finalText,
    totalTokens: state.totalTokens,
    error: turn.error,
    failedItems: [],
    blockedReason: null,
  };
}

async function updateTokenUsage(client: CodexDesktopClient, state: RunState, fallback: number, logger: Logger): Promise<GoalStatus | null> {
  if (!state.threadId) return null;
  try {
    const goal = await client.getGoal(state.threadId);
    state.totalTokens = goal ? goal.tokensUsed : Math.max(state.totalTokens, fallback);
    return goal?.status ?? null;
  } catch (error) {
    state.totalTokens = Math.max(state.totalTokens, fallback);
    logger.warn(`No se pudo leer el consumo de Goal: ${errorMessage(error)}`);
    return null;
  }
}

function decisionFromResult(result: TurnResult): AgentDecision {
  if (result.status !== 'completed') {
    throw new AppError('TURN_NOT_COMPLETED', result.blockedReason ?? result.error ?? `El turno termino como ${result.status}.`);
  }
  if (!result.finalText) throw new AppError('MISSING_FINAL_DECISION', 'El turno completo sin respuesta final estructurada.');
  return parseDecision(result.finalText);
}

async function finishBlocked(client: CodexDesktopClient, state: RunState, reason: string, logger: Logger): Promise<RunState> {
  await persistStatus(state, 'blocked', reason);
  await safeSetGoal(client, state, 'blocked', logger);
  return state;
}

async function finishBudget(
  client: CodexDesktopClient,
  state: RunState,
  reason: string,
  logger: Logger,
  goalStatus: 'budgetLimited' | 'usageLimited' = 'budgetLimited',
): Promise<RunState> {
  await persistStatus(state, 'budgetLimited', reason);
  await safeSetGoal(client, state, goalStatus, logger);
  return state;
}

export async function supervise(client: CodexDesktopClient, state: RunState, logger: Logger, options: SuperviseOptions): Promise<RunState> {
  let resultToProcess: TurnResult | null = null;
  const interruptActiveTurn = () => {
    if (state.threadId && state.activeTurnId) {
      void client.interrupt(state.threadId, state.activeTurnId).catch((error) => {
        logger.warn(`No se pudo interrumpir el turno activo: ${errorMessage(error)}`);
      });
    }
  };
  options.signal.addEventListener('abort', interruptActiveTurn);
  try {
    if (options.resume) {
      if (!state.threadId) throw new AppError('RUN_NOT_STARTED', 'La ejecucion guardada no tiene thread de Codex Desktop.');
      const thread = await client.resumeThread(state.threadId, state.workspace, state.model ?? undefined);
      if (!samePath(thread.cwd, state.workspace)) throw new AppError('WORKSPACE_MISMATCH', 'El thread persistido pertenece a otro workspace.');
      if (state.activeTurnId) {
        const persisted = await client.readTurn(state.threadId, state.activeTurnId);
        if (!persisted || persisted.status === 'inProgress') {
          return await finishBlocked(client, state, 'Existe un turno previo sin resultado durable; no se duplicaron acciones.', logger);
        }
        resultToProcess = resultFromPersisted(state, persisted);
      }
      await updateTokenUsage(client, state, state.totalTokens, logger);
      const resumeBudget = budgetReason(state);
      if (resumeBudget) return await finishBudget(client, state, resumeBudget, logger);
      await client.setGoal(state.threadId, state.objective, 'active', state.tokenBudget ?? undefined);
      await appendRunEvent(state.runId, 'resumed', { threadId: state.threadId });
    } else {
      const thread = await client.startThread(state.workspace, state.model ?? undefined);
      state.threadId = thread.id;
      await saveRun(state);
      await client.setThreadName(thread.id, state.name);
      await client.setGoal(thread.id, state.objective, 'active', state.tokenBudget ?? undefined);
      await appendRunEvent(state.runId, 'thread_started', { threadId: thread.id });
    }

    await persistStatus(state, 'running');
    let prompt = state.lastDecision ? continuationPrompt(state.lastDecision, state.lastVerification) : initialPrompt(state.objective);

    while (true) {
      if (options.signal.aborted) {
        await persistStatus(state, 'paused', 'Ejecucion interrumpida por el usuario.');
        await safeSetGoal(client, state, 'paused', logger);
        return state;
      }
      const exhausted = budgetReason(state);
      if (exhausted) return await finishBudget(client, state, exhausted, logger);

      let result: TurnResult;
      if (resultToProcess) {
        result = resultToProcess;
        resultToProcess = null;
      } else {
        const remainingWallMs = Math.max(1, state.maxWallTimeMs - elapsedMs(state));
        result = await client.runTurn({
          threadId: state.threadId!,
          prompt,
          workspace: state.workspace,
          network: state.network,
          dangerFullAccess: state.dangerFullAccess,
          timeoutMs: Math.min(state.turnTimeoutMs, remainingWallMs),
          ...(state.model ? { model: state.model } : {}),
          ...(state.effort ? { effort: state.effort } : {}),
          onStarted: async (turnId) => {
            state.activeTurnId = turnId;
            state.turnCount += 1;
            await saveRun(state);
            await appendRunEvent(state.runId, 'turn_started', { threadId: state.threadId, turnId, turnCount: state.turnCount });
          },
        });
      }

      state.activeTurnId = null;
      const nativeGoalStatus = await updateTokenUsage(client, state, result.totalTokens, logger);
      await saveRun(state);
      await appendRunEvent(state.runId, 'turn_completed', {
        threadId: state.threadId,
        turnId: result.turnId,
        status: result.status,
        totalTokens: state.totalTokens,
        failedItems: result.failedItems.length,
        blockedReason: result.blockedReason,
      });

      if (options.signal.aborted) {
        await persistStatus(state, 'paused', 'Ejecucion interrumpida por el usuario.');
        await safeSetGoal(client, state, 'paused', logger);
        return state;
      }
      if (nativeGoalStatus === 'budgetLimited') {
        return await finishBudget(client, state, 'Codex Desktop alcanzo el presupuesto nativo de Goal.', logger);
      }
      if (nativeGoalStatus === 'usageLimited') {
        return await finishBudget(client, state, 'Codex Desktop alcanzo el limite de uso de la cuenta.', logger, 'usageLimited');
      }
      if (result.blockedReason) return await finishBlocked(client, state, result.blockedReason, logger);
      if (result.status === 'interrupted') return await finishBlocked(client, state, result.error ?? 'El turno fue interrumpido.', logger);
      if (result.status === 'failed') return await finishBlocked(client, state, result.error ?? 'El turno de Codex fallo.', logger);

      let decision: AgentDecision;
      try {
        decision = decisionFromResult(result);
      } catch (error) {
        if (state.turnCount >= state.maxTurns) throw error;
        decision = {
          status: 'continue',
          summary: `La respuesta anterior no produjo un estado valido: ${errorMessage(error)}`,
          evidence: [],
          nextAction: 'Revisa el estado real del objetivo, continua el trabajo pendiente y devuelve el JSON requerido.',
        };
      }
      state.lastDecision = decision;
      state.lastVerification = null;
      await saveRun(state);

      if (decision.status === 'blocked') return await finishBlocked(client, state, decision.summary, logger);
      if (decision.status === 'complete') {
        await persistStatus(state, 'verifying');
        const verification = await verifyWorkspace(
          state.workspace,
          state.verifyCommands,
          Math.max(1, Math.min(15 * 60_000, state.maxWallTimeMs - elapsedMs(state))),
        );
        state.lastVerification = verification;
        await appendRunEvent(state.runId, 'verification', { ok: verification.ok, checks: verification.summary.map((line) => line.split('\n', 1)[0]) });
        if (verification.ok) {
          state.gitFinal = await currentGitSnapshot(state.workspace);
          await persistStatus(state, 'completed');
          await safeSetGoal(client, state, 'complete', logger);
          return state;
        }
        decision = {
          status: 'continue',
          summary: 'La verificacion independiente del host fallo.',
          evidence: verification.summary.map((item) => item.slice(0, 1000)),
          nextAction: 'Corrige todos los fallos de verificacion y vuelve a ejecutar las comprobaciones.',
        };
        state.lastDecision = decision;
        await persistStatus(state, 'running');
      }

      prompt = continuationPrompt(decision, state.lastVerification);
    }
  } catch (error) {
    const message = errorMessage(error);
    await persistStatus(state, 'failed', message).catch(() => undefined);
    await safeSetGoal(client, state, 'blocked', logger);
    throw error;
  } finally {
    options.signal.removeEventListener('abort', interruptActiveTurn);
  }
}
