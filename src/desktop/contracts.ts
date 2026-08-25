import type { BinaryInfo } from '../app-server/binary.js';
import type { GoalInfo, ModelInfo, ThreadInfo } from '../app-server/client.js';
import type { RunState } from '../state.js';

export type { ModelInfo };

export const DESKTOP_ORIGIN = 'codex-infinite://app';
export const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export const MAX_ATTACHMENTS = 100;

export type Effort = typeof EFFORTS[number];
export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface StartRunInput {
  objective: string;
  attachments: string[];
  workspace: string;
  name: string | null;
  maxTurns: number;
  maxHours: number;
  turnMinutes: number;
  tokenBudget: number | null;
  verifyCommands: string[];
  model: string | null;
  effort: Effort | null;
  network: boolean;
  dangerFullAccess: boolean;
  dangerConfirmation: boolean;
  binary: string | null;
}

export interface ResumeRunInput {
  runId: string;
  verifyCommands: string[];
  network: boolean;
  dangerFullAccess: boolean;
  dangerConfirmation: boolean;
  binary: string | null;
}

export interface AttachRunInput extends StartRunInput {
  threadId: string;
}

export interface DoctorInput {
  workspace: string | null;
  binary: string | null;
}

export interface ThreadsInput {
  workspace: string | null;
  binary: string | null;
  limit: number;
}

export interface DesktopSessionInfo {
  thread: ThreadInfo;
  goal: GoalInfo | null;
  goalError: string | null;
  localRun: RunState | null;
  operationActive: boolean;
  canEnable: boolean;
  canDisable: boolean;
  unavailableReason: string | null;
}

export interface DoctorResult {
  ok: boolean;
  binary: BinaryInfo;
  authentication: string | null;
  planType: string | null;
  desktopThreadsVisible: boolean;
  dataDirectory: string;
}

export interface SystemInfo {
  platform: NodeJS.Platform;
  arch: string;
  version: string;
}

export interface OperationReceipt {
  operationId: string;
}

export interface LocalAttachment {
  path: string;
  name: string;
  size: number;
}

export type DesktopEvent =
  | { type: 'operation-started'; operationId: string; runId: string | null; kind: 'start' | 'attach' | 'resume' | 'pause' }
  | { type: 'run-changed'; operationId: string; run: RunState }
  | { type: 'operation-finished'; operationId: string; run: RunState }
  | { type: 'operation-error'; operationId: string; runId: string | null; error: { code: string; message: string } }
  | { type: 'log'; operationId: string; level: LogLevel; message: string; timestamp: string };

export interface DesktopApi {
  systemInfo(): Promise<SystemInfo>;
  doctor(input: DoctorInput): Promise<DoctorResult>;
  chooseWorkspace(): Promise<string | null>;
  chooseBinary(): Promise<string | null>;
  chooseAttachments(): Promise<LocalAttachment[]>;
  inspectAttachments(paths: string[]): Promise<LocalAttachment[]>;
  pathForFile(file: File): string | null;
  listRuns(): Promise<RunState[]>;
  getRun(runId: string): Promise<RunState>;
  startRun(input: StartRunInput): Promise<OperationReceipt>;
  attachRun(input: AttachRunInput): Promise<OperationReceipt>;
  resumeRun(input: ResumeRunInput): Promise<OperationReceipt>;
  pauseRun(runId: string): Promise<OperationReceipt>;
  openCodexThread(threadId: string): Promise<void>;
  listModels(input: DoctorInput): Promise<ModelInfo[]>;
  listThreads(input: ThreadsInput): Promise<ThreadInfo[]>;
  listSessions(input: ThreadsInput): Promise<DesktopSessionInfo[]>;
  onEvent(listener: (event: DesktopEvent) => void): () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === [...expected].sort()[index]);
}

function boundedString(value: unknown, maximum: number, nullable = false): value is string | null {
  return (nullable && value === null) || (typeof value === 'string' && value.length <= maximum);
}

function boundedNumber(value: unknown, minimum: number, maximum: number, integer = false): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
    && (!integer || Number.isSafeInteger(value));
}

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 20
    && value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 4000);
}

function attachmentList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_ATTACHMENTS
    && value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 32_767
      && /^(?:[a-z]:[\\/]|\\\\|\/)/iu.test(item) && !/[\x00-\x1f\x7f]/u.test(item))
    && new Set(value).size === value.length;
}

