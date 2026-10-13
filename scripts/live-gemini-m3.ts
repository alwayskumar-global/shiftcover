/**
 * M3 live check, LOCAL only: one real gap-intake call and one real "why this worker" call against Gemini with the
 * existing key, using SYNTHETIC data (the demo phrase and made-up candidate facts). Needs GEMINI_API_KEY in .env.
 *   npx tsx scripts/live-gemini-m3.ts
 * Prints only: source, latency, token counts and whether the result matched the expected fields. Never the key, the
 * prompt, or the raw model output. In-memory usage store: no database is touched.
 */
import 'dotenv/config';
import { addDaysToDateString, localDateString } from '../src/lib/time';
import { createLlm, LLM_MODEL, type LlmCallEvent, type UsageStore } from '../src/llm/gemini';
import { parseGapWithLlm } from '../src/llm/intake';
import { createWhyService, templateReason, type WhyFacts } from '../src/llm/why-worker';

const key = process.env.GEMINI_API_KEY;
if (!key) {
  console.error('GEMINI_API_KEY is not set');
  process.exit(1);
}
const events: LlmCallEvent[] = [];
const mem = (): UsageStore => {
  let n = 0;
  return {
    counts: async () => ({ dailyCalls: n, userHourlyCalls: n }),
    reserveCall: async () => void n++,
    addTokens: async () => undefined,
  };
};
const llm = createLlm({
  apiKey: key,
  store: mem(),
  limits: { enabled: true, maxOutputTokens: 1024, dailyCallCap: 10, perUserHourlyCap: 10 },
  onCall: (e) => events.push(e),
});

const TZ = 'America/Los_Angeles';
const DEMO = 'Maria called in sick, need a line cook 7 to 3 tomorrow';

async function main() {
  console.log(`model: ${LLM_MODEL}`);
  const now = new Date();
  const tomorrow = addDaysToDateString(localDateString(now, TZ), 1);

  // 1. gap intake
  const r = await parseGapWithLlm(llm, DEMO, {
    now,
    timezone: TZ,
    venueName: 'Maple & Rye',
    userKey: 'live-check',
  });
  const e1 = events.at(-1)!;
  if (r.ok) {
    const p = r.parse;
    const hhmm = (d: Date | null) =>
      d
        ? new Intl.DateTimeFormat('en-GB', {
            timeZone: TZ,
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
          }).format(d)
        : null;
    const checks = {
      role: p.role === 'line_cook',
      date: p.startAt ? localDateString(p.startAt, TZ) === tomorrow : false,
      start: hhmm(p.startAt) === '07:00',
      end: hhmm(p.endAt) === '15:00',
      rate_not_invented: p.baseRateCents === null,
      premium_not_invented: p.maxPremiumPct === null,
    };
    console.log(
      `INTAKE  source=llm  latency=${e1.latencyMs}ms  tokens in=${e1.inputTokens} out=${e1.outputTokens}  matched=${Object.values(checks).every(Boolean)}`,
      JSON.stringify(checks),
    );
  } else {
    console.log(
      `INTAKE  source=rules (fallback_reason=${r.reason})  latency=${e1.latencyMs}ms  tokens in=${e1.inputTokens} out=${e1.outputTokens}`,
    );
  }

  // 2. why this worker, with made-up facts (no names, no contact details)
  const facts: WhyFacts[] = [
    {
      workerId: 'w1',
      rank: 1,
      role: 'line_cook',
      skills: ['line_cook', 'prep_cook'],
      distanceMi: 2.4,
      shiftsHere: 14,
      reliability: 0.94,
      parts: { reliability: 0.94, acceptance: 0.85, response: 0.8, distance: 0.9, venueHistory: 1 },
    },
    {
      workerId: 'w2',
      rank: 2,
      role: 'line_cook',
      skills: ['line_cook'],
      distanceMi: 6.1,
      shiftsHere: 3,
      reliability: 0.82,
      parts: {
        reliability: 0.82,
        acceptance: 0.7,
        response: 0.6,
        distance: 0.75,
        venueHistory: 0.3,
      },
    },
  ];
  const why = createWhyService({ llm });
  why.get('live-slot', 'live-check', facts);
  await why.settled();
  const e2 = events.at(-1)!;
  const out = why.get('live-slot', 'live-check', facts);
  const sources = facts.map((f) => out.get(f.workerId)!.source);
  console.log(
    `WHY     source=${sources.every((s) => s === 'llm') ? 'llm' : sources.join('+')}  latency=${e2.latencyMs}ms  tokens in=${e2.inputTokens} out=${e2.outputTokens}  reasons=${facts.length}  accepted=${sources.filter((s) => s === 'llm').length}/${facts.length}  differ_from_template=${facts.every((f) => out.get(f.workerId)!.text !== templateReason(f))}`,
  );
  console.log(
    `calls: ${events.length}, failures: ${
      events
        .filter((e) => !e.ok)
        .map((e) => e.reason)
        .join(',') || 'none'
    }`,
  );
}

main().catch((e: unknown) => {
  console.error('live check failed:', e instanceof Error ? e.message : 'unknown error');
  process.exit(1);
});
