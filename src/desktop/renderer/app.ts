import {
  EFFORTS,
  MAX_ATTACHMENTS,
  type AttachRunInput,
  type DesktopApi,
  type DesktopEvent,
  type DesktopSessionInfo,
  type DoctorResult,
  type Effort,
  type LogLevel,
  type LocalAttachment,
  type ModelInfo,
  type StartRunInput,
} from '../contracts.js';

type RunState = Awaited<ReturnType<DesktopApi['listRuns']>>[number];
type RunStatus = RunState['status'];

interface SessionLog {
  level: LogLevel;
  message: string;
  timestamp: string;
}

const api = (window as unknown as Window & { codexInfinite: DesktopApi }).codexInfinite;

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Elemento requerido no encontrado: ${id}`);
  return found as T;
}

const ui = {
  advancedSettings: element<HTMLDetailsElement>('advanced-settings'),
  attachmentDropzone: element<HTMLElement>('attachment-dropzone'),
  attachmentEmpty: element<HTMLElement>('attachment-empty'),
  attachmentList: element<HTMLUListElement>('attachment-list'),
  attachmentPickerButton: element<HTMLButtonElement>('attachment-picker-button'),
  binaryInput: element<HTMLInputElement>('goal-binary'),
  binaryPickerButton: element<HTMLButtonElement>('binary-picker-button'),
  clearLogsButton: element<HTMLButtonElement>('clear-logs-button'),
  connectionState: element<HTMLSpanElement>('connection-state'),
  dangerConfirmation: element<HTMLInputElement>('goal-danger-confirmation'),
  dangerConfirmationRow: element<HTMLLabelElement>('danger-confirmation-row'),
  dangerFullAccess: element<HTMLInputElement>('goal-full-access'),
  dialogCancelButton: element<HTMLButtonElement>('dialog-cancel-button'),
  dialogCloseButton: element<HTMLButtonElement>('dialog-close-button'),
  dialogDescription: element<HTMLElement>('goal-dialog-description'),
  dialogDoctorButton: element<HTMLButtonElement>('dialog-doctor-button'),
  dialogDoctorDetail: element<HTMLElement>('dialog-doctor-detail'),
  dialogDoctorDot: element<HTMLSpanElement>('dialog-doctor-dot'),
  dialogDoctorLabel: element<HTMLElement>('dialog-doctor-label'),
  dialogFooterCopy: element<HTMLElement>('dialog-footer-copy'),
  dialogTitle: element<HTMLElement>('goal-dialog-title'),
  doctorButton: element<HTMLButtonElement>('doctor-button'),
  doctorDot: element<HTMLSpanElement>('doctor-dot'),
  doctorLabel: element<HTMLSpanElement>('doctor-label'),
  effortInput: element<HTMLSelectElement>('goal-effort'),
  effortHelp: element<HTMLElement>('effort-help'),
  emptyNewGoalButton: element<HTMLButtonElement>('empty-new-goal-button'),
  emptyState: element<HTMLElement>('empty-state'),
  errorBanner: element<HTMLElement>('error-banner'),
  errorMessage: element<HTMLParagraphElement>('error-message'),
  form: element<HTMLFormElement>('goal-form'),
  formError: element<HTMLParagraphElement>('form-error'),
  inspectAccount: element<HTMLElement>('inspect-account'),
  inspectBinary: element<HTMLElement>('inspect-binary'),
  inspectCreated: element<HTMLElement>('inspect-created'),
  inspectGit: element<HTMLElement>('inspect-git'),
  inspectLimit: element<HTMLElement>('inspect-limit'),
  inspectOpenCodexButton: element<HTMLButtonElement>('inspect-open-codex-button'),
  inspectRunId: element<HTMLElement>('inspect-run-id'),
  inspectServer: element<HTMLElement>('inspect-server'),
  inspectorPanel: element<HTMLElement>('inspector-panel'),
  inspectorTab: element<HTMLButtonElement>('inspector-tab'),
  liveStatus: element<HTMLElement>('live-status'),
  logCount: element<HTMLElement>('log-count'),
  logList: element<HTMLOListElement>('log-list'),
  logsEmpty: element<HTMLElement>('logs-empty'),
  logsPanel: element<HTMLElement>('logs-panel'),
  logsTab: element<HTMLButtonElement>('logs-tab'),
  maxHoursInput: element<HTMLInputElement>('goal-max-hours'),
  maxTurnsInput: element<HTMLInputElement>('goal-max-turns'),
  metricTime: element<HTMLElement>('metric-time'),
  metricTokens: element<HTMLElement>('metric-tokens'),
  metricTurns: element<HTMLElement>('metric-turns'),
  metricVerifications: element<HTMLElement>('metric-verifications'),
  modelInput: element<HTMLInputElement>('goal-model'),
  modelHelp: element<HTMLElement>('model-help'),
  modelOptions: element<HTMLDataListElement>('goal-model-options'),
  modelsRefreshButton: element<HTMLButtonElement>('models-refresh-button'),
  nameInput: element<HTMLInputElement>('goal-name'),
  nativeGoalStatus: element<HTMLElement>('native-goal-status'),
  networkInput: element<HTMLInputElement>('goal-network'),
  newGoalButton: element<HTMLButtonElement>('new-goal-button'),
  objectiveCount: element<HTMLElement>('objective-count'),
  objectiveInput: element<HTMLTextAreaElement>('goal-objective'),
  pauseButton: element<HTMLButtonElement>('pause-button'),
  resumeCancelButton: element<HTMLButtonElement>('resume-cancel-button'),
  resumeButton: element<HTMLButtonElement>('resume-button'),
  resumeCloseButton: element<HTMLButtonElement>('resume-close-button'),
  resumeDangerConfirmation: element<HTMLInputElement>('resume-danger-confirmation'),
  resumeDangerConfirmationRow: element<HTMLLabelElement>('resume-danger-confirmation-row'),
  resumeDialog: element<HTMLDialogElement>('resume-dialog'),
  resumeForm: element<HTMLFormElement>('resume-form'),
  resumeFormError: element<HTMLParagraphElement>('resume-form-error'),
  resumeFullAccess: element<HTMLInputElement>('resume-full-access'),
  resumeNetwork: element<HTMLInputElement>('resume-network'),
  resumeSubmitButton: element<HTMLButtonElement>('resume-submit-button'),
  resumeVerifyInput: element<HTMLTextAreaElement>('resume-verify'),
  runCount: element<HTMLElement>('run-count'),
  runDetail: element<HTMLElement>('run-detail'),
  runLastTurn: element<HTMLElement>('run-last-turn'),
  runList: element<HTMLElement>('run-list'),
  runListEmpty: element<HTMLElement>('run-list-empty'),
  runModel: element<HTMLElement>('run-model'),
  runName: element<HTMLHeadingElement>('run-name'),
  runObjective: element<HTMLParagraphElement>('run-objective'),
  runPermissions: element<HTMLElement>('run-permissions'),
  runStatus: element<HTMLElement>('run-status'),
  runThread: element<HTMLElement>('run-thread'),
  runUpdated: element<HTMLElement>('run-updated'),
  runWorkspace: element<HTMLElement>('run-workspace'),
  sessionCount: element<HTMLElement>('session-count'),
  sessionsPanel: element<HTMLElement>('sessions-panel'),
  sessionsTab: element<HTMLButtonElement>('sessions-tab'),
  submitButton: element<HTMLButtonElement>('goal-submit-button'),
  systemVersion: element<HTMLElement>('system-version'),
  threadList: element<HTMLUListElement>('thread-list'),
  threadsEmpty: element<HTMLElement>('threads-empty'),
  threadsRefreshButton: element<HTMLButtonElement>('threads-refresh-button'),
  timeCaption: element<HTMLElement>('time-caption'),
  toastRegion: element<HTMLElement>('toast-region'),
  tokenBudgetInput: element<HTMLInputElement>('goal-token-budget'),
  tokenCaption: element<HTMLElement>('token-caption'),
  turnMinutesInput: element<HTMLInputElement>('goal-turn-minutes'),
  turnProgress: element<HTMLProgressElement>('turn-progress'),
  threadInput: element<HTMLInputElement>('goal-thread'),
  threadRow: element<HTMLElement>('goal-thread-row'),
  verificationCaption: element<HTMLElement>('verification-caption'),
  verificationDate: element<HTMLElement>('verification-date'),
  verificationEmpty: element<HTMLElement>('verification-empty'),
  verificationList: element<HTMLUListElement>('verification-list'),
  verifyInput: element<HTMLTextAreaElement>('goal-verify'),
  workspaceInput: element<HTMLInputElement>('goal-workspace'),
  workspacePickerButton: element<HTMLButtonElement>('workspace-picker-button'),
  goalDialog: element<HTMLDialogElement>('goal-dialog'),
};

const statusLabels: Record<RunStatus, string> = {
  initializing: 'Iniciando',
  running: 'En curso',
  verifying: 'Verificando',
  paused: 'Pausada',
  blocked: 'Bloqueada',
  budgetLimited: 'Límite alcanzado',
  completed: 'Completada',
  failed: 'Fallida',
};

const goalLabels: Record<NonNullable<RunState['nativeGoalStatus']>, string> = {
  active: 'Goal activo',
  paused: 'Goal pausado',
  blocked: 'Goal bloqueado',
  usageLimited: 'Límite de cuenta',
  budgetLimited: 'Presupuesto agotado',
  complete: 'Goal completo',
};

const threadStatusLabels: Record<DesktopSessionInfo['thread']['status']['type'], string> = {
  active: 'Activa',
  idle: 'Inactiva',
  notLoaded: 'No cargada',
  systemError: 'Error',
};

const effortLabels: Record<Effort, string> = {
  minimal: 'Mínimo',
  low: 'Bajo',
  medium: 'Medio',
  high: 'Alto',
  xhigh: 'Muy alto',
  max: 'Máximo',
  ultra: 'Ultra',
};

const dateFormatter = new Intl.DateTimeFormat('es-CO', {
  dateStyle: 'medium',
  timeStyle: 'short',
});
const timeFormatter = new Intl.DateTimeFormat('es-CO', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const numberFormatter = new Intl.NumberFormat('es-CO');
const relativeFormatter = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });

let runs: RunState[] = [];
let selectedRunId: string | null = null;
let doctorResult: DoctorResult | null = null;
let models: ModelInfo[] = [];
let modelsRefreshInFlight: Promise<void> | null = null;
let preferredNewModel: string | null = null;
let preferredNewEffort: Effort | null = null;
let sessions: DesktopSessionInfo[] = [];
let sessionLogs: SessionLog[] = [];
let pollInFlight = false;
let sessionsRefreshInFlight: Promise<void> | null = null;
let sessionsReconcileAgain = false;
let sessionsRefreshGeneration = 0;
let sessionsPendingQuiet = true;
let pendingSwitchFocusThreadId: string | null = null;
let lastPollError: string | null = null;
let chosenBinary: string | null = null;
let resumeRunId: string | null = null;
let attachSession: DesktopSessionInfo | null = null;
let attachments: LocalAttachment[] = [];
let attachmentDragDepth = 0;
const pendingOperations = new Map<string, string | null>();
const settledOperations = new Set<string>();

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error
    && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return 'La operación no pudo completarse.';
}

function validDate(value: string): Date | null {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function formatDate(value: string): string {
  const date = validDate(value);
  return date ? dateFormatter.format(date) : '—';
}

function formatRelative(value: string): string {
  const date = validDate(value);
  if (!date) return '—';
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  if (Math.abs(seconds) < 60) return relativeFormatter.format(seconds, 'second');
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return relativeFormatter.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relativeFormatter.format(hours, 'hour');
  return relativeFormatter.format(Math.round(hours / 24), 'day');
}

function formatDuration(milliseconds: number): string {
  const totalMinutes = Math.max(0, Math.floor(milliseconds / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} min`;
  if (minutes === 0) return `${hours} h`;
  return `${hours} h ${minutes} min`;
}

