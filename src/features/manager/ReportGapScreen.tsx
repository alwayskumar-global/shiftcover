'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { maxAuthorization } from '@/domain/money';
import { ROLE_LABELS, isShiftRole, type ShiftRole } from '@/domain/roles';
import { localDateString, zonedTimeToUtc } from '@/lib/time';
import { createGap, parseGap, startOffering, stubAuthorize } from '@/features/client-api';
import { Alert, Badge, Button } from '@/ui/primitives';
import { Icon } from '@/ui/icon';
import { formatUsd } from '@/ui/format';
import { useMe } from './me-context';

/** M3 report a gap (design/g1: M3-report-gap). Describe -> check details -> approve the hold. */

// The design's role list, in the design's order. A parsed role outside it is appended.
const DESIGN_ROLES: ShiftRole[] = [
  'line_cook',
  'prep_cook',
  'server',
  'bartender',
  'bar_back',
  'host',
  'dishwasher',
];

type Phase =
  | 'edit'
  | 'parsing'
  | 'parseFailed'
  | 'confirmed'
  | 'paypalWaiting'
  | 'paypalCancelled'
  | 'paypalFailed'
  | 'approved';

type Form = {
  role: ShiftRole | '';
  date: string;
  start: string;
  end: string;
  rate: string;
  prem: string;
};

type AiTags = Partial<Record<'role' | 'date' | 'start' | 'end' | 'rate', 'note' | 'default'>>;

const mins = (t: string) =>
  /^\d{2}:\d{2}$/.test(t) ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3)) : null;
