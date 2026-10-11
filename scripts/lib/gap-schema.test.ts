import { describe, expect, it } from 'vitest';
import fixtures from '../fixtures/gap-phrases.json';
import { gapSchema, scoreFields } from './gap-schema';

describe('gap fixtures', () => {
  it('has 20 cases whose expected values satisfy the schema', () => {
    expect(fixtures.cases).toHaveLength(20);
    for (const c of fixtures.cases) expect(gapSchema.safeParse(c.expected).success).toBe(true);
  });

  it('scores field-by-field', () => {
    const e = gapSchema.parse(fixtures.cases[0]!.expected);
    const s = scoreFields({ ...e, base_rate_cents: 1 }, e);
    expect(s.base_rate_cents).toBe(false);
    expect(s.role).toBe(true);
  });
});
