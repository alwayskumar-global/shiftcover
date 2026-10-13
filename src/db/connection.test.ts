import { describe, expect, it } from 'vitest';
import { buildPoolConfig, POOL_MAX, TOTAL_APP_CONNECTIONS } from './connection';

const URL_ = 'postgres://postgres.abc:pw@aws-0-x.pooler.supabase.com:5432/postgres?sslmode=disable';

describe('connection budget', () => {
  it('keeps the total at 10 or fewer', () => {
    expect(TOTAL_APP_CONNECTIONS).toBeLessThanOrEqual(10);
    expect(POOL_MAX.web).toBe(5);
    expect(POOL_MAX.worker).toBe(3);
  });
});

describe('buildPoolConfig', () => {
  it('forces TLS and strips URL sslmode so it cannot downgrade', () => {
    const c = buildPoolConfig(URL_, 'web');
    expect(c.ssl).toBeTruthy();
    expect(c.connectionString).not.toContain('sslmode');
    expect(c.max).toBe(5);
  });

  it('skips TLS only for loopback hosts', () => {
    expect(buildPoolConfig('postgres://postgres:test@127.0.0.1:54329/postgres', 'web').ssl).toBe(
      false,
    );
    expect(buildPoolConfig('postgres://u:p@localhost:5432/db', 'web').ssl).toBe(false);
    for (const host of ['db.internal.example', 'aws-0-x.pooler.supabase.com', '10.0.0.5']) {
      expect(buildPoolConfig(`postgres://u:p@${host}:5432/db`, 'web').ssl).toBeTruthy();
    }
  });

  it('sizes pools per role', () => {
    expect(buildPoolConfig(URL_, 'worker').max).toBe(3);
    expect(buildPoolConfig(URL_, 'boss').max).toBe(2);
    expect(buildPoolConfig(URL_, 'migrate').max).toBe(1);
  });
});
