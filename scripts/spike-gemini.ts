/**
 * Spike: structured gap intake on 20 synthetic hospitality phrases with gemini-3.5-flash-lite.
 * Run ONLY after the env is set (needs GEMINI_API_KEY): npx tsx scripts/spike-gemini.ts
 * Uses the production wrapper, so every Section 9.3 guardrail applies (kill switch, caps, one retry).
 * Reports schema-valid rate, per-field accuracy, tokens, and estimated cost. Synthetic data only.
 */
import 'dotenv/config';
import { z } from 'zod';
import fixtures from './fixtures/gap-phrases.json';
import { GAP_FIELDS, gapSchema, scoreFields, type Gap } from './lib/gap-schema';
import { createLlm, LLM_MODEL, type UsageStore } from '../src/llm/gemini';

const envSchema = z.object({
  GEMINI_API_KEY: z.string().min(1),
  LLM_ENABLED: z.stringbool().default(true),
  LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1).default(1024),
  LLM_DAILY_CALL_CAP: z.coerce.number().int().min(0).default(500),
  LLM_PER_USER_HOURLY_CAP: z.coerce.number().int().min(0).default(20),
});

const parsedEnv = envSchema.safeParse(
  Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== '')),
);
if (!parsedEnv.success) {
  console.error('Missing/invalid env:', parsedEnv.error.issues.map((i) => i.path.join('.')).join(', '));
  process.exit(1);
}
const env = parsedEnv.data;

// Per-run in-memory usage store: the spike is a single process. The caps still apply to this run.
function memoryStore(): UsageStore & { calls: () => number } {
  let calls = 0;
  return {
    counts: async () => ({ dailyCalls: calls, userHourlyCalls: calls }),
    reserveCall: async () => {
      calls++;
    },
    addTokens: async () => undefined,
    calls: () => calls,
  };
}

const SYSTEM = [
  'You extract a staffing gap for a restaurant/cafe/catering venue from a manager message.',
  `Venue: ${fixtures.context.venue}. Current local time: ${fixtures.context.now} (${fixtures.context.timezone}).`,
  'Fields: role (one of the enum), date_offset_days (0 = today, 1 = tomorrow), start_time and end_time as local 24h HH:MM,',
  'base_rate_cents (USD cents per hour, null if no rate stated), max_premium_pct (whole percent the manager allows above the rate;',
  '0 if they say no surge; null if not stated). An overnight shift keeps date_offset_days of the start date.',
].join(' ');

async function main() {
  const store = memoryStore();
  const llm = createLlm({
    apiKey: env.GEMINI_API_KEY,
    store,
    limits: {
      enabled: env.LLM_ENABLED,
      maxOutputTokens: env.LLM_MAX_OUTPUT_TOKENS,
      dailyCallCap: env.LLM_DAILY_CALL_CAP,
      perUserHourlyCap: env.LLM_PER_USER_HOURLY_CAP,
    },
  });

  let valid = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cost = 0;
  const fieldHits = Object.fromEntries(GAP_FIELDS.map((f) => [f, 0])) as Record<keyof Gap, number>;
  let fullyCorrect = 0;
  const failures: string[] = [];

  for (const [i, c] of fixtures.cases.entries()) {
    // Sequential, no retry loops here: the wrapper owns the single allowed retry.
    const r = await llm.generateStructured({
      component: 'spike_intake',
      userKey: 'spike',
      system: SYSTEM,
      input: c.text,
      schema: gapSchema,
    });
    if (!r.ok) {
      failures.push(`#${i + 1}: ${r.reason}`);
      if (r.reason === 'disabled' || r.reason === 'daily_cap' || r.reason === 'user_cap') {
        console.error(`Stopping: ${r.reason}`);
        break;
      }
      continue;
    }
    valid++;
    inputTokens += r.usage.inputTokens;
    outputTokens += r.usage.outputTokens;
    cost += r.usage.estimatedCostUsd;
    const score = scoreFields(r.data, gapSchema.parse(c.expected));
    for (const f of GAP_FIELDS) if (score[f]) fieldHits[f]++;
    if (GAP_FIELDS.every((f) => score[f])) fullyCorrect++;
    else console.log(`#${i + 1} mismatch:`, GAP_FIELDS.filter((f) => !score[f]).join(', '));
  }

  const n = fixtures.cases.length;
  const pct = (x: number) => `${((x / n) * 100).toFixed(0)}%`;
  console.log('\n=== Gemini intake spike ===');
  console.log(`model: ${LLM_MODEL}   cases: ${n}   provider calls: ${store.calls()}`);
  console.log(`schema-valid: ${valid}/${n} (${pct(valid)})`);
  for (const f of GAP_FIELDS) console.log(`  ${f}: ${fieldHits[f]}/${n} (${pct(fieldHits[f])})`);
  console.log(`all fields correct: ${fullyCorrect}/${n} (${pct(fullyCorrect)})`);
  console.log(`tokens: input ${inputTokens}, output (incl. thinking) ${outputTokens}`);
  console.log(`estimated cost: $${cost.toFixed(5)}  (~$${(cost / Math.max(valid, 1)).toFixed(5)}/call)`);
  if (failures.length) console.log('failures:', failures.join('; '));
}

main().catch((e: unknown) => {
  console.error('spike failed:', e instanceof Error ? e.message : 'unknown error');
  process.exit(1);
});
