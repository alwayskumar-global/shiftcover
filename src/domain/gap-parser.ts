import { addDaysToDateString, localDateString, zonedTimeToUtc } from '../lib/time';
import type { ShiftRole } from './roles';

/**
 * Deterministic rules-based gap parser (PLAN.md 9.3 item 8). Handles the seeded demo phrases without
 * any LLM. Free text is data: only fixed patterns are extracted, nothing is executed or followed.
 */

export interface GapParse {
  role: ShiftRole | null;
  startAt: Date | null;
  endAt: Date | null;
  /** null = not stated in the text. */
  baseRateCents: number | null;
  /** null = not stated; 0 = explicitly no surge. */
  maxPremiumPct: number | null;
  calledOutName: string | null;
  /** Fields the manager must fill in on the parsed card. */
  missing: Array<'role' | 'time' | 'baseRate'>;
}

const ROLE_PATTERNS: Array<[RegExp, ShiftRole]> = [
  [/\bbar[\s-]?back\b/, 'bar_back'],
  [/\bbartend\w*|\bbarkeep\w*/, 'bartender'],
  [/\bsous\b|\bprep\b/, 'prep_cook'],
  [/\bline cook\b|\bgrill\b|\bcook\b|\bchef\b/, 'line_cook'],
  [/\bdish\w*|\bpit\b/, 'dishwasher'],
  [/\bbarista\b/, 'barista'],
  [/\bhost(ess)?\b/, 'host'],
  [/\bevent (crew|staff)\b|\bcatering\b|\breception staff\b|\bcrew member\b/, 'event_staff'],
  [/\bserver\b|\bwaiter\b|\bwaitress\b|\bwait ?staff\b/, 'server'],
];

const HOURLY = String.raw`(?:\/|per\s|an?\s)\s*(?:h(?:ou)?r|hourly)|\s*hourly`;

function parseRate(text: string): number | null {
  // Prefer an explicitly hourly figure; the LAST one wins (later text is the instruction, earlier is noise).
  const marked = [
    ...text.matchAll(new RegExp(String.raw`\$?\s*(\d{1,3}(?:\.\d{1,2})?)\s*(?:${HOURLY})`, 'g')),
  ];
  if (marked.length) return Math.round(Number(marked[marked.length - 1]![1]) * 100);
  const bare = text.match(/\$\s*(\d{1,3}(?:\.\d{1,2})?)/);
  if (bare) return Math.round(Number(bare[1]) * 100);
  const pay = text.match(/\bpay(?:s|ing)?\s+(\d{1,3}(?:\.\d{1,2})?)\b/);
  if (pay) return Math.round(Number(pay[1]) * 100);
  return null;
}

function parsePremium(text: string): number | null {
  if (/\bno\s+(surge|premium|bump|extra)\b|\bwithout (surge|premium)\b/.test(text)) return 0;
  const m = text.match(/(\d{1,3})\s*%/);
  if (m) {
    const n = Number(m[1]);
    return n >= 0 && n <= 100 ? n : null;
  }
  return null;
}

interface Clock {
  hour: number; // as written (0-24)
  minute: number;
  meridiem: 'am' | 'pm' | null;
}

function to24(c: Clock): number {
  if (c.meridiem === 'am') return c.hour === 12 ? 0 : c.hour;
  if (c.meridiem === 'pm') return c.hour === 12 ? 12 : c.hour + 12;
  return c.hour;
}

