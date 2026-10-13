import { getServerEnv } from '../config/env';
import { getDb } from '../db/client';
import { createLlm, type LlmCallEvent, type LlmPort } from './gemini';
import { createDbUsageStore } from './usage-store';

/**
 * Production wiring of the guarded Gemini wrapper from validated env. Returns undefined when there is nothing to call
 * (kill switch off, or no key), so every caller takes its deterministic path without touching the network.
 * Server-only: this module reads GEMINI_API_KEY and must never be imported by client code.
 */
let cached: { key: string; llm: LlmPort } | undefined;

/** One line per call: component, outcome, latency, tokens. Never the prompt, the input or the output. */
const logCall = (e: LlmCallEvent) =>
  console.info(
    JSON.stringify({
      event: 'llm_call',
      component: e.component,
      ok: e.ok,
      reason: e.reason ?? null,
      ms: e.latencyMs,
      in: e.inputTokens,
      out: e.outputTokens,
    }),
  );

export function getLlm(): LlmPort | undefined {
  const env = getServerEnv();
  if (!env.LLM_ENABLED || !env.GEMINI_API_KEY) return undefined;
  if (cached?.key === env.GEMINI_API_KEY) return cached.llm;
  const llm = createLlm({
    apiKey: env.GEMINI_API_KEY,
    store: createDbUsageStore(getDb()),
    limits: {
      enabled: env.LLM_ENABLED,
      maxOutputTokens: env.LLM_MAX_OUTPUT_TOKENS,
      dailyCallCap: env.LLM_DAILY_CALL_CAP,
      perUserHourlyCap: env.LLM_PER_USER_HOURLY_CAP,
    },
    onCall: logCall,
  });
  cached = { key: env.GEMINI_API_KEY, llm };
  return llm;
}
