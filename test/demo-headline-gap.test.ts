import { describe, expect, it } from 'vitest';
import { MATCHING } from '../src/config/matching';
import { filterReasons, rankCandidates } from '../src/domain/matching';
import { demoCandidates, headlineGap } from '../scripts/lib/demo-data';

// Locks the demo story: who is offered the headline gap (Line cook, 7:00-15:00) and in what order.
const TODAY = '2026-10-14';
const gap = headlineGap(TODAY);
const cands = demoCandidates(TODAY);
const exceptMaria = cands.filter((c) => c.name !== 'Maria Alvarez'); // she called out; the replaced-slot rule drops her

describe('headline gap: Line cook, today 7:00-15:00, Maple & Rye', () => {
  it('exactly Jordan, Marcus and Chloe are eligible, in that order', () => {
    const { ranked } = rankCandidates(exceptMaria, gap, MATCHING);
    expect(ranked.map((r) => r.name)).toEqual(['Jordan Reyes', 'Marcus Lee', 'Chloe Dubois']);
  });

  it('front-of-house and bar staff are not eligible without explicit cross-training', () => {
    for (const name of [
      'Devon Brooks',
      'Aisha Khan',
      'Priya Nair',
      'Sam Whitfield',
      'Tom Okafor',
    ]) {
      const c = cands.find((x) => x.name === name)!;
      expect(filterReasons(c, gap, MATCHING)).toContain('role_mismatch');
    }
  });

  it('Lena is excluded for her expired certification only', () => {
    const lena = cands.find((c) => c.name === 'Lena Park')!;
    expect(filterReasons(lena, gap, MATCHING)).toEqual(['certification_missing_or_expired']);
  });

  it('the cross-trained cooks (prep + line) are the explicit exception', () => {
    for (const name of ['Marcus Lee', 'Chloe Dubois']) {
      const c = cands.find((x) => x.name === name)!;
      expect(c.skills).toEqual(['prep_cook', 'line_cook']);
      expect(filterReasons(c, gap, MATCHING)).toEqual([]);
    }
  });

  it('the order is stable across input order', () => {
    const a = rankCandidates([...exceptMaria].reverse(), gap, MATCHING).ranked.map((r) => r.name);
    expect(a).toEqual(['Jordan Reyes', 'Marcus Lee', 'Chloe Dubois']);
  });
});