function parseTimes(text: string, cue: 'am' | 'pm' | null): { start: number; end: number } | null {
  const re =
    /(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\s*(?:-|–|—|to|until|till)\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/;
  const m = re.exec(text);
  if (!m) return null;
  const mer = (s?: string): 'am' | 'pm' | null => (s ? (s.startsWith('a') ? 'am' : 'pm') : null);
  const a: Clock = { hour: Number(m[1]), minute: Number(m[2] ?? 0), meridiem: mer(m[3]) };
  const b: Clock = { hour: Number(m[4]), minute: Number(m[5] ?? 0), meridiem: mer(m[6]) };
  if (a.hour > 24 || b.hour > 24 || a.minute > 59 || b.minute > 59) return null;

  const is24h = a.hour > 12 || b.hour > 12 || a.hour === 0 || (!!m[2] && a.hour >= 13);
  let startMin: number;
  let endMin: number;
  if (a.meridiem || b.meridiem || is24h) {
    if (!a.meridiem && !is24h) a.meridiem = b.meridiem; // "5-9pm"
    if (!b.meridiem && !is24h && a.meridiem) {
      // "7am-3": end defaults to the next occurrence after start
      b.meridiem = null;
    }
    startMin = to24(a) * 60 + a.minute;
    if (b.meridiem || is24h) {
      endMin = to24(b) * 60 + b.minute;
    } else {
      endMin = nextAfter(b.hour, b.minute, startMin);
    }
    if (is24h && !a.meridiem) startMin = a.hour * 60 + a.minute;
  } else {
    // No meridiem anywhere: use the cue, else business-day convention (1-6 -> pm, 7-11 -> am).
    const startHour =
      cue === 'pm'
        ? a.hour === 12
          ? 12
          : a.hour + 12
        : cue === 'am'
          ? a.hour === 12
            ? 0
            : a.hour
          : a.hour >= 7 && a.hour <= 11
            ? a.hour
            : a.hour === 12
              ? 12
              : a.hour + 12;
    startMin = startHour * 60 + a.minute;
    endMin = nextAfter(b.hour, b.minute, startMin);
  }
  if (endMin <= startMin) endMin += 24 * 60; // overnight
  return { start: startMin, end: endMin };
}

/** Smallest clock reading `hour:minute` (12h-ambiguous) that is later than `afterMin`. */
function nextAfter(hour: number, minute: number, afterMin: number): number {
  const candidates = hour === 12 ? [12, 24] : [hour, hour + 12, hour + 24];
  for (const h of candidates) {
    const t = h * 60 + minute;
    if (t > afterMin) return t;
  }
  return (hour + 24) * 60 + minute;
}

export function parseGapText(text: string, ctx: { now: Date; timezone: string }): GapParse {
  const raw = text.replace(/\s+/g, ' ').trim();
  const t = raw.toLowerCase();

  let role: ShiftRole | null = null;
  for (const [re, r] of ROLE_PATTERNS) {
    if (re.test(t)) {
      role = r;
      break;
    }
  }

  const baseRateCents = parseRate(t);
  const maxPremiumPct = parsePremium(t);

  // Strip money/percent tokens so they cannot be mistaken for times.
  const cleaned = t
    .replace(/\$\s*\d+(?:\.\d+)?/g, ' ')
    .replace(new RegExp(String.raw`\d+(?:\.\d+)?\s*(?:${HOURLY})`, 'g'), ' ')
    .replace(/\d+\s*%/g, ' ')
    .replace(/\b(?:up to|max|pay)\s+\d+\b/g, ' ')
    .replace(/\b12\s*noon\b|\bnoon\b/g, '12pm')
    .replace(/\bmidnight\b/g, '12am');

  const cue: 'am' | 'pm' | null = /\bmorning\b|\bbreakfast\b/.test(t)
    ? 'am'
    : /\bevening\b|\btonight\b|\bdinner\b|\bnight\b/.test(t)
      ? 'pm'
      : null;

  const times = parseTimes(cleaned, cue);
  const dayOffset = /\btomorrow\b|\btmrw\b|\btmr\b/.test(t) ? 1 : 0;
  let startAt: Date | null = null;
  let endAt: Date | null = null;
  if (times) {
    const date = addDaysToDateString(localDateString(ctx.now, ctx.timezone), dayOffset);
    const [y, m, d] = date.split('-').map(Number) as [number, number, number];
    const at = (mins: number) =>
      zonedTimeToUtc(
        y,
        m,
        d + Math.floor(mins / 1440),
        Math.floor((mins % 1440) / 60),
        mins % 60,
        ctx.timezone,
      );
    startAt = at(times.start);
    endAt = at(times.end);
  }

  const nameMatch = raw.match(
    /^([A-Z][a-z]+)\s+(?:called (?:in )?(?:sick|out)|is (?:sick|out)|no[- ]show)/,
  );

  const missing: GapParse['missing'] = [];
  if (!role) missing.push('role');
  if (!startAt || !endAt) missing.push('time');
  if (baseRateCents === null) missing.push('baseRate');

  return {
    role,
    startAt,
    endAt,
    baseRateCents,
    maxPremiumPct,
    calledOutName: nameMatch?.[1] ?? null,
    missing,
  };
}