function isActive(status: RunStatus): boolean {
  return status === 'initializing' || status === 'running' || status === 'verifying';
}

function selectedRun(): RunState | null {
  return selectedRunId ? runs.find((run) => run.runId === selectedRunId) ?? null : null;
}

function setDot(dot: HTMLElement, state: 'pending' | 'ok' | 'error'): void {
  dot.className = `status-dot status-dot--${state}`;
}

function setConnection(connected: boolean): void {
  ui.connectionState.textContent = connected ? 'Local' : 'Sin respuesta';
  ui.connectionState.classList.toggle('is-offline', !connected);
}

function announce(message: string): void {
  ui.liveStatus.textContent = '';
  window.setTimeout(() => { ui.liveStatus.textContent = message; }, 20);
}

function toast(message: string, error = false): void {
  const item = document.createElement('div');
  item.className = `toast${error ? ' is-error' : ''}`;
  item.textContent = message;
  ui.toastRegion.append(item);
  window.setTimeout(() => item.remove(), 4_500);
}

function createLogItem(entry: SessionLog): HTMLLIElement {
  const item = document.createElement('li');
  item.className = 'log-item';
  item.dataset.level = entry.level;
  const time = document.createElement('time');
  time.dateTime = entry.timestamp;
  const parsed = validDate(entry.timestamp);
  time.textContent = parsed ? timeFormatter.format(parsed) : '--:--';
  const message = document.createElement('span');
  message.textContent = entry.message;
  item.append(time, message);
  return item;
}

function updateLogMeta(): void {
  ui.logCount.textContent = String(sessionLogs.length);
  ui.logsEmpty.hidden = sessionLogs.length > 0;
}

function appendLog(level: LogLevel, message: string, timestamp = new Date().toISOString()): void {
  const entry = { level, message, timestamp } satisfies SessionLog;
  sessionLogs.push(entry);
  ui.logList.append(createLogItem(entry));
  if (sessionLogs.length > 150) {
    sessionLogs = sessionLogs.slice(-150);
    ui.logList.firstElementChild?.remove();
  }
  updateLogMeta();
}

function clearLogs(): void {
  sessionLogs = [];
  ui.logList.replaceChildren();
  updateLogMeta();
  announce('Registro limpiado.');
}

function renderRunList(): void {
  const focusedRunId = document.activeElement instanceof HTMLButtonElement
    ? document.activeElement.dataset.runId ?? null
    : null;
  const fragment = document.createDocumentFragment();
  for (const run of runs) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'run-item';
    button.dataset.runId = run.runId;
    button.classList.toggle('is-selected', run.runId === selectedRunId);
    button.setAttribute('aria-current', run.runId === selectedRunId ? 'page' : 'false');
    button.title = run.objective;

    const head = document.createElement('span');
    head.className = 'run-item-head';
    const title = document.createElement('span');
    title.className = 'run-item-title';
    title.textContent = run.name || run.objective;
    const status = document.createElement('span');
    status.className = 'run-item-status';
    status.dataset.active = String(isActive(run.status) || run.status === 'completed');
    status.title = statusLabels[run.status];
    head.append(title, status);

    const meta = document.createElement('span');
    meta.className = 'run-item-meta';
    const state = document.createElement('span');
    state.textContent = statusLabels[run.status];
    const updated = document.createElement('span');
    updated.textContent = formatRelative(run.updatedAt);
    meta.append(state, updated);
    button.append(head, meta);
    button.addEventListener('click', () => {
      selectedRunId = run.runId;
      render();
    });
    fragment.append(button);
  }
  ui.runList.replaceChildren(fragment);
  if (focusedRunId) {
    const focusedReplacement = [...ui.runList.querySelectorAll<HTMLButtonElement>('.run-item')]
      .find((button) => button.dataset.runId === focusedRunId);
    focusedReplacement?.focus({ preventScroll: true });
  }
  ui.runCount.textContent = String(runs.length);
  ui.runCount.setAttribute('aria-label', `${runs.length} ${runs.length === 1 ? 'ejecución' : 'ejecuciones'}`);
  ui.runListEmpty.hidden = runs.length > 0;
}

