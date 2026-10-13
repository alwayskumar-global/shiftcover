import type { LlmFailureReason } from './gemini';

/**
 * Deterministic fallbacks (Section 9.3 item 8). The demo must never break on an AI outage.
 * The rules parser is the fallback for Gemini intake; the "why this worker" template lives in why-worker.ts.
 */

import { parseGapText, type GapParse } from '../domain/gap-parser';

export type ParsedGapDraft = GapParse;

export interface GapParser {
  parse(text: string, ctx: { now: Date; timezone: string }): ParsedGapDraft | null;
}

export interface Explainer {
  explainRanking(args: { workerName: string; scoreParts: Record<string, number> }): string;
  offerCopy(args: { role: string; venue: string; startsAt: string; payUsd: string }): string;
  shiftRecap(args: { role: string; hours: number; payUsd: string }): string;
}

/** Deterministic rules parser (M1). Gemini intake (M3) calls this first and falls back to it on any failure. */
export const rulesGapParser: GapParser = {
  parse: (text, ctx) => parseGapText(text, ctx),
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
