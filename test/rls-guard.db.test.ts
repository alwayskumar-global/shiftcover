import { afterAll, describe, expect, it } from 'vitest';
import { createTestDb, hasTestDb } from './db';

describe.skipIf(!hasTestDb)('RLS guard (live schema after all migrations)', () => {
  const t = hasTestDb ? createTestDb(2) : undefined;
  afterAll(() => t?.close());

  it('every public table has row level security enabled', async () => {
    const r = await t!.pool.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r','p') and not c.relrowsecurity`,
    );
    expect(r.rows.map((x) => x.relname)).toEqual([]);
    const all = await t!.pool.query(
      `select count(*)::int as n from pg_tables where schemaname = 'public'`,
    );
    expect(all.rows[0].n).toBeGreaterThanOrEqual(19);
  });
});
