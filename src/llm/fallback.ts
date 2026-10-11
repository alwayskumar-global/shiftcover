import type { LlmFailureReason } from './gemini';

/**
 * Deterministic fallbacks (Section 9.3 item 8). The demo must never break on an AI outage.
 * M0 ships the interface and stubs only; the rules parser and templates land in M3.
 */

export interface ParsedGapDraft {
  role: string;
  startAt: string; // ISO
  endAt: string; // ISO
  baseRateCents: number;
  maxPremiumPct: number;
}

export interface GapParser {
  parse(text: string, ctx: { now: Date; timezone: string }): ParsedGapDraft | null;
}

export interface Explainer {
  explainRanking(args: { workerName: string; scoreParts: Record<string, number> }): string;
  offerCopy(args: { role: string; venue: string; startsAt: string; payUsd: string }): string;
  shiftRecap(args: { role: string; hours: number; payUsd: string }): string;
}

/** Stub: returns null until the rules parser is implemented (M3). */
export const rulesGapParser: GapParser = {
  parse: () => null,
};

/** Stub templates; amounts are injected by code, never generated. */
export const templateExplainer: Explainer = {
  explainRanking: ({ workerName }) =>
    `${workerName} ranked by reliability, response speed, and distance.`,
  offerCopy: ({ role, venue, startsAt, payUsd }) =>
    `${role} shift at ${venue}, ${startsAt}. Pay: $${payUsd}.`,
  shiftRecap: ({ role, hours, payUsd }) => `${role}, ${hours}h, $${payUsd}.`,
};

/** Use the LLM result when present, otherwise the deterministic path. */
export function withFallback<T>(
  result: { ok: true; data: T } | { ok: false; reason: LlmFailureReason },
  fallback: () => T,
): { value: T; source: 'llm' | 'fallback' } {
  return result.ok
    ? { value: result.data, source: 'llm' }
    : { value: fallback(), source: 'fallback' };
}
