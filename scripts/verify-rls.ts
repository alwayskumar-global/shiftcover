/**
 * Verifies PLAN.md 6A / acceptance test 13 against the live database: RLS on for every public table,
 * and anon/authenticated/service_role hold no privileges on any of them. Read-only.
 * Run after migrating: npm run db:verify-rls   (needs DATABASE_URL in .env)
 */
import 'dotenv/config';
import { Pool } from 'pg';
import { getServerEnv } from '../src/config/env';
import { buildPoolConfig } from '../src/db/connection';

const ROLES = ['anon', 'authenticated', 'service_role'];

async function main() {
  const pool = new Pool(buildPoolConfig(getServerEnv().DATABASE_URL, 'migrate'));
  try {
    const tables = await pool.query<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p')
        order by c.relname`,
    );
    const roles = await pool.query<{ rolname: string }>(
      'select rolname from pg_roles where rolname = any($1)',
      [ROLES],
    );
    const problems: string[] = [];
    for (const t of tables.rows) {
      if (!t.relrowsecurity) problems.push(`RLS off: ${t.relname}`);
      for (const { rolname } of roles.rows) {
        const g = await pool.query<{ ok: boolean }>(
          `select has_table_privilege($1, format('public.%I', $2::text),
                  'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as ok`,
          [rolname, t.relname],
        );
        if (g.rows[0]?.ok) problems.push(`${rolname} has privileges on ${t.relname}`);
      }
    }
    console.log(
      `tables: ${tables.rows.length}, api roles present: ${roles.rows.map((r) => r.rolname).join(', ') || 'none'}`,
    );
    if (tables.rows.length === 0) problems.push('no tables found (migrations not applied?)');
    if (problems.length) {
      console.error('FAIL\n' + problems.map((p) => ` - ${p}`).join('\n'));
      process.exitCode = 1;
    } else {
      console.log('OK: RLS enabled on every public table; API roles have no privileges.');
    }
  } finally {
    await pool.end();
  }
}

main().catch((e: unknown) => {
  console.error('verify-rls failed:', e instanceof Error ? e.message : 'unknown error');
  process.exit(1);
});
