'use client';

import { useCallback, useEffect, useState } from 'react';
import { ROLE_LABELS } from '@/domain/roles';
import { payForMinutesCents, platformFee } from '@/domain/money';
import {
  ApiFailure,
  approveAndPay,
  fetchApprovals,
  type ApprovalsDto,
  type ApproveAndPayDto,
} from '@/features/client-api';
import { Alert, Badge, Button, Skeleton } from '@/ui/primitives';
import { Dialog } from '@/ui/dialog';
import { Icon } from '@/ui/icon';
import { dayLabel, formatClock, formatTimeRange, formatUsd } from '@/ui/format';

/**
 * G2-M5 Approvals (design/g2). Hours waiting for the manager; "Approve and pay" asks for a confirmation, then calls
 * POST /api/manager/shifts/[id]/approve-and-pay. The preview multiplies the figures the API returned (rate, hold,
 * fee config); the server recomputes everything and is the only thing that moves money.
 */

type Item = ApprovalsDto['items'][number];
type Card = 'pending' | 'approving' | 'approved' | 'declined' | 'failed';
type Phase = 'loading' | 'ready' | 'error';

const fmt = (n: number) => String(+n.toFixed(2));
const dur = (min: number) => {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`;
};

export function ApprovalsScreen() {
  const [data, setData] = useState<ApprovalsDto | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [hours, setHours] = useState<Record<string, string>>({});
  const [showErr, setShowErr] = useState<Record<string, boolean>>({});
  const [card, setCard] = useState<Record<string, Card>>({});
  const [result, setResult] = useState<Record<string, ApproveAndPayDto>>({});
  const [failure, setFailure] = useState<Record<string, string>>({});
  const [dlg, setDlg] = useState<string | null>(null);
  const [toast, setToast] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await fetchApprovals());
      setPhase('ready');
    } catch {
      setPhase('error');
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(''), 3000);
    return () => clearTimeout(id);
  }, [toast]);

  const items = data?.items ?? [];
  const stateOf = (i: Item): Card =>
    card[i.slot_id] ?? (i.payment_status === 'capture_declined' ? 'declined' : 'pending');
  const hoursOf = (i: Item) => {
    const typed = hours[i.slot_id];
    if (typed !== undefined) return typed;
    if (i.approved_hours !== null) return fmt(i.approved_hours); // a retry must use the hours already approved
    const base = i.actual_hours === null ? i.scheduled_hours : Math.round(i.actual_hours * 4) / 4;
    return fmt(Math.min(i.scheduled_hours, base, i.max_hours));
  };
  const valid = (i: Item) => {
    const t = hoursOf(i).trim();
    const n = parseFloat(t);
    return { ok: /^\d+(\.\d{1,2})?$/.test(t) && n > 0 && n <= i.max_hours, n };
  };
  const calc = (i: Item, h: number) => {
    const pay = payForMinutesCents(i.rate_cents, Math.round(h * 60));
    const fee = platformFee(pay, { feeBps: data!.fee_bps, fixedFeeCents: data!.fixed_fee_cents });
    return { pay, fee, total: pay + fee, released: i.authorized_cents - (pay + fee) };
  };
  const feeLabel = (() => {
    if (!data) return '';
    const pct = `${+(data.fee_bps / 100).toFixed(2)}%`;
    return data.fixed_fee_cents > 0 ? `${pct} + ${formatUsd(data.fixed_fee_cents)}` : pct;
  })();

  async function run(i: Item) {
    const id = i.slot_id;
    setDlg(null);
    setCard((c) => ({ ...c, [id]: 'approving' }));
    try {
      const r = await approveAndPay(id, valid(i).n);
      setResult((x) => ({ ...x, [id]: r }));
      const st = r.payment.status;
      if (st === 'capture_declined') {
        setCard((c) => ({ ...c, [id]: 'declined' }));
        setToast('PayPal declined the charge.');
      } else if (st === 'paid' || st === 'payout_pending' || st === 'captured') {
        setCard((c) => ({ ...c, [id]: 'approved' }));
        setToast('Approved. Payout started.');
      } else {
        setFailure((f) => ({
          ...f,
          [id]:
            r.payment.last_error ??
            'PayPal has not finished this charge yet. Check back in a moment.',
        }));
        setCard((c) => ({ ...c, [id]: 'failed' }));
      }
    } catch (e) {
      setFailure((f) => ({
        ...f,
        [id]:
          e instanceof ApiFailure && e.status === 422
            ? 'Those hours are above what the hold covers.'
            : 'We couldn’t finish this approval. Nothing more was charged. Try again.',
      }));
      setCard((c) => ({ ...c, [id]: 'failed' }));
    }
  }

  const waiting = items.filter((i) => ['pending', 'approving', 'declined'].includes(stateOf(i)));
  const sumTotal = data
    ? waiting.reduce(
        (a, i) =>
          a + calc(i, valid(i).ok ? valid(i).n : Math.min(i.scheduled_hours, i.max_hours)).total,
        0,
      )
    : 0;
  const sumHold = waiting.reduce((a, i) => a + i.authorized_cents, 0);
  const ready = phase === 'ready';
  const open = items.find((i) => i.slot_id === dlg);
  const openCalc = open && data ? calc(open, valid(open).n) : null;

  return (
    <div className="sc-page">
      {dlg && open && openCalc && (
        <Dialog titleId="dlg-t" role="alertdialog" onClose={() => setDlg(null)}>
          <h2 className="sc-dialog__title" id="dlg-t">
            Approve {fmt(valid(open).n)} h for {open.worker.name}?
          </h2>
          <p className="sc-dialog__text">
            You&apos;ll be charged now. This can&apos;t be undone once PayPal captures the payment.
          </p>
          <div className="sc-money">
            <MoneyRow
              label="Charged to you"
              sub={`Worker pay + ${feeLabel} fee`}
              amt={formatUsd(openCalc.total)}
            />
            <MoneyRow
              muted
              label={`Paid to ${open.worker.name.split(' ')[0]}`}
              sub={`${fmt(valid(open).n)} h × ${formatUsd(open.rate_cents)}/hr`}
              amt={formatUsd(openCalc.pay)}
            />
            <MoneyRow
              muted
              label="Released from hold"
              sub={`Hold ${formatUsd(open.authorized_cents)}`}
              amt={formatUsd(openCalc.released)}
            />
          </div>
          <div className="sc-dialog__actions">
            <Button variant="secondary" size="md" data-autofocus onClick={() => setDlg(null)}>
              Not yet
            </Button>
            <Button variant="primary" size="md" onClick={() => void run(open)}>
              Approve and pay
            </Button>
          </div>
        </Dialog>
      )}

      {toast && (
        <div className="sc-toast" role="status">
          <Icon name="i-check" />
          {toast}
        </div>
      )}
      <header className="sc-page__head">
        <div>
          <h1 className="sc-page__title">Approvals</h1>
          <p className="sc-page__sub">Hours waiting for you. Money moves only when you approve.</p>
        </div>
      </header>

      <section className="sc-stats" aria-label="Summary">
        <Stat
          cls={`sc-stat--pending${ready && waiting.length ? ' is-alert' : ''}`}
          icon="i-hourglass"
          value={ready ? String(waiting.length) : '–'}
          label=" waiting for approval"
        />
        <Stat
          cls=""
          icon="i-banknote"
          value={ready && waiting.length ? formatUsd(sumTotal) : '$–'}
          label=" will be charged if all are approved"
        />
        <Stat
          cls=""
          icon="i-shield"
          value={ready && waiting.length ? formatUsd(sumHold) : '$–'}
          label=" held on your PayPal"
        />
      </section>

      {phase === 'loading' && (
        <div className="sc-approvals" aria-busy="true">
          <span className="sc-visually-hidden" role="status">
            Loading approvals
          </span>
          {[1, 2].map((k) => (
            <div className="sc-approval" aria-hidden="true" key={k}>
              <div className="sc-approval__main">
                <Skeleton variant="title" />
                <Skeleton variant="block" />
                <Skeleton variant="line" />
              </div>
              <div className="sc-approval__side">
                <Skeleton variant="block" />
                <Skeleton variant="button" />
              </div>
            </div>
          ))}
        </div>
      )}

      {phase === 'error' && (
        <div className="sc-panel" role="alert">
          <span className="sc-panel__icon">
            <Icon name="i-wifi-off" size="xl" />
          </span>
          <h2 className="sc-panel__title">We couldn&apos;t load approvals</h2>
          <p className="sc-panel__text">
            Check your connection and try again. Nothing was approved or charged.
          </p>
          <Button
            variant="secondary"
            size="md"
            onClick={() => {
              setPhase('loading');
              void load();
            }}
          >
            <Icon name="i-retry" size="sm" />
            Try again
          </Button>
        </div>
      )}

      {ready && items.length === 0 && (
        <div className="sc-panel">
          <span
            className="sc-panel__icon"
            style={{ background: 'var(--sc-st-confirmed-bg)', color: 'var(--sc-st-confirmed-fg)' }}
          >
            <Icon name="i-checks" size="xl" />
          </span>
          <h2 className="sc-panel__title">All caught up</h2>
          <p className="sc-panel__text">
            No hours are waiting. When a worker finishes a shift, it appears here for you to
            approve.
          </p>
        </div>
      )}

      {ready && items.length > 0 && data && (
        <div className="sc-approvals">
          {items.map((i) => {
            const st = stateOf(i);
            const v = valid(i);
            const maxH = fmt(i.max_hours);
            const shown = v.ok
              ? v.n
              : parseFloat(hoursOf(i)) > 0
                ? Math.min(parseFloat(hoursOf(i)), i.max_hours)
                : 0;
            const c = calc(i, shown);
            const bad = !!showErr[i.slot_id] && !v.ok && st === 'pending';
            const tz = i.venue_tz;
            const workedMin =
              i.check_in_at && i.check_out_at
                ? Math.round((Date.parse(i.check_out_at) - Date.parse(i.check_in_at)) / 60_000)
                : null;
            const schedMin = Math.round(i.scheduled_hours * 60);
            const diff = workedMin === null ? 0 : workedMin - schedMin;
            const r = result[i.slot_id];
            const badge =
              st === 'approved'
                ? { tone: 'm-paid', icon: 'i-check', label: 'Approved' }
                : st === 'declined'
                  ? { tone: 'm-failed', icon: 'i-warn', label: 'Capture declined' }
                  : st === 'approving'
                    ? { tone: 'st-pending', icon: 'i-hourglass', label: 'Approving' }
                    : { tone: 'st-pending', icon: 'i-hourglass', label: 'Pending approval' };
            const first = i.worker.name.split(' ')[0]!;
            return (
              <article className="sc-approval" aria-labelledby={`${i.slot_id}-h`} key={i.slot_id}>
                <div className="sc-approval__main">
                  <div className="sc-approval__head">
                    <span
                      className={`sc-avatar sc-avatar--${i.worker.avatar_tint}`}
                      aria-hidden="true"
                    >
                      {i.worker.initials}
                    </span>
                    <div className="sc-approval__who">
                      <h2 className="sc-approval__name" id={`${i.slot_id}-h`}>
                        {i.worker.name}
                      </h2>
                      <p className="sc-approval__sub">
                        {ROLE_LABELS[i.role]} · {dayLabel(i.start_at, data.server_time, tz)}
                        {i.check_out_at ? ` · finished ${formatClock(i.check_out_at, tz)}` : ''}
                      </p>
                    </div>
                    <Badge tone={badge.tone} icon={badge.icon}>
                      {badge.label}
                    </Badge>
                  </div>
                  <div className="sc-compare">
                    <div className="sc-compare__item">
                      <span className="sc-compare__k">Scheduled</span>
                      <span className="sc-compare__v">
                        {formatTimeRange(i.start_at, i.end_at, tz)}
                      </span>
                      <span className="sc-compare__s">{fmt(i.scheduled_hours)} h scheduled</span>
                    </div>
                    <div className="sc-compare__item">
                      <span className="sc-compare__k">Worked (check-in to check-out)</span>
                      <span className="sc-compare__v">
                        {i.check_in_at && i.check_out_at
                          ? formatTimeRange(i.check_in_at, i.check_out_at, tz)
                          : '–'}
                      </span>
                      <span className="sc-compare__s">
                        {workedMin === null ? 'No times recorded' : dur(workedMin)}
                        {diff === 0
                          ? ''
                          : ` · ${diff > 0 ? '+' : '−'}${Math.abs(diff)} min vs scheduled`}
                      </span>
                    </div>
                  </div>
                  <div className="sc-field sc-hours">
                    <label className="sc-field__label" htmlFor={`${i.slot_id}-hrs`}>
                      Hours to approve
                    </label>
                    <div className={`sc-affix ${bad ? 'is-invalid' : ''}`}>
                      <input
                        className="sc-affix__input"
                        id={`${i.slot_id}-hrs`}
                        inputMode="decimal"
                        value={hoursOf(i)}
                        onChange={(e) => {
                          setHours((h) => ({ ...h, [i.slot_id]: e.target.value }));
                          setShowErr((s) => ({ ...s, [i.slot_id]: false }));
                        }}
                        disabled={st !== 'pending'}
                        aria-invalid={bad}
                        aria-describedby={`${i.slot_id}-hh`}
                      />
                      <span className="sc-affix__text">hours</span>
                    </div>
                    {bad ? (
                      <span className="sc-field__error" id={`${i.slot_id}-hh`} role="alert">
                        <Icon name="i-alert" size="sm" />
                        {parseFloat(hoursOf(i)) > i.max_hours
                          ? `The most you can approve is ${maxH} h. That is what the hold covers.`
                          : `Enter hours from 0.25 to ${maxH}, like 8 or 7.5.`}
                      </span>
                    ) : (
                      <span className="sc-field__help" id={`${i.slot_id}-hh`}>
                        The hold covers up to {maxH} h at this rate.
                      </span>
                    )}
                  </div>
                  {st === 'pending' && (
                    <div className="sc-actions">
                      <Button
                        variant="secondary"
                        size="md"
                        onClick={() =>
                          setHours((h) => ({
                            ...h,
                            [i.slot_id]: fmt(Math.min(i.scheduled_hours, i.max_hours)),
                          }))
                        }
                      >
                        Use scheduled ({fmt(i.scheduled_hours)} h)
                      </Button>
                      {workedMin !== null && (
                        <Button
                          variant="secondary"
                          size="md"
                          onClick={() =>
                            setHours((h) => ({
                              ...h,
                              [i.slot_id]: fmt(
                                Math.min(i.max_hours, Math.round((workedMin / 60) * 100) / 100),
                              ),
                            }))
                          }
                        >
                          Use worked (
                          {fmt(Math.min(i.max_hours, Math.round((workedMin / 60) * 100) / 100))} h)
                        </Button>
                      )}
                    </div>
                  )}
                </div>
                <div className="sc-approval__side">
                  <p className="sc-eyebrow">If you approve {fmt(shown)} h</p>
                  <div className="sc-money">
                    <MoneyRow
                      label="Worker pay"
                      sub={`${fmt(shown)} h × ${formatUsd(i.rate_cents)}/hr`}
                      amt={formatUsd(c.pay)}
                    />
                    <MoneyRow
                      muted
                      label={`Platform fee (${feeLabel})`}
                      sub={`${feeLabel} of worker pay`}
                      amt={formatUsd(c.fee)}
                    />
                    <MoneyRow
                      total
                      label="Capture will charge"
                      sub="Worker pay + fee"
                      amt={formatUsd(c.total)}
                    />
                    <MoneyRow
                      muted
                      label="Hold on file"
                      sub={`${formatUsd(Math.max(0, c.released))} is released after capture`}
                      amt={formatUsd(i.authorized_cents)}
                    />
                  </div>
                  {st === 'pending' && (
                    <Button
                      variant="primary"
                      size="md"
                      className="sc-btn--block-md"
                      onClick={() => {
                        if (!v.ok) setShowErr((s) => ({ ...s, [i.slot_id]: true }));
                        else setDlg(i.slot_id);
                      }}
                    >
                      <Icon name="i-check" size="sm" />
                      Approve and pay
                    </Button>
                  )}
                  {st === 'approving' && (
                    <Button variant="primary" size="md" className="sc-btn--block-md" busy>
                      Charging…
                    </Button>
                  )}
                  {st === 'approved' && r && (
                    <>
                      <Alert tone="success" icon="i-check" title="Approved" role="status">
                        {formatUsd(r.capture_cents)} charged. {formatUsd(r.worker_pay_cents)} is on
                        its way to {first}.
                      </Alert>
                      <div className="sc-rail" aria-label="Money timeline">
                        <RailNode
                          tone="authorized"
                          st="is-done"
                          icon="i-shield"
                          label="Authorized"
                          amt={formatUsd(i.authorized_cents)}
                          note="Held"
                        />
                        <RailNode
                          tone="captured"
                          st="is-done"
                          icon="i-banknote"
                          label="Captured"
                          amt={formatUsd(r.capture_cents)}
                          note="Charged"
                        />
                        <RailNode
                          tone="paid"
                          st={r.payment.status === 'paid' ? 'is-done' : 'is-now'}
                          icon="i-wallet"
                          label="Paid"
                          amt={formatUsd(r.worker_pay_cents)}
                          note={r.payment.status === 'paid' ? 'Paid' : 'Paying now'}
                          last
                        />
                      </div>
                    </>
                  )}
                  {st === 'declined' && (
                    <>
                      <Alert
                        tone="error"
                        icon="i-warn"
                        title={`PayPal declined the charge of ${formatUsd(c.total)}`}
                        role="alert"
                      >
                        {first} hasn&apos;t been paid yet. Check your PayPal account, then retry.
                        The hold is still in place.
                      </Alert>
                      <div className="sc-actions">
                        <Button variant="primary" size="md" onClick={() => void run(i)}>
                          <Icon name="i-retry" size="sm" />
                          Retry charge
                        </Button>
                        {(r?.payment.paypal_references.capture ?? i.capture_reference) && (
                          <Button
                            variant="secondary"
                            size="md"
                            onClick={() => {
                              void navigator.clipboard
                                ?.writeText(
                                  (r?.payment.paypal_references.capture ?? i.capture_reference)!,
                                )
                                .catch(() => {});
                              setToast('Reference copied');
                            }}
                          >
                            <Icon name="i-copy" size="sm" />
                            Copy reference
                          </Button>
                        )}
                      </div>
                    </>
                  )}
                  {st === 'failed' && (
                    <>
                      <Alert
                        tone="error"
                        icon="i-warn"
                        title="We couldn’t finish this approval"
                        role="alert"
                      >
                        {failure[i.slot_id]}
                      </Alert>
                      <div className="sc-actions">
                        <Button variant="primary" size="md" onClick={() => void run(i)}>
                          <Icon name="i-retry" size="sm" />
                          Try again
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Stat({
  cls,
  icon,
  value,
  label,
}: {
  cls: string;
  icon: string;
  value: string;
  label: string;
}) {
  return (
    <div className={`sc-stat ${cls}`}>
      <span className="sc-stat__icon">
        <Icon name={icon} />
      </span>
      <span>
        <span className="sc-stat__value">{value}</span>
        <span className="sc-stat__label">{label}</span>
      </span>
    </div>
  );
}

function MoneyRow({
  label,
  sub,
  amt,
  muted,
  total,
}: {
  label: string;
  sub: string;
  amt: string;
  muted?: boolean;
  total?: boolean;
}) {
  return (
    <div
      className={`sc-money__row ${muted ? 'sc-money__row--muted' : ''} ${total ? 'sc-money__row--total' : ''}`}
    >
      <span className="sc-money__label">
        <strong>{label}</strong>
        <small>{sub}</small>
      </span>
      <span className="sc-money__amt">{amt}</span>
    </div>
  );
}

function RailNode({
  tone,
  st,
  icon,
  label,
  amt,
  note,
  last,
}: {
  tone: string;
  st: string;
  icon: string;
  label: string;
  amt: string;
  note: string;
  last?: boolean;
}) {
  return (
    <div className={`sc-rail__item sc-rail__item--t-${tone} ${st}`}>
      <div className="sc-rail__top">
        <span className="sc-rail__node">
          <Icon name={icon} size="sm" />
        </span>
        <span className={`sc-rail__line ${last ? 'sc-visually-hidden' : ''}`} />
      </div>
      <span className="sc-rail__label">{label}</span>
      <span className="sc-rail__amt">{amt}</span>
      <span className="sc-rail__note">{note}</span>
    </div>
  );
}