function renderVerification(run: RunState): void {
  const verification = run.lastVerification;
  ui.verificationList.replaceChildren();
  ui.verificationList.classList.toggle('is-failed', verification?.ok === false);
  ui.verificationEmpty.hidden = verification !== null;
  ui.verificationDate.textContent = verification ? formatDate(verification.checkedAt) : 'Sin evidencia';
  ui.verificationCaption.textContent = verification ? (verification.ok ? 'Aprobada' : 'Con fallos') : 'Sin ejecutar';
  if (!verification) return;
  const fragment = document.createDocumentFragment();
  for (const summary of verification.summary) {
    const item = document.createElement('li');
    item.textContent = summary;
    fragment.append(item);
  }
  ui.verificationList.append(fragment);
}

function renderInspector(run: RunState | null): void {
  ui.inspectOpenCodexButton.hidden = !run?.threadId;
  if (!run) {
    ui.inspectRunId.textContent = '—';
    ui.inspectCreated.textContent = '—';
    ui.inspectLimit.textContent = '—';
    ui.inspectGit.textContent = '—';
    return;
  }
  ui.inspectRunId.textContent = run.runId;
  ui.inspectCreated.textContent = formatDate(run.createdAt);
  ui.inspectLimit.textContent = `${run.maxTurns} turnos · ${formatDuration(run.maxWallTimeMs)}`;
  const branch = run.gitBaseline.branch ?? 'HEAD separado';
  const head = run.gitBaseline.head ? run.gitBaseline.head.slice(0, 9) : 'sin commit';
  ui.inspectGit.textContent = `${branch} · ${head} · ${run.gitBaseline.dirty ? 'con cambios' : 'limpio'}`;
}

async function openThreadInCodex(threadId: string, label: string): Promise<void> {
  try {
    await api.openCodexThread(threadId);
    appendLog('info', `Abriendo ${threadId} en Codex Desktop.`);
    toast('Sesión abierta en Codex Desktop.');
    announce(`${label} abierta en Codex Desktop.`);
  } catch (error) {
    const message = errorText(error);
    appendLog('error', `Abrir en Codex: ${message}`);
    toast(message, true);
    announce('No se pudo abrir la sesión en Codex Desktop.');
  }
}

function runIsBusy(runId: string): boolean {
  return [...pendingOperations.values()].some((pendingRunId) => pendingRunId === runId);
}

function renderSelectedRun(): void {
  const run = selectedRun();
  ui.emptyState.hidden = run !== null;
  ui.runDetail.hidden = run === null;
  renderInspector(run);
  if (!run) return;

  ui.runName.textContent = run.name || 'Objetivo sin nombre';
  ui.runObjective.textContent = run.objective;
  ui.runStatus.textContent = statusLabels[run.status];
  ui.runStatus.dataset.active = String(isActive(run.status) || run.status === 'completed');
  ui.runUpdated.textContent = `Actualizada ${formatRelative(run.updatedAt)}`;

  ui.metricTurns.textContent = `${numberFormatter.format(run.turnCount)} / ${numberFormatter.format(run.maxTurns)}`;
  ui.turnProgress.max = Math.max(1, run.maxTurns);
  ui.turnProgress.value = Math.min(run.turnCount, run.maxTurns);
  ui.metricTokens.textContent = numberFormatter.format(run.totalTokens);
  ui.tokenCaption.textContent = run.tokenBudget === null
    ? 'Sin presupuesto explícito'
    : `de ${numberFormatter.format(run.tokenBudget)}`;
  const start = validDate(run.startedAt)?.getTime() ?? Date.now();
  const end = run.completedAt ? validDate(run.completedAt)?.getTime() ?? Date.now() : Date.now();
  ui.metricTime.textContent = formatDuration(Math.max(0, end - start));
  ui.timeCaption.textContent = `límite ${formatDuration(run.maxWallTimeMs)}`;
  ui.metricVerifications.textContent = numberFormatter.format(run.verificationAttempts);

  ui.errorBanner.hidden = run.lastError === null;
  ui.errorMessage.textContent = run.lastError ?? '';
  ui.nativeGoalStatus.textContent = run.nativeGoalStatus ? goalLabels[run.nativeGoalStatus] : 'Goal sin activar';
  ui.runWorkspace.textContent = run.workspace;
  ui.runThread.textContent = run.threadId ?? 'Pendiente';
  ui.runLastTurn.textContent = run.lastTurn
    ? `${run.lastTurn.turnId} · ${run.lastTurn.status}`
    : 'Sin turnos observados';
  const model = run.model ?? 'Predeterminado';
  ui.runModel.textContent = run.effort ? `${model} · esfuerzo ${effortLabels[run.effort]}` : model;
  const permissions = [run.dangerFullAccess ? 'Acceso total' : 'Workspace protegido'];
  permissions.push(run.network ? 'red habilitada' : 'sin red');
  ui.runPermissions.textContent = permissions.join(' · ');

  const busy = runIsBusy(run.runId);
  ui.pauseButton.disabled = !busy || !isActive(run.status);
  ui.resumeButton.disabled = busy || run.status === 'completed';
  renderVerification(run);
}

function render(): void {
  renderRunList();
  renderSelectedRun();
}

function upsertRun(run: RunState): void {
  const index = runs.findIndex((candidate) => candidate.runId === run.runId);
  if (index === -1) runs.push(run);
  else runs[index] = run;
  runs.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  selectedRunId ??= run.runId;
}

async function refreshRuns(quiet = false): Promise<void> {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    const nextRuns = await api.listRuns();
    runs = [...nextRuns].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    if (selectedRunId && !runs.some((run) => run.runId === selectedRunId)) selectedRunId = null;
    selectedRunId ??= runs[0]?.runId ?? null;
    setConnection(true);
    lastPollError = null;
    render();
  } catch (error) {
    const message = errorText(error);
    setConnection(false);
    if (message !== lastPollError) {
      appendLog('error', `No se pudieron actualizar las ejecuciones: ${message}`);
      if (!quiet) toast(message, true);
      lastPollError = message;
    }
  } finally {
    pollInFlight = false;
  }
}

function renderDoctor(result: DoctorResult): void {
  const ok = result.ok && result.desktopThreadsVisible;
  setDot(ui.doctorDot, ok ? 'ok' : 'error');
  ui.doctorLabel.textContent = ok ? 'Conectado y visible' : 'Revisión necesaria';
  setDot(ui.dialogDoctorDot, ok ? 'ok' : 'error');
  ui.dialogDoctorLabel.textContent = ok ? 'Configuración válida' : 'Revisar configuración';
  ui.dialogDoctorDetail.textContent = `${result.authentication ?? 'Sin autenticación'} · ${result.binary.version}`;
  ui.inspectAccount.textContent = result.planType
    ? `${result.authentication ?? 'ChatGPT'} · ${result.planType}`
    : result.authentication ?? 'Sin sesión';
  ui.inspectServer.textContent = `${result.binary.version} · ${result.binary.source}`;
  const signature = result.binary.signedByOpenAI === true
    ? 'firma OpenAI'
    : result.binary.signedByOpenAI === false ? 'firma no válida' : 'firma no disponible';
  ui.inspectBinary.textContent = `${result.binary.path} · ${signature}`;
}

