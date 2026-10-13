'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ROLE_LABELS } from '@/domain/roles';
import { ApiFailure, approveAndPay, fetchLedger, type LedgerDto } from '@/features/client-api';
import { formatTimeRange, formatUsd } from '@/ui/format';
import { Icon } from '@/ui/icon';
import { Alert, Badge, Button, Skeleton } from '@/ui/primitives';

/**
 * G2-M6 Ledger (design/g2): one row per payment attempt with the filters, totals and a per-shift breakdown panel.
 * Every figure is read from GET /api/manager/ledger; this screen adds nothing up. A payout that failed can be retried
 * from its breakdown (the same approve-and-pay call, with the hours already approved).
 */
type Item = LedgerDto['items'][number];
type Group = Item['group'];
type Phase = 'loading' | 'ready' | 'error';

const RANGES = [
  { v: '7d', label: '7 days' },
  { v: '30d', label: '30 days' },
  { v: 'all', label: 'All' },
] as const;
const GROUPS: Array<{ v: '' | Group; label: string }> = [
  { v: '', label: 'All statuses' },
  { v: 'held', label: 'Held' },
  { v: 'in_progress', label: 'In progress' },
  { v: 'paid', label: 'Paid' },
  { v: 'failed', label: 'Needs attention' },
  { v: 'voided', label: 'Released' },
];

const STATUS: Record<Item['status'], { tone: string; icon: string; label: string }> = {
  none: { tone: 'm-released', icon: 'i-clock', label: 'Not started' },
  awaiting_approval: { tone: 'm-authorized', icon: 'i-hourglass', label: 'Awaiting hold' },
  authorized: { tone: 'm-authorized', icon: 'i-lock', label: 'Hold placed' },
  captured: { tone: 'm-captured', icon: 'i-check', label: 'Charged' },
  payout_pending: { tone: 'm-captured', icon: 'i-send', label: 'Paying out' },
  paid: { tone: 'm-paid', icon: 'i-wallet', label: 'Paid' },
  voided: { tone: 'm-released', icon: 'i-ban', label: 'Released' },
  capture_declined: { tone: 'm-failed', icon: 'i-warn', label: 'Charge declined' },
  payout_failed: { tone: 'm-failed', icon: 'i-warn', label: 'Payout failed' },
};

const ENTRY_LABEL: Record<Item['entries'][number]['type'], string> = {
  AUTHORIZED: 'Hold placed',
  CAPTURED: 'Charged',
  VOIDED: 'Hold released',
  PAYOUT_SENT: 'Payout sent',
  PAID: 'Payout delivered',
  PAYOUT_FAILED: 'Payout failed',
  RETURNED: 'Payout returned',
  PLATFORM_FEE: 'ShiftCover fee',
  PAYPAL_CAPTURE_FEE: 'PayPal charge fee',
  PAYPAL_PAYOUT_FEE: 'PayPal payout fee',
  CAPTURE_DECLINED: 'Charge declined',
  PAYOUT_UNCLAIMED: 'Payout unclaimed',
  REFUNDED: 'Refunded',
  REVERSED: 'Reversed',
};

const money = (c: number) => (c > 0 ? formatUsd(c) : '–');
const day = (i: Item) =>
  new Intl.DateTimeFormat('en-US', { timeZone: i.venue_tz, month: 'short', day: 'numeric' }).format(
    new Date(i.start_at),
  );
const stamp = (iso: string, tz: string) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));

type Node = {
  label: string;
  amt: string;
  note: string;
  state: '' | 'is-done' | 'is-now' | 'is-failed' | 'is-released';
  tone: string;
};
function rail(i: Item): Node[] {
  const hold: Node = {
    label: 'Hold',
    amt: formatUsd(i.authorized_cents),
    note: 'Reserved on PayPal',
    state: 'is-done',
    tone: 'authorized',
  };
  const charge: Node = {
    label: 'Charged',
    amt: i.captured_cents > 0 ? formatUsd(i.captured_cents) : '–',
    note: 'Hours × rate + fee',
    state: '',
    tone: 'captured',
  };
  const paid: Node = {
    label: 'Paid out',
    amt: i.group === 'paid' ? formatUsd(i.worker_pay_cents) : '–',
    note: 'To the worker',
    state: '',
    tone: 'paid',
  };
  switch (i.status) {
    case 'authorized':
    case 'awaiting_approval':
    case 'none':
      hold.state = i.status === 'authorized' ? 'is-now' : '';
      break;
    case 'voided':
      hold.state = 'is-released';
      hold.note = 'Released, nothing charged';
      break;
    case 'capture_declined':
      charge.state = 'is-failed';
      charge.note = 'PayPal declined the charge';
      break;
    case 'captured':
    case 'payout_pending':
      charge.state = 'is-done';
      paid.state = 'is-now';
      break;
    case 'payout_failed':
      charge.state = 'is-done';
      paid.state = 'is-failed';
      paid.note = 'PayPal could not deliver it';
      break;
    case 'paid':
      charge.state = 'is-done';
      paid.state = 'is-done';
      break;
  }
  return [hold, charge, paid];
}