function runId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function threadId(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
}

export function parseStartRunInput(value: unknown): StartRunInput {
  const keys = [
    'attachments', 'binary', 'dangerConfirmation', 'dangerFullAccess', 'effort', 'maxHours', 'maxTurns', 'model', 'name',
    'network', 'objective', 'tokenBudget', 'turnMinutes', 'verifyCommands', 'workspace',
  ];
  if (!isRecord(value) || !exactKeys(value, keys)
    || typeof value.objective !== 'string' || value.objective.trim().length === 0
    || !attachmentList(value.attachments)
    || typeof value.workspace !== 'string' || value.workspace.length === 0 || value.workspace.length > 32_767
    || !boundedString(value.name, 128, true)
    || !boundedNumber(value.maxTurns, 1, 1000, true)
    || !boundedNumber(value.maxHours, 0.01, 720)
    || !boundedNumber(value.turnMinutes, 0.01, 1440)
    || !(value.tokenBudget === null || boundedNumber(value.tokenBudget, 1, 2_000_000_000, true))
    || !stringList(value.verifyCommands)
    || !boundedString(value.model, 256, true)
    || !(value.effort === null || EFFORTS.includes(value.effort as Effort))
    || typeof value.network !== 'boolean'
    || typeof value.dangerFullAccess !== 'boolean'
    || typeof value.dangerConfirmation !== 'boolean'
    || !boundedString(value.binary, 32_767, true)) {
    throw new TypeError('Parametros de inicio invalidos.');
  }
  if (value.dangerFullAccess && !value.dangerConfirmation) throw new TypeError('Confirma el acceso total antes de iniciar.');
  return value as unknown as StartRunInput;
}

export function parseAttachRunInput(value: unknown): AttachRunInput {
  if (!isRecord(value) || !threadId(value.threadId)) throw new TypeError('Parametros de adjuncion invalidos.');
  const { threadId: parsedThreadId, ...start } = value;
  return { ...parseStartRunInput(start), threadId: parsedThreadId };
}

export function parseResumeRunInput(value: unknown): ResumeRunInput {
  const keys = ['binary', 'dangerConfirmation', 'dangerFullAccess', 'network', 'runId', 'verifyCommands'];
  if (!isRecord(value) || !exactKeys(value, keys) || !runId(value.runId) || !stringList(value.verifyCommands)
    || typeof value.network !== 'boolean' || typeof value.dangerFullAccess !== 'boolean'
    || typeof value.dangerConfirmation !== 'boolean' || !boundedString(value.binary, 32_767, true)) {
    throw new TypeError('Parametros de reanudacion invalidos.');
  }
  if (value.dangerFullAccess && !value.dangerConfirmation) throw new TypeError('Confirma el acceso total antes de reanudar.');
  return value as unknown as ResumeRunInput;
}

export function parseDoctorInput(value: unknown): DoctorInput {
  const keys = ['binary', 'workspace'];
  if (!isRecord(value) || !exactKeys(value, keys)
    || !boundedString(value.workspace, 32_767, true) || !boundedString(value.binary, 32_767, true)) {
    throw new TypeError('Parametros de diagnostico invalidos.');
  }
  return value as unknown as DoctorInput;
}

export function parseThreadsInput(value: unknown): ThreadsInput {
  const keys = ['binary', 'limit', 'workspace'];
  if (!isRecord(value) || !exactKeys(value, keys) || !boundedString(value.workspace, 32_767, true)
    || !boundedString(value.binary, 32_767, true) || !boundedNumber(value.limit, 1, 100, true)) {
    throw new TypeError('Parametros de threads invalidos.');
  }
  return value as unknown as ThreadsInput;
}

export function parseRunId(value: unknown): string {
  if (!runId(value)) throw new TypeError('Run ID invalido.');
  return value;
}

export function parseThreadId(value: unknown): string {
  if (!threadId(value)) throw new TypeError('Thread ID invalido.');
  return value;
}

export function codexThreadDeepLink(value: unknown): string {
  return `codex://threads/${parseThreadId(value).toLowerCase()}`;
}

export function parseAttachmentPaths(value: unknown): string[] {
  if (!attachmentList(value)) throw new TypeError('Rutas de archivos adjuntos invalidas.');
  return value;
}