async function runDoctor(showToast = true): Promise<void> {
  ui.doctorButton.disabled = true;
  ui.dialogDoctorButton.disabled = true;
  setDot(ui.doctorDot, 'pending');
  setDot(ui.dialogDoctorDot, 'pending');
  ui.doctorLabel.textContent = 'Comprobando conexión…';
  ui.dialogDoctorLabel.textContent = 'Comprobando…';
  try {
    const result = await api.doctor({
      workspace: ui.workspaceInput.value.trim() || null,
      binary: ui.binaryInput.value.trim() || chosenBinary,
    });
    doctorResult = result;
    chosenBinary = ui.binaryInput.value.trim() || chosenBinary;
    renderDoctor(result);
    appendLog(result.ok ? 'info' : 'warn', result.ok
      ? `App Server ${result.binary.version} disponible.`
      : 'El diagnóstico encontró una configuración incompleta.');
    if (showToast) toast(result.ok ? 'Diagnóstico completado.' : 'La configuración requiere revisión.', !result.ok);
    if (result.ok) await Promise.all([refreshThreads(true), refreshModels(true)]);
  } catch (error) {
    const message = errorText(error);
    setDot(ui.doctorDot, 'error');
    setDot(ui.dialogDoctorDot, 'error');
    ui.doctorLabel.textContent = 'No disponible';
    ui.dialogDoctorLabel.textContent = 'No se pudo conectar';
    ui.dialogDoctorDetail.textContent = message;
    ui.inspectAccount.textContent = 'No disponible';
    appendLog('error', `Diagnóstico: ${message}`);
    if (showToast) toast(message, true);
  } finally {
    ui.doctorButton.disabled = false;
    ui.dialogDoctorButton.disabled = false;
  }
}

function sessionState(session: DesktopSessionInfo): string {
  if (session.operationActive && session.goal?.status !== 'active' && session.thread.status.type === 'active') {
    return 'Esperando que termine el turno actual';
  }
  if (session.operationActive) return session.localRun?.status === 'verifying' ? 'Verificando resultado' : 'Modo continuo activo';
  if (session.goal?.status === 'active') return 'Goal activo en otra instancia';
  if (session.localRun) return statusLabels[session.localRun.status];
  if (session.goal) return goalLabels[session.goal.status];
  return session.unavailableReason ?? 'Modo continuo desactivado';
}

async function activateExistingGoal(session: DesktopSessionInfo): Promise<void> {
  if (!session.goal) return;
  try {
    const receipt = await api.attachRun({
      threadId: session.thread.id,
      objective: session.goal.objective,
      attachments: [],
      workspace: session.thread.cwd,
      name: null,
      maxTurns: 30,
      maxHours: 8,
      turnMinutes: 45,
      tokenBudget: session.goal.tokenBudget,
      verifyCommands: [],
      model: null,
      effort: null,
      network: false,
      dangerFullAccess: false,
      dangerConfirmation: false,
      binary: ui.binaryInput.value.trim() || chosenBinary,
    });
    if (!pendingOperations.has(receipt.operationId) && !settledOperations.has(receipt.operationId)) {
      pendingOperations.set(receipt.operationId, null);
    }
    pendingSwitchFocusThreadId = session.thread.id;
    appendLog('info', `Goal existente activado. Operación ${receipt.operationId}.`);
    toast('Modo continuo activado.');
    announce('Goal existente activado en modo continuo.');
    await Promise.all([refreshRuns(true), refreshThreads(true)]);
  } catch (error) {
    const message = errorText(error);
    appendLog('error', `Activación: ${message}`);
    toast(message, true);
  }
}

async function toggleSession(session: DesktopSessionInfo): Promise<void> {
  const checked = session.operationActive || session.goal?.status === 'active';
  if (checked) {
    if (!session.canDisable || !session.localRun) return;
    try {
      await api.pauseRun(session.localRun.runId);
      announce('Pausa solicitada para la sesion.');
    } catch (error) {
      toast(errorText(error), true);
    }
    return;
  }
  if (!session.canEnable) return;
  if (session.localRun) {
    selectedRunId = session.localRun.runId;
    render();
    openResumeDialog();
    return;
  }
  if (session.goal) {
    await activateExistingGoal(session);
    return;
  }
  openGoalDialog(session);
}

function renderThreads(): void {
  const activeElement = document.activeElement;
  const focusedSwitchThreadId = activeElement instanceof HTMLButtonElement
    && activeElement.classList.contains('session-switch')
    ? activeElement.dataset.threadId ?? null
    : null;
  const focusedStateThreadId = activeElement instanceof HTMLElement
    && activeElement.classList.contains('session-state')
    ? activeElement.dataset.threadId ?? null
    : null;
  const focusedOpenThreadId = activeElement instanceof HTMLButtonElement
    && activeElement.classList.contains('session-open-button')
    ? activeElement.dataset.threadId ?? null
    : null;
  if (pendingSwitchFocusThreadId && focusedStateThreadId !== pendingSwitchFocusThreadId) {
    pendingSwitchFocusThreadId = null;
  }
  const focusedThreadId = focusedSwitchThreadId ?? focusedStateThreadId;
  const fragment = document.createDocumentFragment();
  for (const [index, session] of sessions.entries()) {
    const { thread } = session;
    const item = document.createElement('li');
    item.className = 'session-item';
    const content = document.createElement('div');
    const title = document.createElement('strong');
    title.className = 'session-title';
    title.textContent = thread.name || thread.preview || 'Sesión sin nombre';
    const meta = document.createElement('span');
    meta.className = 'session-meta';
    meta.textContent = `${threadStatusLabels[thread.status.type]} · ${thread.cwd}`;
    const state = document.createElement('span');
    state.className = 'session-state';
    state.id = `session-state-${index}`;
    state.dataset.threadId = thread.id;
    state.tabIndex = -1;
    const toggle = document.createElement('button');
    const actions = document.createElement('div');
    actions.className = 'session-actions';
    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.className = 'text-button session-open-button';
    openButton.dataset.threadId = thread.id;
    openButton.textContent = 'Abrir en Codex';
    openButton.setAttribute('aria-label', `Abrir ${title.textContent} en Codex Desktop`);
    openButton.addEventListener('click', () => { void openThreadInCodex(thread.id, title.textContent ?? 'Sesión'); });
    const checked = session.operationActive || session.goal?.status === 'active';
    toggle.type = 'button';
    toggle.className = 'session-switch';
    toggle.dataset.threadId = thread.id;
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', String(checked));
    toggle.setAttribute('aria-label', `${checked ? 'Desactivar' : 'Activar'} modo continuo para ${title.textContent}`);
    toggle.disabled = checked ? !session.canDisable : !session.canEnable;
    state.textContent = toggle.disabled
      ? session.unavailableReason ?? sessionState(session)
      : sessionState(session);
    toggle.title = state.textContent;
    if (toggle.disabled) {
      toggle.setAttribute('aria-disabled', 'true');
      toggle.setAttribute('aria-describedby', state.id);
    }
    toggle.addEventListener('click', () => { void toggleSession(session); });
    content.append(title, meta, state);
    actions.append(openButton, toggle);
    item.append(content, actions);
    fragment.append(item);
  }
  ui.threadList.replaceChildren(fragment);
  if (focusedOpenThreadId) {
    const focusedOpen = [...ui.threadList.querySelectorAll<HTMLButtonElement>('.session-open-button')]
      .find((candidate) => candidate.dataset.threadId === focusedOpenThreadId);
    focusedOpen?.focus({ preventScroll: true });
  } else if (focusedThreadId) {
    const focusedSwitch = [...ui.threadList.querySelectorAll<HTMLButtonElement>('.session-switch')]
      .find((candidate) => candidate.dataset.threadId === focusedThreadId);
    const focusedState = [...ui.threadList.querySelectorAll<HTMLElement>('.session-state')]
      .find((candidate) => candidate.dataset.threadId === focusedThreadId);
    if (focusedSwitch && !focusedSwitch.disabled) {
      focusedSwitch.focus({ preventScroll: true });
      pendingSwitchFocusThreadId = null;
    } else if (focusedState) {
      focusedState.focus({ preventScroll: true });
      pendingSwitchFocusThreadId = focusedThreadId;
    } else {
      pendingSwitchFocusThreadId = null;
    }
  }
  ui.sessionCount.textContent = String(sessions.length);
  ui.threadsEmpty.hidden = sessions.length > 0;
  if (sessions.length === 0) ui.threadsEmpty.textContent = 'No hay sesiones recientes visibles.';
}

