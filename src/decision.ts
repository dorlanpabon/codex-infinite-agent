import { AppError } from './errors.js';

export const COMPLETION_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['continue', 'complete', 'blocked'] },
    summary: { type: 'string', minLength: 1, maxLength: 4000 },
    evidence: {
      type: 'array',
      items: { type: 'string', minLength: 1, maxLength: 1000 },
      maxItems: 20,
    },
    nextAction: { type: 'string', maxLength: 2000 },
  },
  required: ['status', 'summary', 'evidence', 'nextAction'],
  additionalProperties: false,
} as const;

export type DecisionStatus = 'continue' | 'complete' | 'blocked';

export interface AgentDecision {
  status: DecisionStatus;
  summary: string;
  evidence: string[];
  nextAction: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseDecision(text: string): AgentDecision {
  let value: unknown;
  try {
    value = JSON.parse(text.trim());
  } catch (cause) {
    throw new AppError('INVALID_DECISION', 'Codex no devolvio JSON valido para el estado de la tarea.', 1, { cause });
  }

  if (!isRecord(value)) {
    throw new AppError('INVALID_DECISION', 'La respuesta estructurada de Codex no es un objeto.');
  }

  const allowed = new Set(['status', 'summary', 'evidence', 'nextAction']);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new AppError('INVALID_DECISION', 'La respuesta estructurada de Codex contiene campos desconocidos.');
  }

  const { status, summary, evidence, nextAction } = value;
  if (status !== 'continue' && status !== 'complete' && status !== 'blocked') {
    throw new AppError('INVALID_DECISION', 'Estado de tarea no reconocido.');
  }
  if (typeof summary !== 'string' || summary.trim().length === 0 || summary.length > 4000) {
    throw new AppError('INVALID_DECISION', 'Resumen de tarea invalido.');
  }
  if (!Array.isArray(evidence) || evidence.length > 20 || evidence.some((item) => typeof item !== 'string' || item.trim().length === 0 || item.length > 1000)) {
    throw new AppError('INVALID_DECISION', 'Evidencia de tarea invalida.');
  }
  if (typeof nextAction !== 'string' || nextAction.length > 2000) {
    throw new AppError('INVALID_DECISION', 'Siguiente accion invalida.');
  }

  return { status, summary: summary.trim(), evidence: evidence.map((item) => item.trim()), nextAction: nextAction.trim() };
}
