/**
 * `npm run db:generate [-- --name=foo]`: drizzle-kit generate, then make the RLS guard automatic by
 * appending the standard RLS block to any new migration that creates tables.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { RLS_GUARD_SQL, RLS_MARKER } from './lib/rls-guard-sql';

const before = new Set(readdirSync('drizzle').filter((f) => f.endsWith('.sql')));
const run = spawnSync('npx', ['drizzle-kit', 'generate', ...process.argv.slice(2)], {
  stdio: 'inherit',
});
if (run.status !== 0) process.exit(run.status ?? 1);

for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql') && !before.has(x))) {
  const path = `drizzle/${f}`;
  const sql = readFileSync(path, 'utf8');
  if (/CREATE TABLE/i.test(sql) && !sql.includes(RLS_MARKER)) {
    appendFileSync(path, `\n--> statement-breakpoint\n${RLS_GUARD_SQL}`);
    console.log(`appended RLS guard to ${path}`);
  }
}
