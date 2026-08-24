import { randomUUID } from 'node:crypto';
import { AppError, errorMessage } from '../errors.js';
import { sanitizeLog, type Logger } from '../log.js';
import { resumeGoal, startGoal } from '../operations.js';
import type { RunState } from '../state.js';
import type {
  DesktopEvent,
  LogLevel,
  OperationReceipt,
  ResumeRunInput,
  StartRunInput,
} from './contracts.js';

type OperationKind = 'start' | 'resume';

interface ActiveOperation {
  controller: AbortController;
  kind: OperationKind;
  promise: Promise<void>;
  runId: string | null;
}

interface LaunchedOperation {
  initialized: Promise<void>;
  receipt: OperationReceipt;
}

export interface RunManagerDependencies {
  startGoal: typeof startGoal;
  resumeGoal: typeof resumeGoal;
}

export type DesktopEventSink = (event: DesktopEvent) => void;

export class RunManager {
  private readonly operations = new Map<string, ActiveOperation>();

  constructor(
    private readonly emit: DesktopEventSink,
    private readonly dependencies: RunManagerDependencies = { startGoal, resumeGoal },
  ) {}

  get hasActiveOperations(): boolean {
    return this.operations.size > 0;
  }

  async start(input: StartRunInput): Promise<OperationReceipt> {
    const launched = this.launch('start', null, true, async (signal, logger, onRunChanged) => this.dependencies.startGoal({
      objective: input.objective,
      directory: input.workspace,
      name: input.name,
      maxTurns: input.maxTurns,
      maxHours: input.maxHours,
      turnMinutes: input.turnMinutes,
      tokenBudget: input.tokenBudget,
      verifyCommands: input.verifyCommands,
      model: input.model,
      effort: input.effort,
      network: input.network,
      dangerFullAccess: input.dangerFullAccess,
      binary: input.binary,
    }, signal, logger, { onRunChanged }));
    await launched.initialized;
    return launched.receipt;
  }

  resume(input: ResumeRunInput): OperationReceipt {
    return this.launch('resume', input.runId, false, async (signal, logger, onRunChanged) => this.dependencies.resumeGoal({
      runId: input.runId,
      verifyCommands: input.verifyCommands,
      network: input.network,
      dangerFullAccess: input.dangerFullAccess,
      binary: input.binary,
    }, signal, logger, { onRunChanged })).receipt;
  }

  pause(runId: string): OperationReceipt {
    const match = [...this.operations.entries()].find(([, operation]) => operation.runId === runId);
    if (!match) throw new AppError('RUN_NOT_OWNED', 'Solo se puede pausar una ejecucion activa iniciada por esta instancia.');
    const [operationId, operation] = match;
    operation.controller.abort(new AppError('INTERRUPTED', 'Pausa solicitada desde la interfaz.', 130));
    return { operationId };
  }

  async shutdown(): Promise<void> {
    const active = [...this.operations.values()];
    for (const operation of active) {
      operation.controller.abort(new AppError('INTERRUPTED', 'La aplicacion se esta cerrando.', 130));
    }
    await Promise.allSettled(active.map(({ promise }) => promise));
  }

  private launch(
    kind: OperationKind,
    initialRunId: string | null,
    deferAnnouncement: boolean,
    execute: (
      signal: AbortSignal,
      logger: Logger,
      onRunChanged: (state: RunState) => void,
    ) => Promise<RunState>,
  ): LaunchedOperation {
    if (initialRunId && [...this.operations.values()].some((operation) => operation.runId === initialRunId)) {
      throw new AppError('RUN_ALREADY_ACTIVE', 'Esta ejecucion ya esta activa en la interfaz.');
    }
    const operationId = randomUUID();
    const controller = new AbortController();
    const logger = this.operationLogger(operationId);
    let resolveInitialized!: () => void;
    let rejectInitialized!: (error: Error) => void;
    const initialized = new Promise<void>((resolve, reject) => {
      resolveInitialized = resolve;
      rejectInitialized = reject;
    });
    let announced = false;
    const operation: ActiveOperation = {
      controller,
      kind,
      promise: Promise.resolve(),
      runId: initialRunId,
    };
    const announce = (runId: string | null): void => {
      if (announced) return;
      announced = true;
      resolveInitialized();
      this.emit({ type: 'operation-started', operationId, runId, kind });
    };
    const onRunChanged = (state: RunState): void => {
      operation.runId = state.runId;
      announce(state.runId);
      this.emit({ type: 'run-changed', operationId, run: state });
    };
    this.operations.set(operationId, operation);
    if (!deferAnnouncement) announce(initialRunId);
    operation.promise = Promise.resolve()
      .then(() => execute(controller.signal, logger, onRunChanged))
      .then((run) => {
        operation.runId = run.runId;
        announce(run.runId);
        this.emit({ type: 'operation-finished', operationId, run });
      })
      .catch((error: unknown) => {
        const appError = error instanceof AppError ? error : new AppError('UNEXPECTED_ERROR', errorMessage(error));
        if (announced) {
          this.emit({
            type: 'operation-error',
            operationId,
            runId: operation.runId,
            error: { code: appError.code, message: sanitizeLog(appError.message) },
          });
        } else {
          rejectInitialized(appError);
        }
      })
      .finally(() => {
        this.operations.delete(operationId);
      });
    return { initialized, receipt: { operationId } };
  }

  private operationLogger(operationId: string): Logger {
    const publish = (level: LogLevel, message: string): void => {
      this.emit({
        type: 'log',
        operationId,
        level,
        message: sanitizeLog(message),
        timestamp: new Date().toISOString(),
      });
    };
    return {
      info: (message) => publish('info', message),
      warn: (message) => publish('warn', message),
      error: (message) => publish('error', message),
      debug: (message) => publish('debug', message),
    };
  }
}