export function LedgerScreen() {
  const [data, setData] = useState<LedgerDto | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [range, setRange] = useState<(typeof RANGES)[number]['v']>('30d');
  const [group, setGroup] = useState<'' | Group>('');
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [toast, setToast] = useState('');
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(''), 3200);
    return () => clearTimeout(id);
  }, [toast]);

  const load = useCallback(async () => {
    try {
      setData(await fetchLedger({ range, ...(group ? { group } : {}) }));
      setPhase('ready');
    } catch {
      setPhase((p) => (p === 'ready' ? 'ready' : 'error'));
    }
  }, [range, group]);
  useEffect(() => {
    let live = true;
    fetchLedger({ range, ...(group ? { group } : {}) })
      .then((d) => {
        if (!live) return;
        setData(d);
        setPhase('ready');
      })
      .catch(() => live && setPhase('error'));
    return () => {
      live = false;
    };
  }, [range, group]);

  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.items ?? []).filter(
      (i) =>
        !needle ||
        (i.worker_name ?? '').toLowerCase().includes(needle) ||
        ROLE_LABELS[i.role].toLowerCase().includes(needle),
    );
  }, [data, q]);
  const open = items.find((i) => i.payment_id === openId) ?? null;
  const filtered = q.trim() !== '' || group !== '';

  const change = (fn: () => void) => {
    setPhase('loading');
    fn();
  };

  return (
    <div className="sc-page">
      {open && (
        <Breakdown
          item={open}
          onClose={() => setOpenId(null)}
          onRetried={async () => {
            setToast('Payout retried. The status updates here.');
            await load();
          }}
        />
      )}
      <header className="sc-page__head">
        <div>
          <h1 className="sc-page__title">Money</h1>
          <p className="sc-page__sub">
            Every hold, charge and payout, one row per shift. Amounts come straight from PayPal and
            the ledger.
          </p>
        </div>
      </header>

      {phase !== 'error' && (
        <section className="sc-stats" aria-label="Totals in this view">
          {(
            [
              ['Authorized', data?.totals.authorized_cents, 'i-lock'],
              ['Charged', data?.totals.captured_cents, 'i-check'],
              ['Worker pay', data?.totals.worker_pay_cents, 'i-wallet'],
              ['ShiftCover fees', data?.totals.platform_fee_cents, 'i-trending-up'],
            ] as const
          ).map(([label, v, icon]) => (
            <div className="sc-stat" key={label}>
              <span className="sc-stat__icon">
                <Icon name={icon} />
              </span>
              <span>
                <span className="sc-stat__value">
                  {phase === 'loading' || v === undefined ? (
                    <Skeleton variant="amount" />
                  ) : (
                    formatUsd(v)
                  )}
                </span>
                <span className="sc-stat__label">{label}</span>
              </span>
            </div>
          ))}
        </section>
      )}

      <div className="sc-filterbar" role="group" aria-label="Filters">
        <div className="sc-segmented" role="group" aria-label="Date range">
          {RANGES.map((r) => (
            <button
              type="button"
              className="sc-segmented__btn"
              key={r.v}
              aria-pressed={range === r.v}
              onClick={() => change(() => setRange(r.v))}
            >
              {r.label}
            </button>
          ))}
        </div>
        <label className="sc-visually-hidden" htmlFor="ledger-status">
          Status
        </label>
        <select
          className="sc-input sc-input--md sc-select"
          id="ledger-status"
          style={{ width: 'auto' }}
          value={group}
          onChange={(e) => change(() => setGroup(e.target.value as '' | Group))}
        >
          {GROUPS.map((g) => (
            <option key={g.v} value={g.v}>
              {g.label}
            </option>
          ))}
        </select>
        <div className="sc-search">
          <Icon name="i-search" size="sm" />
          <label className="sc-visually-hidden" htmlFor="ledger-q">
            Search worker or role
          </label>
          <input
            className="sc-input sc-input--md"
            id="ledger-q"
            type="search"
            placeholder="Search worker or role"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      </div>

      {data?.truncated && phase === 'ready' && (
        <Alert tone="info" icon="i-info" title="Showing the newest 300 rows" role="status">
          Narrow the date range or status to see older ones.
        </Alert>
      )}

      {phase === 'error' && (
        <div className="sc-panel">
          <span className="sc-panel__icon">
            <Icon name="i-wifi-off" size="xl" />
          </span>
          <h2 className="sc-panel__title">We couldn&apos;t load the ledger</h2>
          <p className="sc-panel__text">
            Check your connection and try again. Your money hasn&apos;t moved; only the display
            failed.
          </p>
          <Button
            variant="secondary"
            size="md"
            onClick={() => {
              setPhase('loading');
              void load();
            }}
          >
            <Icon name="i-retry" />
            Try again
          </Button>
        </div>
      )}

      {phase !== 'error' && (
        <div className="sc-tbl-scroll">
          <div
            className="sc-tbl sc-cols-ledger"
            role="table"
            aria-label="Money ledger"
            aria-busy={phase === 'loading'}
          >
            <div className="sc-tbl__row sc-tbl__row--head" role="row">
              <span role="columnheader">Date</span>
              <span role="columnheader">Shift</span>
              <span role="columnheader">Worker</span>
              <span role="columnheader" className="sc-tbl__cell--num">
                Authorized
              </span>
              <span role="columnheader" className="sc-tbl__cell--num">
                Captured
              </span>
              <span role="columnheader" className="sc-tbl__cell--num">
                Worker pay
              </span>
              <span role="columnheader" className="sc-tbl__cell--num">
                Fee
              </span>
              <span role="columnheader">Status</span>
            </div>
            {phase === 'loading' &&
              [1, 2, 3, 4, 5, 6].map((k) => (
                <div className="sc-tbl__row" aria-hidden="true" key={k}>
                  <Skeleton variant="line-short" />
                  <Skeleton variant="line" />
                  <Skeleton variant="line" />
                  <Skeleton variant="line-short" />
                  <Skeleton variant="line-short" />
                  <Skeleton variant="line-short" />
                  <Skeleton variant="line-short" />
                  <Skeleton variant="line" />
                </div>
              ))}
            {phase === 'ready' &&
              items.map((i) => {
                const st = STATUS[i.status];
                return (
                  <div
                    className={`sc-tbl__row ${i.group === 'failed' ? 'is-failed' : ''} ${openId === i.payment_id ? 'is-selected' : ''}`}
                    role="row"
                    key={i.payment_id}
                    onClick={() => setOpenId(i.payment_id)}
                    style={{ cursor: 'pointer' }}
                  >
                    <span className="sc-tbl__cell" role="cell">
                      <button
                        type="button"
                        className="sc-tbl__strong sc-btn--quiet"
                        style={{
                          textAlign: 'left',
                          background: 'none',
                          border: 0,
                          padding: 0,
                          font: 'inherit',
                          cursor: 'pointer',
                        }}
                        aria-label={`Open breakdown for ${ROLE_LABELS[i.role]} on ${day(i)}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpenId(i.payment_id);
                        }}
                      >
                        {day(i)}
                      </button>
                    </span>
                    <span className="sc-tbl__cell" role="cell">
                      <span className="sc-tbl__strong">{ROLE_LABELS[i.role]}</span>
                      <span className="sc-tbl__sub">
                        {formatTimeRange(i.start_at, i.end_at, i.venue_tz)}
                        {i.attempt > 1 ? ` · attempt ${i.attempt}` : ''}
                      </span>
                    </span>
                    <span className="sc-tbl__cell" role="cell">
                      {i.worker_name ?? '–'}
                    </span>
                    <span
                      className={`sc-tbl__cell sc-tbl__cell--num ${i.authorized_cents ? '' : 'is-empty'}`}
                      role="cell"
                    >
                      {money(i.authorized_cents)}
                    </span>
                    <span
                      className={`sc-tbl__cell sc-tbl__cell--num ${i.captured_cents ? '' : 'is-empty'}`}
                      role="cell"
                    >
                      {money(i.captured_cents)}
                    </span>
                    <span
                      className={`sc-tbl__cell sc-tbl__cell--num ${i.worker_pay_cents ? '' : 'is-empty'}`}
                      role="cell"
                    >
                      {money(i.worker_pay_cents)}
                    </span>
                    <span
                      className={`sc-tbl__cell sc-tbl__cell--num ${i.platform_fee_cents ? '' : 'is-empty'}`}
                      role="cell"
                    >
                      {money(i.platform_fee_cents)}
                    </span>
                    <span className="sc-tbl__cell" role="cell">
                      <Badge tone={st.tone} icon={st.icon}>
                        {st.label}
                      </Badge>
                    </span>
                  </div>
                );
              })}
            {phase === 'ready' && items.length === 0 && (
              <div
                className="sc-tbl__row"
                role="row"
                style={{ display: 'block', padding: '32px 16px', textAlign: 'center' }}
              >
                <h2 className="sc-panel__title">
                  {filtered || range !== 'all'
                    ? 'Nothing matches these filters'
                    : 'No money has moved yet'}
                </h2>
                <p className="sc-panel__text" style={{ margin: '8px auto 12px' }}>
                  {filtered || range !== 'all'
                    ? 'Try a longer date range or clear the status and search.'
                    : 'When a gap is covered, its hold, charge and payout show up here.'}
                </p>
                {(filtered || range !== 'all') && (
                  <Button
                    variant="secondary"
                    size="md"
                    onClick={() => {
                      setQ('');
                      if (group !== '' || range !== 'all')
                        change(() => {
                          setGroup('');
                          setRange('all');
                        });
                    }}
                  >
                    Clear filters
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {toast && (
        <div className="sc-snack-wrap">
          <div className="sc-snack" role="status">
            <Icon name="i-check" />
            {toast}
          </div>
        </div>
      )}
    </div>
  );
}

function Breakdown({
  item: i,
  onClose,
  onRetried,
}: {
  item: Item;
  onClose: () => void;
  onRetried: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const st = STATUS[i.status];
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeBtn.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, [onClose]);

  const copy = (label: string, value: string) => {
    void navigator.clipboard?.writeText(value).catch(() => {});
    setCopied(label);
    setTimeout(() => setCopied((c) => (c === label ? null : c)), 2000);
  };
  const retry = async () => {
    if (busy || i.approved_hours === null) return;
    setBusy(true);
    setErr('');
    try {
      await approveAndPay(i.slot_id, i.approved_hours);
      await onRetried();
    } catch (e) {
      setErr(
        e instanceof ApiFailure
          ? e.message
          : "We couldn't reach the server. Nothing was sent twice; try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  const refs: Array<[string, string]> = [];
  for (const [label, value] of [
    ['Order', i.references.order],
    ['Authorization', i.references.authorization],
    ['Capture', i.references.capture],
    ['Payout', i.references.payout],
  ] as Array<[string, string | null]>)
    if (value) refs.push([label, value]);
  const lines: Array<{ label: string; sub: string; amt: string; cls?: string }> = [
    {
      label: 'Charged to you',
      sub: 'Worker pay + ShiftCover fee',
      amt: formatUsd(i.captured_cents),
      cls: 'sc-money__row--total',
    },
    {
      label: 'Worker pay',
      sub:
        i.approved_hours === null
          ? 'Set when hours are approved'
          : `${i.approved_hours} h approved`,
      amt: formatUsd(i.worker_pay_cents),
    },
    { label: 'ShiftCover fee', sub: 'Platform fee', amt: formatUsd(i.platform_fee_cents) },
    { label: 'Hold', sub: 'Reserved before the shift', amt: formatUsd(i.authorized_cents) },
    ...(i.released_cents !== null
      ? [
          {
            label: 'Hold not used',
            sub: 'Released back to you',
            amt: formatUsd(i.released_cents),
            cls: 'sc-money__row--muted',
          },
        ]
      : []),
    ...(i.paypal_capture_fee_cents > 0
      ? [
          {
            label: 'PayPal charge fee',
            sub: 'Reported by PayPal',
            amt: formatUsd(i.paypal_capture_fee_cents),
            cls: 'sc-money__row--muted',
          },
        ]
      : []),
    ...(i.paypal_payout_fee_cents > 0
      ? [
          {
            label: 'PayPal payout fee',
            sub: 'Reported by PayPal',
            amt: formatUsd(i.paypal_payout_fee_cents),
            cls: 'sc-money__row--muted',
          },
        ]
      : []),
  ];

  return (
    <div className="sc-drawerwrap">
      <aside
        className="sc-drawer"
        role="dialog"

        aria-label="Shift breakdown"
      >
        <div className="sc-drawer__head">
          <div>
            <h2 className="sc-drawer__title" id="dr-t">
              {ROLE_LABELS[i.role]}
            </h2>
            <p className="sc-drawer__sub">
              {i.worker_name ?? 'No worker'} · {day(i)} ·{' '}
              {formatTimeRange(i.start_at, i.end_at, i.venue_tz)}
            </p>
          </div>
          <button
            ref={closeBtn}
            type="button"
            className="sc-btn sc-btn--secondary sc-btn--md sc-btn--icon"
            onClick={onClose}
            aria-label="Close breakdown"
          >
            <Icon name="i-x" />
          </button>
        </div>
        <div>
          <Badge tone={st.tone} icon={st.icon}>
            {st.label}
          </Badge>
        </div>

        <div className="sc-rail" aria-label="Money timeline">
          {rail(i).map((n) => (
            <div className={`sc-rail__item sc-rail__item--t-${n.tone} ${n.state}`} key={n.label}>
              <div className="sc-rail__top">
                <span className="sc-rail__node" />
                <span className="sc-rail__line" />
              </div>
              <span className="sc-rail__label">{n.label}</span>
              <span className="sc-rail__amt">{n.amt}</span>
              <span className="sc-rail__note">{n.note}</span>
            </div>
          ))}
        </div>

        <div className="sc-money">
          {lines.map((m) => (
            <div className={`sc-money__row ${m.cls ?? ''}`} key={m.label}>
              <span className="sc-money__label">
                <strong>{m.label}</strong>
                <small>{m.sub}</small>
              </span>
              <span className="sc-money__amt">{m.amt}</span>
            </div>
          ))}
        </div>

        {refs.length > 0 && (
          <div className="sc-pass__refs">
            {refs.map(([label, value]) => (
              <button
                type="button"
                className="sc-ref"
                key={label}
                onClick={() => copy(label, value)}
                aria-label={`Copy ${label} reference`}
              >
                <small>{label}</small>
                {value}
                <Icon name={copied === label ? 'i-check' : 'i-copy'} size="sm" />
              </button>
            ))}
          </div>
        )}

        {i.status === 'payout_failed' && (
          <Alert tone="error" icon="i-warn" title="The payout didn't reach the worker" role="alert">
            {i.last_error ?? 'PayPal could not deliver it.'} The money is safe. Once the
            worker&apos;s PayPal email is right, retry the payout.
            <span style={{ display: 'block', marginTop: 8 }}>
              <Button
                variant="primary"
                size="md"
                busy={busy}
                onClick={() => void retry()}
                inert={i.approved_hours === null}
              >
                <Icon name="i-retry" />
                {busy ? 'Retrying…' : 'Retry payout'}
              </Button>
            </span>
            {err && (
              <span
                className="sc-field__error"
                role="alert"
                style={{ display: 'block', marginTop: 8 }}
              >
                {err}
              </span>
            )}
          </Alert>
        )}
        {i.status === 'capture_declined' && (
          <Alert tone="error" icon="i-warn" title="PayPal declined the charge" role="alert">
            {i.last_error ?? 'Nothing was paid out.'} Retry the charge from the shift on{' '}
            <Link href="/app/approvals">Approvals</Link>.
          </Alert>
        )}

        <section aria-labelledby="entries-t">
          <h3 className="sc-card__title" id="entries-t">
            Ledger entries
          </h3>
          {i.entries.length === 0 ? (
            <p className="sc-card__lead">Nothing recorded yet.</p>
          ) : (
            <ul className="sc-money" aria-label="Ledger entries">
              {i.entries.map((e) => (
                <li className="sc-money__row" key={e.id}>
                  <span className="sc-money__label">
                    <strong>{ENTRY_LABEL[e.type]}</strong>
                    <small>{stamp(e.created_at, i.venue_tz)}</small>
                  </span>
                  <span className="sc-money__amt">{formatUsd(e.amount_cents)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </aside>
    </div>
  );
}
