import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stubSettle } from '../src/services/payments-stub';
import type { Db } from '../src/db/client';
import { assertLoopback } from '../e2e/env';

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f)) out.push(p);
  }
  return out;
}

describe('guards on test-only and local-only code paths', () => {
  it('the reconcile slot filter is never passed by production code, a job payload or an API', () => {
    const calls: string[] = [];
    for (const f of [...sourceFiles('src'), ...sourceFiles('app'), ...sourceFiles('scripts')]) {
      for (const [i, line] of readFileSync(f, 'utf8').split('\n').entries()) {
        if (/reconcilePayments\(/.test(line) && !/export async function/.test(line))
          calls.push(`${f}:${i + 1} ${line.trim()}`);
      }
    }
    // no source file (app, src or scripts) ever passes a second argument; the only production caller is the job
    for (const c of calls) expect(c).toMatch(/reconcilePayments\(deps\)/);
    const prod = calls.filter((c) => c.startsWith('src/') || c.startsWith('app/'));
    expect(prod).toHaveLength(1);
    expect(prod[0]).toMatch(/src\/jobs\/service-handlers\.ts/);
    const handler = readFileSync('src/jobs/service-handlers.ts', 'utf8');
    const block = handler.slice(
      handler.indexOf('reconcile_payments:'),
      handler.indexOf('fill_deadline:'),
    );
    expect(block).not.toMatch(/job\.data/); // the job's payload is not even read
    // no route or handler mentions the option
    for (const f of [...sourceFiles('app'), 'src/api/handlers.ts', 'src/api/dto.ts']) {
      expect(readFileSync(f, 'utf8')).not.toMatch(/slotIds/);
    }
  });

  it('local stub settlement refuses to run unless the mode is stub', async () => {
    for (const mode of ['paypal', '', 'production']) {
      await expect(stubSettle({} as Db, mode, 'slot', 'actor')).rejects.toMatchObject({
        code: 'stub_disabled',
      });
    }
  });

  it('the stub settlement is only reachable when the service config says stub, which env.ts refuses in production', () => {
    const pay = readFileSync('src/services/payments.ts', 'utf8');
    expect(pay).toMatch(/!deps\.payments && deps\.config\.paymentsMode === 'stub'/);
    const env = readFileSync('src/config/env.ts', 'utf8');
    expect(env).toMatch(/stub is not allowed in production/);
  });

  it('the e2e guard accepts only local addresses', () => {
    for (const ok of [
      'postgres://u:p@127.0.0.1:54329/db',
      'http://localhost:3300',
      'http://[::1]:3300',
    ])
      expect(() => assertLoopback(ok, 'x')).not.toThrow();
    for (const bad of [
      'postgres://u:p@aws-0-us-west-2.pooler.supabase.com:5432/postgres',
      'https://shiftcover-web.onrender.com',
      'http://127.0.0.1.evil.test',
      'not a url',
    ])
      expect(() => assertLoopback(bad, 'x')).toThrow(/e2e guard/);
  });
});
