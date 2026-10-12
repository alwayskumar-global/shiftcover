import { readdirSync, readFileSync } from 'node:fs';
import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as schema from './schema';

const migrations = readdirSync('drizzle')
  .filter((f) => f.endsWith('.sql'))
  .map((f) => ({ f, sql: readFileSync(`drizzle/${f}`, 'utf8') }));
const rls = migrations.find((m) => m.f.includes('rls_lockdown'))?.sql ?? '';

describe('RLS lockdown migration (static; live check is `npm run db:verify-rls`)', () => {
  it('exists and enables RLS on every table in public via a catalog loop', () => {
    expect(rls).toMatch(/FROM pg_tables WHERE schemaname = 'public'/);
    expect(rls).toMatch(/ENABLE ROW LEVEL SECURITY/);
  });

  it('every app table lives in the public schema, so the loop covers it', () => {
    const tables = Object.values(schema).filter((v): v is typeof schema.orgs => is(v, PgTable));
    expect(tables.length).toBe(13);
    for (const t of tables) expect(getTableConfig(t).schema).toBeUndefined();
  });

  it('revokes from anon, authenticated and service_role only when they exist', () => {
    for (const r of ['anon', 'authenticated', 'service_role']) expect(rls).toContain(`'${r}'`);
    expect(rls).toMatch(/IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = r\)/);
    expect(rls).toMatch(/REVOKE ALL ON ALL TABLES IN SCHEMA public/);
    expect(rls).toMatch(/ALTER DEFAULT PRIVILEGES/);
  });

  it('never grants anything to the API roles', () => {
    for (const m of migrations) expect(m.sql).not.toMatch(/\bGRANT\b/i);
  });
});

describe('0003 ledger function search_path (advisor WARN function_search_path_mutable)', () => {
  const m = migrations.find((x) => x.f.includes('ledger_fn_search_path'))?.sql ?? '';
  const fn = migrations.find((x) => x.f.includes('ledger_append_only'))?.sql ?? '';

  it('pins an empty search_path, guarded by an existence check', () => {
    expect(m).toMatch(/to_regprocedure\('public\.ledger_entries_append_only\(\)'\) IS NOT NULL/);
    expect(m).toMatch(/ALTER FUNCTION public\.ledger_entries_append_only\(\) SET search_path = ''/);
  });

  it('is safe with an empty search_path: the function body only raises', () => {
    const body = /AS \$\$([\s\S]*?)\$\$ LANGUAGE plpgsql/.exec(fn)?.[1] ?? '';
    expect(body).toMatch(/RAISE EXCEPTION/);
    expect(body).not.toMatch(/\b(SELECT|INSERT|UPDATE|DELETE|FROM|JOIN)\b/i);
  });
});
