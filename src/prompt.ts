import type { AgentDecision } from './decision.js';
import type { VerificationRecord } from './state.js';

export function initialPrompt(objective: string): string {
  return [
    'Execute this durable Goal autonomously in the current repository:',
    objective,
    '',
    'Work like a senior engineer: inspect the real repository state, preserve unrelated changes, use Git deliberately, implement the requested result, and run proportionate checks.',
    'Do not wait for routine confirmation. If a genuinely necessary user decision or unavailable external authority blocks completion, report blocked.',
    'Your final message for every turn must contain only the JSON object required by the provided schema.',
    'Use status=continue while useful in-scope work remains. Use status=complete only when the objective is actually finished and verified. Include concrete evidence.',
  ].join('\n');
}

export function continuationPrompt(decision: AgentDecision, verification: VerificationRecord | null): string {
  const lines = [
    'Continue the same durable Goal. Do the next useful in-scope work now.',
    `Previous status: ${decision.status}`,
    `Previous summary: ${decision.summary}`,
    `Next action: ${decision.nextAction || 'Inspect current state and choose the next required action.'}`,
  ];
  if (verification && !verification.ok) {
    lines.push('Host-side verification failed. Fix the failures before claiming completion:');
    lines.push(...verification.summary.map((item) => item.slice(0, 4000)));
  }
  lines.push('Return only the JSON object required by the provided schema.');
  return lines.join('\n');
}