function refreshThreads(quiet = false): Promise<void> {
  sessionsRefreshGeneration += 1;
  sessionsPendingQuiet = sessionsRefreshInFlight === null ? quiet : sessionsPendingQuiet && quiet;
  if (sessionsRefreshInFlight) {
    sessionsReconcileAgain = true;
    return sessionsRefreshInFlight;
  }

  const reconcile = async (): Promise<void> => {
    ui.threadsRefreshButton.disabled = true;
    ui.sessionsPanel.setAttribute('aria-busy', 'true');
    ui.threadList.setAttribute('aria-busy', 'true');
    try {
      do {
        sessionsReconcileAgain = false;
        const generation = sessionsRefreshGeneration;
        try {
          const nextSessions = await api.listSessions({
            workspace: null,
            binary: ui.binaryInput.value.trim() || chosenBinary,
            limit: 50,
          });
          if (generation !== sessionsRefreshGeneration) continue;
          sessions = nextSessions;
          renderThreads();
          if (!sessionsPendingQuiet) announce(`${sessions.length} sesiones de Desktop actualizadas.`);
          sessionsPendingQuiet = true;
        } catch (error) {
          if (generation !== sessionsRefreshGeneration) continue;
          const message = errorText(error);
          sessions = [];
          ui.threadList.replaceChildren();
          ui.sessionCount.textContent = '0';
          ui.threadsEmpty.hidden = false;
          ui.threadsEmpty.textContent = 'No fue posible consultar las sesiones.';
          appendLog('warn', `Sesiones Desktop: ${message}`);
          if (!sessionsPendingQuiet) toast(message, true);
          sessionsPendingQuiet = true;
        }
      } while (sessionsReconcileAgain);
    } finally {
      sessionsRefreshInFlight = null;
      ui.threadsRefreshButton.disabled = false;
      ui.sessionsPanel.setAttribute('aria-busy', 'false');
      ui.threadList.setAttribute('aria-busy', 'false');
    }
  };

  sessionsRefreshInFlight = Promise.resolve().then(reconcile);
  return sessionsRefreshInFlight;
}

function effortValue(value: string | null | undefined): Effort | null {
  return value && EFFORTS.includes(value as Effort) ? value as Effort : null;
}

function selectedModel(value = ui.modelInput.value.trim()): ModelInfo | null {
  return models.find((candidate) => candidate.model === value || candidate.id === value) ?? null;
}

function nativeDefaultModel(): ModelInfo | null {
  const defaults = models.filter((model) => model.isDefault);
  return defaults.length === 1 ? defaults[0]! : null;
}

function nativeDefaultSummary(): string | null {
  const model = nativeDefaultModel();
  return model ? `${model.displayName} (${model.model})` : null;
}

function renderModelOptions(): void {
  const fragment = document.createDocumentFragment();
  for (const model of models) {
    const option = document.createElement('option');
    option.value = model.model;
    option.label = `${model.displayName}${model.isDefault ? ' · Predeterminado' : ''}`;
    fragment.append(option);
  }
  ui.modelOptions.replaceChildren(fragment);
}

function renderModelHelp(error: string | null = null): void {
  if (error) {
    ui.modelHelp.textContent = `Catálogo no disponible: ${error} Puedes dejar el campo vacío o escribir un ID; esto no bloquea el objetivo.`;
    return;
  }
  const defaultSummary = nativeDefaultSummary();
  const current = ui.modelInput.value.trim();
  const match = selectedModel(current);
  if (attachSession && !current) {
    ui.modelHelp.textContent = `${defaultSummary ? `Predeterminado nativo: ${defaultSummary}. ` : ''}Sin selección se conserva el modelo de esta sesión.`;
  } else if (match) {
    ui.modelHelp.textContent = `${match.displayName}${match.isDefault ? ' · predeterminado nativo' : ''} · ${match.model}`;
  } else if (current) {
    ui.modelHelp.textContent = `${defaultSummary ? `Predeterminado nativo: ${defaultSummary}. ` : ''}El ID escrito no figura en el catálogo y se conservará sin modificar.`;
  } else if (defaultSummary) {
    ui.modelHelp.textContent = `Predeterminado nativo: ${defaultSummary}.`;
  } else if (models.length > 0) {
    ui.modelHelp.textContent = 'Codex no marcó un único modelo predeterminado; App Server resolverá el campo vacío.';
  } else {
    ui.modelHelp.textContent = 'Sin catálogo: App Server resolverá el modelo predeterminado si dejas el campo vacío.';
  }
}

function configureEfforts(preferred: Effort | null, selectNativeDefault: boolean): void {
  const model = selectedModel();
  const nativeEfforts = model?.supportedReasoningEfforts
    .map(({ reasoningEffort }) => effortValue(reasoningEffort))
    .filter((effort): effort is Effort => effort !== null) ?? [];
  const choices = [...new Set(nativeEfforts.length > 0 ? nativeEfforts : EFFORTS)];
  const defaultEffort = effortValue(model?.defaultReasoningEffort);
  if (defaultEffort && !choices.includes(defaultEffort)) choices.unshift(defaultEffort);

  const fragment = document.createDocumentFragment();
  const automatic = document.createElement('option');
  automatic.value = '';
  automatic.textContent = attachSession
    ? 'Conservar esfuerzo de la sesión'
    : defaultEffort ? `Automático (${effortLabels[defaultEffort]})` : 'Predeterminado de Codex';
  fragment.append(automatic);
  for (const effort of choices) {
    const option = document.createElement('option');
    option.value = effort;
    option.textContent = `${effortLabels[effort]}${effort === defaultEffort ? ' · Predeterminado' : ''}`;
    fragment.append(option);
  }
  ui.effortInput.replaceChildren(fragment);

  const nextEffort = preferred && choices.includes(preferred)
    ? preferred
    : selectNativeDefault && defaultEffort ? defaultEffort : null;
  ui.effortInput.value = nextEffort ?? '';
  if (model && nativeEfforts.length > 0) {
    ui.effortHelp.textContent = `${model.displayName}: ${choices.map((effort) => effortLabels[effort]).join(', ')}.`;
  } else if (ui.modelInput.value.trim()) {
    ui.effortHelp.textContent = 'Modelo fuera del catálogo: Codex validará el esfuerzo al iniciar.';
  } else {
    ui.effortHelp.textContent = attachSession
      ? 'Sin selección se conserva el esfuerzo de la sesión.'
      : 'Codex resolverá el esfuerzo predeterminado.';
  }
}

function selectModelDefaults(): void {
  const model = selectedModel();
  configureEfforts(null, model !== null);
  renderModelHelp();
  if (!attachSession) {
    preferredNewModel = ui.modelInput.value.trim() || null;
    preferredNewEffort = effortValue(ui.effortInput.value);
  }
}