const t12 = (t: string) => {
  const m = mins(t);
  if (m === null) return '–';
  const h = Math.floor(m / 60);
  return `${((h + 11) % 12) + 1}:${String(m % 60).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
};
const hm = (x: number | null) =>
  x === null ? '–' : `${Number.isInteger(x) ? x : x.toFixed(1)} ${x === 1 ? 'hour' : 'hours'}`;
const RATE_RE = /^\d+(\.\d{1,2})?$/;

export function ReportGapScreen() {
  const me = useMe();
  const tz = me.venue.timezone;
  const { config } = me;
  const today = localDateString(new Date(), tz);
  const lastDay = (() => {
    const [y, m, d] = today.split('-').map(Number) as [number, number, number];
    return new Date(Date.UTC(y, m - 1, d + config.max_days_ahead)).toISOString().slice(0, 10);
  })();
  const stubUi = config.payments_mode === 'stub' && process.env.NODE_ENV !== 'production';

  const [nl, setNl] = useState('');
  const [form, setForm] = useState<Form>({
    role: '',
    date: today,
    start: '',
    end: '',
    rate: '',
    prem: '20',
  });
  const [ai, setAi] = useState<AiTags>({});
  const [phase, setPhase] = useState<Phase>('edit');
  const [showErrors, setShowErrors] = useState(false);
  const [slotLoading, setSlotLoading] = useState(false);
  const [gapId, setGapId] = useState<string | null>(null);
  const meta = useRef<{ replaces: string | null; reason: string | null }>({
    replaces: null,
    reason: null,
  });
  const lock = useRef(false);
  const created = useRef<string | null>(null);
  const [extraRole, setExtraRole] = useState<ShiftRole | null>(null);

  const reading = phase === 'parsing';
  const confirmed = [
    'confirmed',
    'paypalWaiting',
    'paypalCancelled',
    'paypalFailed',
    'approved',
  ].includes(phase);
  const approved = phase === 'approved';

  // ---- validation (the design's messages)
  const a = mins(form.start);
  const b = mins(form.end);
  const errs: Record<string, string> = {};
  if (!form.role) errs.role = 'Choose a role.';
  if (!form.date) errs.date = 'Choose a date.';
  else if (form.date < today) errs.date = 'Pick today or a later date.';
  if (!form.start) errs.start = 'Enter a start time.';
  if (!form.end) errs.end = 'Enter an end time.';
  else if (a !== null && b !== null && b <= a) errs.end = 'End must be after start.';
  if (!RATE_RE.test(form.rate) || !(parseFloat(form.rate) > 0)) errs.rate = 'rate';
  if (
    !/^\d+$/.test(form.prem) ||
    Number(form.prem) > config.premium_max_pct ||
    Number(form.prem) < config.premium_min_pct
  )
    errs.prem = 'prem';
  const hasErrs = Object.keys(errs).length > 0;
  const hours = a !== null && b !== null && b > a ? (b - a) / 60 : null;

  // ---- money: integer cents, same functions as the server uses for the hold
  const m = (() => {
    if (hasErrs || a === null || b === null) return null;
    const minutes = b - a;
    const rate = Math.round(parseFloat(form.rate) * 100);
    const prem = Number(form.prem);
    const hold = maxAuthorization({
      baseRateCents: rate,
      maxPremiumPct: prem,
      minutes,
      feeBps: Math.round(config.platform_fee_pct * 100),
    });
    return {
      hours: minutes / 60,
      rate,
      prem,
      base: Math.floor((2 * rate * minutes + 60) / 120),
      capRate: hold.maxRateCents,
      w2: Math.round((rate * (200 + prem)) / 200),
      cap: hold.maxWorkerPayCents,
      fee: hold.maxFeeCents,
      hold: hold.authorizedCents,
    };
  })();
  const holdText = m ? formatUsd(m.hold) : '$–';

  function edit<K extends keyof Form>(key: K, value: Form[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    setAi((t) => {
      const next = { ...t };
      delete next[key as keyof AiTags];
      return next;
    });
    created.current = null; // a changed form needs its own gap
    if (phase !== 'edit' && phase !== 'parseFailed' && phase !== 'parsing') setPhase('edit');
  }

  async function onParse() {
    if (!nl.trim() || reading || approved) return;
    setPhase('parsing');
    setAi({});
    setShowErrors(false);
    created.current = null;
    try {
      const r = await parseGap(nl);
      const role = r.role;
      if (role && !DESIGN_ROLES.includes(role)) setExtraRole(role);
      setForm({
        role: role ?? '',
        date: r.date ?? today,
        start: r.start ?? '',
        end: r.end ?? '',
        rate: r.base_rate_cents !== null ? (r.base_rate_cents / 100).toFixed(2) : '',
        prem: String(r.max_premium_pct),
      });
      meta.current = { replaces: r.replaces_slot_id, reason: r.gap_reason };
      setAi({
        ...(role ? { role: 'note' } : {}),
        ...(r.date ? { date: 'note' } : {}),
        ...(r.start ? { start: 'note' } : {}),
        ...(r.end ? { end: 'note' } : {}),
        ...(r.base_rate_cents !== null
          ? { rate: r.base_rate_source === 'text' ? 'note' : 'default' }
          : {}),
      });
      setPhase('edit');
    } catch {
      setPhase('parseFailed');
    }
  }

  function onConfirm() {
    if (!m) {
      setShowErrors(true);
      return;
    }
    setPhase('confirmed');
    setSlotLoading(true);
    window.setTimeout(() => setSlotLoading(false), 400);
  }

  /** Stub-only: creates the gap, authorizes the hold without PayPal, then starts offering. */
  async function onStubApprove() {
    if (lock.current || slotLoading || !m || !form.role) return;
    lock.current = true;
    setPhase('paypalWaiting');
    try {
      const [y, mo, d] = form.date.split('-').map(Number) as [number, number, number];
      const toIso = (t: string) =>
        zonedTimeToUtc(y, mo, d, Number(t.slice(0, 2)), Number(t.slice(3)), tz).toISOString();
      let id = created.current;
      if (!id) {
        const res = await createGap({
          venue_id: me.venue.id,
          role: form.role,
          start_at: toIso(form.start),
          end_at: toIso(form.end),
          base_rate_cents: m.rate,
          max_premium_pct: m.prem,
          ...(meta.current.replaces ? { replaces_slot_id: meta.current.replaces } : {}),
          ...(meta.current.reason ? { gap_reason: meta.current.reason } : {}),
        });
        id = res.slot.id;
        created.current = id;
      }
      await stubAuthorize(id);
      await startOffering(id);
      setGapId(id);
      setPhase('approved');
    } catch {
      setPhase('paypalFailed');
    } finally {
      lock.current = false;
    }
  }

  // ---- derived view bits
  const stepNow =
    phase === 'edit' && !nl.trim() && !form.role && !form.start
      ? 1
      : phase === 'parsing'
        ? 1
        : approved
          ? 4
          : confirmed
            ? 3
            : 2;
  const steps = ['Describe', 'Check details', 'Approve hold'];

  let badge = { tone: 'neutral', icon: 'i-clock', label: 'Waiting for details' };
  if (m && phase === 'edit')
    badge = { tone: 'warning', icon: 'i-info', label: 'Needs your confirmation' };
  if (m && confirmed && !approved) {
    badge =
      phase === 'paypalFailed'
        ? { tone: 'error', icon: 'i-warn', label: 'Hold not placed' }
        : { tone: 'info', icon: 'i-lock', label: 'Confirmed · hold needed' };
  }
  if (approved) badge = { tone: 'success', icon: 'i-shield', label: 'On hold' };
  if (!m && showErrors)
    badge = { tone: 'warning', icon: 'i-warn', label: 'Fix highlighted fields' };

  const dateText = form.date
    ? new Date(`${form.date}T12:00:00`).toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      }) + (form.date === today ? ' (today)' : '')
    : '';
  const kv: Array<[string, string]> = [
    ['Role', form.role ? ROLE_LABELS[form.role] : ''],
    ['Date', dateText],
    ['Time', hours ? `${t12(form.start)} – ${t12(form.end)} · ${hm(hours)}` : ''],
    ['Venue', me.venue.name],
    [
      'Base rate',
      RATE_RE.test(form.rate) && form.rate ? `$${parseFloat(form.rate).toFixed(2)} / hour` : '',
    ],
    [
      'Max premium',
      /^\d+$/.test(form.prem) && Number(form.prem) <= config.premium_max_pct
        ? `${form.prem}% above base`
        : '',
    ],
  ];
  const usd = formatUsd;
  const dash = '$–';
  const feePct = config.platform_fee_pct;
  const money = [
    {
      cls: 'sc-money__row--muted',
      label: 'Base pay',
      sub: m ? `${hm(m.hours)} × ${usd(m.rate)}/hr · if no premium is needed` : 'Hours × base rate',
      amt: m ? usd(m.base) : dash,
    },
    {
      cls: '',
      label: 'Worker pay at the cap',
      sub: m ? `${hm(m.hours)} × ${usd(m.capRate)}/hr (+${m.prem}%)` : 'Most the worker can earn',
      amt: m ? usd(m.cap) : dash,
    },
    {
      cls: '',
      label: `Platform fee (${feePct}%)`,
      sub: `${feePct}% of worker pay at the cap`,
      amt: m ? usd(m.fee) : dash,
    },
    {
      cls: 'sc-money__row--total',
      label: 'Total hold',
      sub: 'The most this shift can cost. You are charged for hours worked only.',
      amt: m ? usd(m.hold) : dash,
    },
  ];
  const ladder = [
    { n: 1, label: 'Wave 1 · base', rate: m ? `${usd(m.rate)}/hr` : '–' },
    {
      n: 2,
      label: m ? `Wave 2 · +${+(m.prem / 2).toFixed(1)}%` : 'Wave 2',
      rate: m ? `${usd(m.w2)}/hr` : '–',
    },
    {
      n: 3,
      label: m ? `Wave 3 · cap +${m.prem}%` : 'Wave 3 · cap',
      rate: m ? `${usd(m.capRate)}/hr` : '–',
    },
  ];

  const roleOptions = extraRole ? [...DESIGN_ROLES, extraRole] : DESIGN_ROLES;
  const slotReady = phase === 'confirmed' || phase === 'paypalCancelled';
  const formLocked = approved || reading;
  const show = showErrors;
  const aiTag = (k: keyof AiTags) =>
    ai[k] ? (
      <span className="sc-tag-ai">
        <Icon name="i-sparkles" size="sm" />
        {ai[k] === 'default' ? 'Role default' : 'From your note'}
      </span>
    ) : null;
  const fieldError = (on: boolean, text: string) =>
    on ? (
      <span className="sc-field__error" role="alert">
        <Icon name="i-alert" size="sm" />
        {text}
      </span>
    ) : null;
  const detailsHint =
    phase === 'parseFailed'
      ? 'Fill these in by hand.'
      : Object.keys(ai).length
        ? 'Filled from your note. Change anything that’s off.'
        : !nl.trim() && !form.role
          ? 'Or skip the note and fill these in.'
          : '';
  const premHelp = !errs.prem && !!m;

  return (
    <div className="sc-page">
      <nav className="sc-crumbs" aria-label="Breadcrumb">
        <Link href="/app/roster">
          <Icon name="i-chev-left" size="sm" />
          Roster
        </Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">Report a gap</span>
      </nav>
      <header className="sc-page__head">
        <div>
          <h1 className="sc-page__title">Report a gap</h1>
          <p className="sc-page__sub">
            Tell us what happened. We fill in the details; you check them and approve the money.
          </p>
        </div>
        <ol className="sc-stepper" aria-label="Progress">
          {steps.map((label, i) => (
            <li
              key={label}
              className={`sc-stepper__item ${stepNow > i + 1 ? 'sc-stepper__item--done' : stepNow === i + 1 ? 'sc-stepper__item--now' : ''}`}
              aria-current={stepNow === i + 1 ? 'step' : undefined}
            >
              <span className="sc-stepper__node">{i + 1}</span>
              {label}
            </li>
          ))}
        </ol>
      </header>

      <div className="sc-gap">
        <div className="sc-gap__col">
          <section className="sc-card" aria-labelledby="nl-title">
            <div className="sc-card__head">
              <h2 className="sc-card__title" id="nl-title">
                Tell us what happened
              </h2>
            </div>
            <div className="sc-nl">
              <label className="sc-visually-hidden" htmlFor="nl">
                Describe the gap in your own words
              </label>
              <textarea
                className="sc-nl__input"
                id="nl"
                placeholder="e.g. Maria called in sick, need a line cook 7 to 3 today"
                readOnly={approved || reading}
                value={nl}
                maxLength={1000}
                onChange={(e) => setNl(e.target.value)}
              />
              {reading && (
                <div className="sc-nl__status" role="status">
                  <Icon name="i-sparkles" />
                  AI is reading this
                  <span className="sc-nl__bar" />
                </div>
              )}
              {phase === 'parseFailed' && (
                <Alert tone="warning" icon="i-info" title="We couldn't read that note" role="alert">
                  Nothing was filled in. Fill in the details below instead, or name the role, the
                  day and the times and try Parse again.
                </Alert>
              )}
              <div className="sc-nl__foot">
                <span className="sc-nl__hint">
                  We read it, you check it. Nothing goes to workers until you approve the hold.
                </span>
                <Button
                  variant="primary"
                  size="md"
                  busy={reading}
                  inert={!nl.trim() || approved}
                  onClick={onParse}
                >
                  <Icon name="i-sparkles" size="sm" />
                  {reading ? 'Reading…' : 'Parse'}
                </Button>
              </div>
            </div>
          </section>

          <section className="sc-card" aria-labelledby="det-title">
            <div className="sc-card__head">
              <h2 className="sc-card__title" id="det-title">
                Shift details
              </h2>
              <span className="sc-card__lead">{detailsHint}</span>
            </div>
            <form className="sc-form" onSubmit={(e) => e.preventDefault()} noValidate>
              <div className="sc-field">
                <div className="sc-field__label-row">
                  <label className="sc-field__label" htmlFor="f-role">
                    Role
                  </label>
                  {aiTag('role')}
                </div>
                <select
                  className={`sc-input sc-input--md sc-select ${reading ? 'is-reading' : ''}`}
                  id="f-role"
                  value={form.role}
                  onChange={(e) =>
                    edit(
                      'role',
                      (isShiftRole(e.target.value) ? e.target.value : '') as Form['role'],
                    )
                  }
                  disabled={formLocked}
                  aria-invalid={show && !!errs.role}
                >
                  <option value="">Choose a role</option>
                  {roleOptions.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </option>
                  ))}
                </select>
                {fieldError(show && !!errs.role, 'Choose a role.')}
              </div>
              <div className="sc-field">
                <div className="sc-field__label-row">
                  <label className="sc-field__label" htmlFor="f-venue">
                    Venue
                  </label>
                </div>
                <select className="sc-input sc-input--md sc-select" id="f-venue" disabled>
                  <option>
                    {me.venue.name} · {me.venue.area}
                  </option>
                </select>
              </div>
              <div className="sc-field">
                <div className="sc-field__label-row">
                  <label className="sc-field__label" htmlFor="f-date">
                    Date
                  </label>
                  {aiTag('date')}
                </div>
                <input
                  className={`sc-input sc-input--md ${reading ? 'is-reading' : ''}`}
                  id="f-date"
                  type="date"
                  min={today}
                  max={lastDay}
                  value={form.date}
                  onChange={(e) => edit('date', e.target.value)}
                  disabled={formLocked}
                  aria-invalid={show && !!errs.date}
                />
                {fieldError(show && !!errs.date, errs.date ?? '')}
              </div>
              <div className="sc-field">
                <div className="sc-field__label-row">
                  <span className="sc-field__label">Length</span>
                </div>
                <div className="sc-readout">{hm(hours)}</div>
              </div>
              <div className="sc-field">
                <div className="sc-field__label-row">
                  <label className="sc-field__label" htmlFor="f-start">
                    Start
                  </label>
                  {aiTag('start')}
                </div>
                <input
                  className={`sc-input sc-input--md ${reading ? 'is-reading' : ''}`}
                  id="f-start"
                  type="time"
                  step={900}
                  value={form.start}
                  onChange={(e) => edit('start', e.target.value)}
                  disabled={formLocked}
                  aria-invalid={show && !!errs.start}
                />
                {fieldError(show && !!errs.start, 'Enter a start time.')}
              </div>
              <div className="sc-field">
                <div className="sc-field__label-row">
                  <label className="sc-field__label" htmlFor="f-end">
                    End
                  </label>
                  {aiTag('end')}
                </div>
                <input
                  className={`sc-input sc-input--md ${reading ? 'is-reading' : ''}`}
                  id="f-end"
                  type="time"
                  step={900}
                  value={form.end}
                  onChange={(e) => edit('end', e.target.value)}
                  disabled={formLocked}
                  aria-invalid={show && !!errs.end}
                />
                {fieldError(show && !!errs.end, errs.end ?? '')}
              </div>
              <div className="sc-field">
                <div className="sc-field__label-row">
                  <label className="sc-field__label" htmlFor="f-rate">
                    Base rate
                  </label>
                  {aiTag('rate')}
                </div>
                <div
                  className={`sc-affix ${show && errs.rate ? 'is-invalid' : ''} ${reading ? 'is-reading' : ''}`}
                >
                  <span className="sc-affix__text sc-affix__text--pre">$</span>
                  <input
                    className="sc-affix__input"
                    id="f-rate"
                    inputMode="decimal"
                    placeholder="22.00"
                    value={form.rate}
                    onChange={(e) => edit('rate', e.target.value)}
                    disabled={formLocked}
                    aria-invalid={show && !!errs.rate}
                  />
                  <span className="sc-affix__text">/ hour</span>
                </div>
                {fieldError(show && !!errs.rate, 'Enter an hourly rate, like 22.00.')}
              </div>
              <div className="sc-field">
                <div className="sc-field__label-row">
                  <label className="sc-field__label" htmlFor="f-prem">
                    Maximum premium
                  </label>
                </div>
                <div
                  className={`sc-affix ${show && errs.prem ? 'is-invalid' : ''} ${reading ? 'is-reading' : ''}`}
                >
                  <input
                    className="sc-affix__input"
                    id="f-prem"
                    inputMode="numeric"
                    placeholder="20"
                    value={form.prem}
                    onChange={(e) => edit('prem', e.target.value)}
                    disabled={formLocked}
                    aria-invalid={show && !!errs.prem}
                  />
                  <span className="sc-affix__text">% above base</span>
                </div>
                {fieldError(
                  show && !!errs.prem,
                  `Enter a number from ${config.premium_min_pct} to ${config.premium_max_pct}.`,
                )}
                {premHelp && m && (
                  <span className="sc-field__help">
                    Highest rate we&apos;ll offer: {usd(m.capRate)}/hr. The rate only rises if
                    nobody claims.
                  </span>
                )}
              </div>
            </form>
          </section>
        </div>

        <aside className="sc-gap__aside">
          <section className="sc-card" aria-labelledby="rev-title" aria-live="polite">
            <div className="sc-card__head">
              <h2 className="sc-card__title" id="rev-title">
                Review
              </h2>
              <Badge tone={badge.tone} icon={badge.icon} small>
                {badge.label}
              </Badge>
            </div>
            {!m && (
              <p className="sc-card__lead">
                {show && hasErrs
                  ? 'Fix the highlighted fields to see what this will cost.'
                  : 'Fill in the details and we’ll show what it will cost.'}
              </p>
            )}
            <dl className="sc-kv">
              {kv.map(([k, v]) => (
                <div key={k} style={{ display: 'contents' }}>
                  <dt>{k}</dt>
                  <dd className={v ? '' : 'is-empty'}>{v || '–'}</dd>
                </div>
              ))}
            </dl>
            <div className="sc-money" role="table" aria-label="Cost">
              {money.map((row) => (
                <div className={`sc-money__row ${row.cls}`} role="row" key={row.label}>
                  <span className="sc-money__label" role="cell">
                    <strong>{row.label}</strong>
                    <small>{row.sub}</small>
                  </span>
                  <span className="sc-money__amt" role="cell">
                    {row.amt}
                  </span>
                </div>
              ))}
            </div>
            <div className="sc-ladder" aria-label="Offer rate by wave">
              {ladder.map((w) => (
                <div className={`sc-ladder__step sc-ladder__step--${w.n}`} key={w.n}>
                  <span>{w.label}</span>
                  <strong>{w.rate}</strong>
                </div>
              ))}
            </div>

            {!confirmed && (
              <Button variant="primary" size="md" block inert={!m || reading} onClick={onConfirm}>
                <Icon name="i-check" size="sm" />
                Details are correct
              </Button>
            )}
            {confirmed && (
              <div className="sc-confirmed">
                <span>Details confirmed</span>
                <Button
                  variant="quiet"
                  size="md"
                  inert={approved}
                  onClick={() => {
                    if (!approved) setPhase('edit');
                  }}
                >
                  Edit details
                </Button>
              </div>
            )}

            <hr className="sc-divider" />

            {!approved && (
              <div className="sc-paypal">
                <p className="sc-paypal__label">
                  {m
                    ? `Approve a hold of up to ${holdText}. You are only charged for the hours worked.`
                    : 'Approve a hold before we start offering the shift. You are only charged for the hours worked.'}
                </p>
                {phase === 'paypalWaiting' && (
                  <Alert tone="info" icon="i-info" title="Finish in the PayPal window" role="alert">
                    Don’t close this page. We’ll update it when PayPal replies.
                  </Alert>
                )}
                {phase === 'paypalCancelled' && (
                  <Alert tone="warning" icon="i-info" title="You closed PayPal" role="alert">
                    No hold was placed. Approve it when you’re ready and we’ll start offering the
                    shift.
                  </Alert>
                )}
                {phase === 'paypalFailed' && (
                  <Alert
                    tone="error"
                    icon="i-warn"
                    title="PayPal couldn’t place the hold"
                    role="alert"
                  >
                    Nothing was charged. Check your PayPal funding source, then try again.
                  </Alert>
                )}
                {/* PayPal slot. M2 mounts the PayPal SDK v6 button into #paypal-button-container (52px, full width).
                    The stub button below exists only in stub mode and never in a production build. */}
                {phase !== 'paypalFailed' && (
                  <div id="paypal-button-container">
                    {stubUi && (slotReady || phase === 'paypalWaiting') ? (
                      <button
                        className={`sc-paypal__slot ${slotLoading ? 'sc-paypal__slot--loading' : ''} ${phase === 'paypalWaiting' ? 'sc-paypal__slot--waiting' : ''}`}
                        type="button"
                        data-testid="stub-approve"
                        aria-disabled={slotLoading || phase === 'paypalWaiting'}
                        aria-busy={slotLoading || phase === 'paypalWaiting'}
                        onClick={onStubApprove}
                      >
                        <Icon
                          name="i-loader"
                          size="sm"
                          className={`sc-spinner ${phase === 'paypalWaiting' ? '' : 'sc-visually-hidden'}`}
                        />
                        {phase === 'paypalWaiting'
                          ? 'Waiting for PayPal…'
                          : slotLoading
                            ? 'Loading secure payment…'
                            : 'Test mode: approve hold without PayPal'}
                      </button>
                    ) : (
                      <button
                        className={`sc-paypal__slot ${confirmed ? 'sc-paypal__slot--loading' : 'sc-paypal__slot--disabled'}`}
                        type="button"
                        aria-disabled="true"
                        aria-busy={confirmed}
                      >
                        <Icon name="i-loader" size="sm" className="sc-spinner sc-visually-hidden" />
                        {confirmed
                          ? 'Loading secure payment…'
                          : 'Available after you confirm the details'}
                      </button>
                    )}
                  </div>
                )}
                {phase === 'paypalFailed' && (
                  <Button variant="secondary" size="md" onClick={() => setPhase('confirmed')}>
                    <Icon name="i-retry" size="sm" />
                    Try again
                  </Button>
                )}
                <p className="sc-paypal__fine">
                  PayPal sets this money aside now. Anything not used is released.
                </p>
              </div>
            )}

            {approved && (
              <>
                <Alert tone="success" icon="i-shield" title={`${holdText} on hold`} role="status">
                  Nothing has been charged yet. We&apos;re offering the shift to qualified workers
                  now.
                </Alert>
                <div className="sc-rail" aria-label="Money timeline">
                  <div className="sc-rail__item sc-rail__item--now">
                    <div className="sc-rail__top">
                      <span className="sc-rail__node">
                        <Icon name="i-shield" size="sm" />
                      </span>
                      <span className="sc-rail__line" />
                    </div>
                    <span className="sc-rail__label">Authorized</span>
                    <span className="sc-rail__amt">{holdText}</span>
                    <span className="sc-rail__note">Now</span>
                  </div>
                  <div className="sc-rail__item">
                    <div className="sc-rail__top">
                      <span className="sc-rail__node">
                        <Icon name="i-banknote" size="sm" />
                      </span>
                      <span className="sc-rail__line" />
                    </div>
                    <span className="sc-rail__label">Captured</span>
                    <span className="sc-rail__amt">$–</span>
                    <span className="sc-rail__note">After you approve hours</span>
                  </div>
                  <div className="sc-rail__item">
                    <div className="sc-rail__top">
                      <span className="sc-rail__node">
                        <Icon name="i-wallet" size="sm" />
                      </span>
                    </div>
                    <span className="sc-rail__label">Paid</span>
                    <span className="sc-rail__amt">$–</span>
                    <span className="sc-rail__note">To the worker</span>
                  </div>
                </div>
                <div className="sc-actions">
                  <Link className="sc-btn sc-btn--primary sc-btn--md" href={`/app/gaps/${gapId}`}>
                    View gap
                    <Icon name="i-arrow-right" size="sm" />
                  </Link>
                  <Link className="sc-btn sc-btn--secondary sc-btn--md" href="/app/roster">
                    Back to roster
                  </Link>
                </div>
              </>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
