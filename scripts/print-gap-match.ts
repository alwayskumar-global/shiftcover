/**
 * Prints who is eligible for the headline gap (Line cook, today 7:00-15:00, Maple & Rye) and why not,
 * from the demo data alone (no database). npx tsx scripts/print-gap-match.ts
 */
import { MATCHING } from '../src/config/matching';
import { filterReasons, rankCandidates } from '../src/domain/matching';
import { localDateString } from '../src/lib/time';
import { demoCandidates, headlineGap, TZ } from './lib/demo-data';

const today = localDateString(new Date(), TZ);
const gap = headlineGap(today);
const cands = demoCandidates(today);
const { ranked } = rankCandidates(
  cands.filter((c) => c.name !== 'Maria Alvarez'),
  gap,
  MATCHING,
);
const rows = cands.map((c) => {
  if (c.name === 'Maria Alvarez')
    return {
      worker: c.name,
      skills: c.skills.join('+'),
      eligible: 'no',
      firstFailingFilter: 'called_out',
      rank: '-',
      score: '-',
      rel: '-',
      acc: '-',
      resp: '-',
      dist: '-',
      hist: '-',
    };
  const reasons = filterReasons(c, gap, MATCHING);
  const r = ranked.find((x) => x.workerId === c.workerId);
  const f = (n: number | undefined) => (n === undefined ? '-' : n.toFixed(3));
  return {
    worker: c.name,
    skills: c.skills.join('+'),
    eligible: reasons.length ? 'no' : 'yes',
    firstFailingFilter: reasons[0] ?? '-',
    rank: r ? String(ranked.indexOf(r) + 1) : '-',
    score: f(r?.score),
    rel: f(r?.parts.reliability),
    acc: f(r?.parts.acceptance),
    resp: f(r?.parts.response),
    dist: f(r?.parts.distance),
    hist: f(r?.parts.venueHistory),
  };
});
console.log(`Headline gap: Line cook, ${today} 07:00-15:00 (${TZ})`);
console.table(rows);