function refreshModels(quiet = false): Promise<void> {
  if (modelsRefreshInFlight) return modelsRefreshInFlight;
  ui.modelsRefreshButton.disabled = true;
  ui.modelsRefreshButton.textContent = 'Cargando…';
  ui.modelHelp.textContent = 'Consultando model/list en Codex App Server…';
  const reconcile = async (): Promise<void> => {
    try {
      const nextModels = await api.listModels({
        workspace: ui.workspaceInput.value.trim() || null,
        binary: ui.binaryInput.value.trim() || chosenBinary,
      });
      models = nextModels;
      renderModelOptions();
      const defaultModel = nativeDefaultModel();
      if (preferredNewModel === null && defaultModel) preferredNewModel = defaultModel.model;
      if (!attachSession) {
        const current = ui.goalDialog.open ? ui.modelInput.value.trim() : '';
        ui.modelInput.value = current || preferredNewModel || defaultModel?.model || '';
        configureEfforts(preferredNewEffort, preferredNewEffort === null);
        preferredNewEffort = effortValue(ui.effortInput.value);
      } else {
        configureEfforts(effortValue(ui.effortInput.value), false);
      }
      renderModelHelp();
      const summary = nativeDefaultSummary();
      appendLog('info', `${models.length} modelos disponibles${summary ? `; predeterminado ${summary}` : ''}.`);
      if (!quiet) toast(`${models.length} modelos actualizados.`);
    } catch (error) {
      const message = errorText(error);
      models = [];
      renderModelOptions();
      configureEfforts(effortValue(ui.effortInput.value), false);
      renderModelHelp(message);
      appendLog('warn', `Modelos Desktop: ${message}`);
      if (!quiet) toast(message, true);
    } finally {
      ui.modelsRefreshButton.disabled = false;
      ui.modelsRefreshButton.textContent = 'Actualizar';
      modelsRefreshInFlight = null;
    }
  };
  modelsRefreshInFlight = Promise.resolve().then(reconcile);
  return modelsRefreshInFlight;
}

function setFormError(message: string | null): void {
  ui.formError.hidden = message === null;
  ui.formError.textContent = message ?? '';
}

function attachmentSize(size: number): string {
  if (size < 1024) return `${numberFormatter.format(size)} B`;
  if (size < 1024 * 1024) return `${numberFormatter.format(Math.round(size / 1024))} KB`;
  return `${numberFormatter.format(Math.round(size / (1024 * 1024) * 10) / 10)} MB`;
}

