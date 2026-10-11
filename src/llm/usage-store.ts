import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { llmUsage } from '../db/schema';
import type { UsageBucket, UsageStore } from './gemini';

/** llm_usage-backed spend guard (Section 9.3 item 5). */
export function createDbUsageStore(db: Db): UsageStore {
  const keyOf = (b: UsageBucket) => ({
    day: b.day,
    hourStart: b.hourStart,
    userKey: b.userKey,
    component: b.component,
    model: b.model,
  });

  return {
    async counts(b) {
      const [daily] = await db
        .select({ n: sql<number>`coalesce(sum(${llmUsage.calls}), 0)::int` })
        .from(llmUsage)
        .where(eq(llmUsage.day, b.day));
      const [hourly] = await db
        .select({ n: sql<number>`coalesce(sum(${llmUsage.calls}), 0)::int` })
        .from(llmUsage)
        .where(and(eq(llmUsage.hourStart, b.hourStart), eq(llmUsage.userKey, b.userKey)));
      return { dailyCalls: daily?.n ?? 0, userHourlyCalls: hourly?.n ?? 0 };
    },
    async reserveCall(b) {
      await db
        .insert(llmUsage)
        .values({ ...keyOf(b), calls: 1 })
        .onConflictDoUpdate({
          target: [llmUsage.hourStart, llmUsage.userKey, llmUsage.component, llmUsage.model],
          set: { calls: sql`${llmUsage.calls} + 1` },
        });
    },
    async addTokens(b, input, output) {
      await db
        .update(llmUsage)
        .set({
          inputTokens: sql`${llmUsage.inputTokens} + ${input}`,
          outputTokens: sql`${llmUsage.outputTokens} + ${output}`,
        })
        .where(
          and(
            eq(llmUsage.hourStart, b.hourStart),
            eq(llmUsage.userKey, b.userKey),
            eq(llmUsage.component, b.component),
            eq(llmUsage.model, b.model),
          ),
        );
    },
  };
}