function renderAttachments(): void {
  const fragment = document.createDocumentFragment();
  for (const attachment of attachments) {
    const item = document.createElement('li');
    item.className = 'attachment-item';
    const copy = document.createElement('div');
    copy.className = 'attachment-copy';
    const name = document.createElement('strong');
    name.className = 'attachment-name';
    name.textContent = `${attachment.name} · ${attachmentSize(attachment.size)}`;
    const path = document.createElement('span');
    path.className = 'attachment-path';
    path.textContent = attachment.path;
    path.title = attachment.path;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'attachment-remove';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Quitar ${attachment.name}`);
    remove.addEventListener('click', () => {
      attachments = attachments.filter((candidate) => candidate.path !== attachment.path);
      renderAttachments();
      announce(`${attachment.name} eliminado de los adjuntos.`);
    });
    copy.append(name, path);
    item.append(copy, remove);
    fragment.append(item);
  }
  ui.attachmentList.replaceChildren(fragment);
  ui.attachmentEmpty.hidden = attachments.length > 0;
}

function mergeAttachments(next: LocalAttachment[]): void {
  const byPath = new Map(attachments.map((attachment) => [attachment.path, attachment]));
  for (const attachment of next) byPath.set(attachment.path, attachment);
  if (byPath.size > MAX_ATTACHMENTS) {
    setFormError(`Se admiten hasta ${MAX_ATTACHMENTS} archivos adjuntos por objetivo.`);
    return;
  }
  attachments = [...byPath.values()];
  renderAttachments();
}

async function chooseAttachments(): Promise<void> {
  ui.attachmentPickerButton.disabled = true;
  try {
    const selected = await api.chooseAttachments();
    mergeAttachments(selected);
    if (selected.length > 0) announce(`${selected.length} archivos adjuntos añadidos.`);
  } catch (error) {
    setFormError(errorText(error));
  } finally {
    ui.attachmentPickerButton.disabled = false;
  }
}

async function addDroppedFiles(files: FileList): Promise<void> {
  const paths = [...files].flatMap((file) => {
    try {
      const candidate = api.pathForFile(file);
      return candidate ? [candidate] : [];
    } catch {
      return [];
    }
  });
  if (paths.length === 0) {
    setFormError('No se pudo obtener una ruta local valida de los archivos arrastrados.');
    return;
  }
  try {
    mergeAttachments(await api.inspectAttachments(paths));
    announce(`${paths.length} archivos arrastrados añadidos.`);
  } catch (error) {
    setFormError(errorText(error));
  }
}

function openGoalDialog(session: DesktopSessionInfo | null = null): void {
  attachSession = session;
  const workspace = session?.thread.cwd ?? selectedRun()?.workspace ?? ui.workspaceInput.value;
  const binary = ui.binaryInput.value || chosenBinary || '';
  ui.form.reset();
  ui.workspaceInput.value = workspace;
  ui.binaryInput.value = binary;
  ui.modelInput.value = session ? '' : preferredNewModel ?? nativeDefaultModel()?.model ?? '';
  configureEfforts(session ? null : preferredNewEffort, session === null && preferredNewEffort === null);
  renderModelHelp();
  ui.threadRow.hidden = session === null;
  ui.threadInput.value = session?.thread.id ?? '';
  ui.workspaceInput.readOnly = session !== null;
  ui.workspacePickerButton.disabled = session !== null;
  ui.objectiveInput.value = session?.goal?.objective ?? '';
  ui.objectiveInput.readOnly = session?.goal !== null && session?.goal !== undefined;
  attachments = [];
  renderAttachments();
  ui.nameInput.value = session?.thread.name ?? '';
  if (session?.goal?.tokenBudget) ui.tokenBudgetInput.value = String(session.goal.tokenBudget);
  ui.dialogTitle.textContent = session?.goal === null ? 'Coloca el objetivo para activar' : session ? 'Activar modo continuo' : 'Nuevo objetivo';
  ui.dialogDescription.textContent = session
    ? 'La sesión se adjunta de forma segura. Si su turno está activo, esperará a que termine antes de activar el Goal.'
    : 'Define el resultado, los límites y el workspace que Codex puede modificar.';
  ui.dialogFooterCopy.textContent = session
    ? 'No se enviarán mensajes mientras el turno actual siga activo.'
    : 'La ejecución se guarda localmente y aparece en Codex Desktop.';
  ui.submitButton.textContent = session ? 'Activar modo' : 'Iniciar objetivo';
  ui.objectiveCount.textContent = `${numberFormatter.format(ui.objectiveInput.value.length)} caracteres`;
  ui.advancedSettings.open = false;
  updateDangerConfirmation();
  setFormError(null);
  if (!ui.goalDialog.open) ui.goalDialog.showModal();
  if (models.length === 0) void refreshModels(true);
  window.setTimeout(() => ui.objectiveInput.focus(), 0);
}

function closeGoalDialog(): void {
  if (ui.goalDialog.open) ui.goalDialog.close();
  attachSession = null;
  ui.threadRow.hidden = true;
  ui.threadInput.value = '';
  ui.workspaceInput.readOnly = false;
  ui.workspacePickerButton.disabled = false;
  ui.objectiveInput.readOnly = false;
  attachments = [];
  renderAttachments();
}

function updateDangerConfirmation(): void {
  const enabled = ui.dangerFullAccess.checked;
  ui.dangerConfirmationRow.hidden = !enabled;
  ui.dangerConfirmation.required = enabled;
  if (enabled) {
    ui.networkInput.checked = true;
    ui.networkInput.disabled = true;
    window.requestAnimationFrame(() => ui.dangerConfirmationRow.scrollIntoView({ block: 'nearest' }));
  } else {
    ui.networkInput.disabled = false;
    ui.dangerConfirmation.checked = false;
  }
}

function parseVerificationCommands(value: string): string[] {
  const commands = value
    .split(/\r?\n/u)
    .map((command) => command.trim())
    .filter((command) => command.length > 0);
  if (commands.length > 20) throw new Error('Usa como máximo 20 comandos de verificación.');
  if (commands.some((command) => command.length > 4000)) throw new Error('Un comando de verificación excede 4000 caracteres.');
  return commands;
}

function startInput(): StartRunInput {
  const commands = parseVerificationCommands(ui.verifyInput.value);
  const effortValue = ui.effortInput.value;
  const effort = effortValue === '' ? null : effortValue as Effort;
  const tokenBudget = ui.tokenBudgetInput.value === '' ? null : ui.tokenBudgetInput.valueAsNumber;
  return {
    objective: ui.objectiveInput.value.trim(),
    attachments: attachments.map((attachment) => attachment.path),
    workspace: ui.workspaceInput.value.trim(),
    name: ui.nameInput.value.trim() || null,
    maxTurns: ui.maxTurnsInput.valueAsNumber,
    maxHours: ui.maxHoursInput.valueAsNumber,
    turnMinutes: ui.turnMinutesInput.valueAsNumber,
    tokenBudget,
    verifyCommands: commands,
    model: ui.modelInput.value.trim() || null,
    effort,
    network: ui.networkInput.checked,
    dangerFullAccess: ui.dangerFullAccess.checked,
    dangerConfirmation: ui.dangerFullAccess.checked && ui.dangerConfirmation.checked,
    binary: ui.binaryInput.value.trim() || null,
  };
}

async function submitGoal(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  setFormError(null);
  if (!ui.form.checkValidity()) {
    ui.form.reportValidity();
    return;
  }
  ui.submitButton.disabled = true;
  ui.submitButton.textContent = attachSession ? 'Activando…' : 'Iniciando…';
  try {
    const input = startInput();
    const attachInput: AttachRunInput | null = attachSession
      ? { ...input, threadId: attachSession.thread.id }
      : null;
    const receipt = attachInput ? await api.attachRun(attachInput) : await api.startRun(input);
    if (!pendingOperations.has(receipt.operationId) && !settledOperations.has(receipt.operationId)) {
      pendingOperations.set(receipt.operationId, null);
    }
    chosenBinary = input.binary;
    closeGoalDialog();
    appendLog('info', `Objetivo enviado. Operación ${receipt.operationId}.`);
    toast('Objetivo iniciado en Codex Desktop.');
    announce('Objetivo iniciado.');
    await refreshRuns(true);
  } catch (error) {
    const message = errorText(error);
    setFormError(message);
    appendLog('error', `Inicio: ${message}`);
  } finally {
    ui.submitButton.disabled = false;
    ui.submitButton.textContent = attachSession ? 'Activar modo' : 'Iniciar objetivo';
  }
}

async function chooseWorkspace(): Promise<void> {
  ui.workspacePickerButton.disabled = true;
  try {
    const workspace = await api.chooseWorkspace();
    if (workspace) {
      ui.workspaceInput.value = workspace;
      announce('Workspace seleccionado.');
    }
  } catch (error) {
    setFormError(errorText(error));
  } finally {
    ui.workspacePickerButton.disabled = false;
  }
}

async function chooseBinary(): Promise<void> {
  ui.binaryPickerButton.disabled = true;
  try {
    const binary = await api.chooseBinary();
    if (binary) {
      chosenBinary = binary;
      ui.binaryInput.value = binary;
      announce('Binario seleccionado.');
    }
  } catch (error) {
    setFormError(errorText(error));
  } finally {
    ui.binaryPickerButton.disabled = false;
  }
}

function setResumeFormError(message: string | null): void {
  ui.resumeFormError.hidden = message === null;
  ui.resumeFormError.textContent = message ?? '';
}

function updateResumeDangerConfirmation(): void {
  const enabled = ui.resumeFullAccess.checked;
  ui.resumeDangerConfirmationRow.hidden = !enabled;
  ui.resumeDangerConfirmation.required = enabled;
  if (enabled) {
    ui.resumeNetwork.checked = true;
    ui.resumeNetwork.disabled = true;
  } else {
    ui.resumeNetwork.disabled = false;
    ui.resumeNetwork.checked = false;
    ui.resumeDangerConfirmation.checked = false;
  }
}

function openResumeDialog(): void {
  const run = selectedRun();
  if (!run || runIsBusy(run.runId) || run.status === 'completed') return;
  resumeRunId = run.runId;
  ui.resumeForm.reset();
  updateResumeDangerConfirmation();
  setResumeFormError(null);
  if (!ui.resumeDialog.open) ui.resumeDialog.showModal();
  window.setTimeout(() => ui.resumeVerifyInput.focus(), 0);
}

function closeResumeDialog(): void {
  if (ui.resumeDialog.open) ui.resumeDialog.close();
  resumeRunId = null;
}

async function resumeSelectedRun(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const run = resumeRunId ? runs.find((candidate) => candidate.runId === resumeRunId) ?? null : null;
  if (!run || runIsBusy(run.runId)) {
    setResumeFormError('La ejecución seleccionada ya no está disponible para reanudar.');
    return;
  }
  if (!ui.resumeForm.checkValidity()) {
    ui.resumeForm.reportValidity();
    return;
  }
  setResumeFormError(null);
  ui.resumeSubmitButton.disabled = true;
  ui.resumeSubmitButton.textContent = 'Reanudando…';
  try {
    const verifyCommands = parseVerificationCommands(ui.resumeVerifyInput.value);
    const receipt = await api.resumeRun({
      runId: run.runId,
      verifyCommands,
      network: ui.resumeNetwork.checked,
      dangerFullAccess: ui.resumeFullAccess.checked,
      dangerConfirmation: ui.resumeFullAccess.checked && ui.resumeDangerConfirmation.checked,
      binary: chosenBinary,
    });
    if (!pendingOperations.has(receipt.operationId) && !settledOperations.has(receipt.operationId)) {
      pendingOperations.set(receipt.operationId, run.runId);
    }
    appendLog('info', `Reanudando ${run.runId}.`);
    toast('Reanudación solicitada.');
    closeResumeDialog();
    renderSelectedRun();
  } catch (error) {
    const message = errorText(error);
    setResumeFormError(message);
    appendLog('error', `Reanudación: ${message}`);
  } finally {
    ui.resumeSubmitButton.disabled = false;
    ui.resumeSubmitButton.textContent = 'Reanudar';
    renderSelectedRun();
  }
}

async function pauseSelectedRun(): Promise<void> {
  const run = selectedRun();
  if (!run || !runIsBusy(run.runId)) return;
  ui.pauseButton.disabled = true;
  try {
    await api.pauseRun(run.runId);
    appendLog('info', `Pausa solicitada para ${run.runId}.`);
    toast('Pausa segura solicitada.');
    renderSelectedRun();
  } catch (error) {
    const message = errorText(error);
    appendLog('error', `Pausa: ${message}`);
    toast(message, true);
  } finally {
    renderSelectedRun();
  }
}

function handleDesktopEvent(event: DesktopEvent): void {
  switch (event.type) {
    case 'operation-started':
      settledOperations.delete(event.operationId);
      pendingOperations.set(event.operationId, event.runId);
      appendLog('debug', `Operación ${event.kind} iniciada.`, new Date().toISOString());
      renderSelectedRun();
      break;
    case 'run-changed':
      pendingOperations.set(event.operationId, event.run.runId);
      upsertRun(event.run);
      render();
      void refreshThreads(true);
      break;
    case 'operation-finished':
      pendingOperations.delete(event.operationId);
      settledOperations.add(event.operationId);
      upsertRun(event.run);
      appendLog('info', `${event.run.name}: ${statusLabels[event.run.status]}.`);
      toast(`${event.run.name}: ${statusLabels[event.run.status].toLowerCase()}.`);
      announce(`Ejecución ${statusLabels[event.run.status].toLowerCase()}.`);
      render();
      void refreshThreads(true);
      break;
    case 'operation-error':
      pendingOperations.delete(event.operationId);
      settledOperations.add(event.operationId);
      appendLog('error', `${event.error.code}: ${event.error.message}`);
      toast(event.error.message, true);
      announce('La operación terminó con un error.');
      renderSelectedRun();
      void refreshThreads(true);
      break;
    case 'log':
      appendLog(event.level, event.message, event.timestamp);
      break;
  }
}

type PanelTab = 'inspector' | 'sessions' | 'logs';

function setActiveTab(tab: PanelTab, focus = false): void {
  const inspectorActive = tab === 'inspector';
  const sessionsActive = tab === 'sessions';
  const logsActive = tab === 'logs';
  ui.inspectorTab.classList.toggle('is-active', inspectorActive);
  ui.sessionsTab.classList.toggle('is-active', sessionsActive);
  ui.logsTab.classList.toggle('is-active', logsActive);
  ui.inspectorTab.setAttribute('aria-selected', String(inspectorActive));
  ui.sessionsTab.setAttribute('aria-selected', String(sessionsActive));
  ui.logsTab.setAttribute('aria-selected', String(logsActive));
  ui.inspectorTab.tabIndex = inspectorActive ? 0 : -1;
  ui.sessionsTab.tabIndex = sessionsActive ? 0 : -1;
  ui.logsTab.tabIndex = logsActive ? 0 : -1;
  ui.inspectorPanel.hidden = !inspectorActive;
  ui.sessionsPanel.hidden = !sessionsActive;
  ui.logsPanel.hidden = !logsActive;
  const activeButton = inspectorActive ? ui.inspectorTab : sessionsActive ? ui.sessionsTab : ui.logsTab;
  if (focus) activeButton.focus();
  if (sessionsActive) void refreshThreads(true);
}

function handleTabKeydown(event: KeyboardEvent): void {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
  event.preventDefault();
  const tabs: Array<{ button: HTMLButtonElement; tab: PanelTab }> = [
    { button: ui.inspectorTab, tab: 'inspector' },
    { button: ui.sessionsTab, tab: 'sessions' },
    { button: ui.logsTab, tab: 'logs' },
  ];
  const current = Math.max(0, tabs.findIndex(({ button }) => button === document.activeElement));
  const next = event.key === 'Home' ? 0
    : event.key === 'End' ? tabs.length - 1
      : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  setActiveTab(tabs[next]!.tab, true);
}

function wireEvents(): () => void {
  ui.newGoalButton.addEventListener('click', () => openGoalDialog());
  ui.emptyNewGoalButton.addEventListener('click', () => openGoalDialog());
  ui.dialogCloseButton.addEventListener('click', closeGoalDialog);
  ui.dialogCancelButton.addEventListener('click', closeGoalDialog);
  ui.form.addEventListener('submit', (event) => { void submitGoal(event); });
  ui.goalDialog.addEventListener('close', () => {
    attachSession = null;
    attachments = [];
    renderAttachments();
    ui.attachmentDropzone.classList.remove('is-dragging');
    attachmentDragDepth = 0;
  });
  ui.resumeCloseButton.addEventListener('click', closeResumeDialog);
  ui.resumeCancelButton.addEventListener('click', closeResumeDialog);
  ui.resumeForm.addEventListener('submit', (event) => { void resumeSelectedRun(event); });
  ui.resumeFullAccess.addEventListener('change', updateResumeDangerConfirmation);
  ui.objectiveInput.addEventListener('input', () => {
    ui.objectiveCount.textContent = `${numberFormatter.format(ui.objectiveInput.value.length)} caracteres`;
  });
  ui.attachmentPickerButton.addEventListener('click', () => { void chooseAttachments(); });
  ui.attachmentDropzone.addEventListener('dragenter', (event) => {
    event.preventDefault();
    attachmentDragDepth += 1;
    ui.attachmentDropzone.classList.add('is-dragging');
  });
  ui.attachmentDropzone.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });
  ui.attachmentDropzone.addEventListener('dragleave', () => {
    attachmentDragDepth = Math.max(0, attachmentDragDepth - 1);
    if (attachmentDragDepth === 0) ui.attachmentDropzone.classList.remove('is-dragging');
  });
  ui.attachmentDropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    attachmentDragDepth = 0;
    ui.attachmentDropzone.classList.remove('is-dragging');
    if (event.dataTransfer?.files.length) void addDroppedFiles(event.dataTransfer.files);
  });
  ui.dangerFullAccess.addEventListener('change', updateDangerConfirmation);
  ui.workspacePickerButton.addEventListener('click', () => { void chooseWorkspace(); });
  ui.binaryPickerButton.addEventListener('click', () => { void chooseBinary(); });
  ui.modelsRefreshButton.addEventListener('click', () => { void refreshModels(); });
  ui.modelInput.addEventListener('input', selectModelDefaults);
  ui.effortInput.addEventListener('change', () => {
    if (!attachSession) preferredNewEffort = effortValue(ui.effortInput.value);
  });
  ui.doctorButton.addEventListener('click', () => { void runDoctor(); });
  ui.dialogDoctorButton.addEventListener('click', () => { void runDoctor(); });
  ui.threadsRefreshButton.addEventListener('click', () => { void refreshThreads(); });
  ui.inspectOpenCodexButton.addEventListener('click', () => {
    const run = selectedRun();
    if (run?.threadId) void openThreadInCodex(run.threadId, run.name || 'Sesión');
  });
  ui.resumeButton.addEventListener('click', openResumeDialog);
  ui.pauseButton.addEventListener('click', () => { void pauseSelectedRun(); });
  ui.clearLogsButton.addEventListener('click', clearLogs);
  ui.inspectorTab.addEventListener('click', () => setActiveTab('inspector'));
  ui.sessionsTab.addEventListener('click', () => setActiveTab('sessions'));
  ui.logsTab.addEventListener('click', () => setActiveTab('logs'));
  ui.inspectorTab.addEventListener('keydown', handleTabKeydown);
  ui.sessionsTab.addEventListener('keydown', handleTabKeydown);
  ui.logsTab.addEventListener('keydown', handleTabKeydown);
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
      event.preventDefault();
      openGoalDialog();
    }
  });
  return api.onEvent(handleDesktopEvent);
}

async function initialize(): Promise<void> {
  configureEfforts(null, false);
  setActiveTab('inspector');
  updateLogMeta();
  render();
  try {
    const info = await api.systemInfo();
    ui.systemVersion.textContent = `v${info.version} · ${info.platform}/${info.arch}`;
  } catch (error) {
    ui.systemVersion.textContent = 'Versión no disponible';
    appendLog('warn', `Sistema: ${errorText(error)}`);
  }
  await Promise.all([refreshRuns(true), runDoctor(false)]);
}

const unsubscribe = wireEvents();
const pollTimer = window.setInterval(() => { void refreshRuns(true); }, 2_000);
window.addEventListener('beforeunload', () => {
  window.clearInterval(pollTimer);
  unsubscribe();
}, { once: true });

void initialize();
