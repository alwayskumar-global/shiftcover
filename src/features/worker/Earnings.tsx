'use client';

import { useCallback, useEffect, useState } from 'react';
import { ROLE_LABELS } from '@/domain/roles';
import { ApiFailure, fetchWorkerEarnings, type WorkerEarningsDto } from '@/features/client-api';
import { usePolling } from '@/features/manager/use-polling';
import { formatUsd } from '@/ui/format';
import { Icon } from '@/ui/icon';
import { Alert, Badge, Button, Skeleton } from '@/ui/primitives';
import { WorkerTabbar } from './WorkerTabbar';

/**
 * G2-W4 Earnings (design/g2). The worker's own pay from GET /api/w/earnings: nothing here is computed from
 * employer amounts, and every money figure is the server's. Only the hours x rate line is shown as a formula.
 */
type Row = WorkerEarningsDto['items'][number];
type Phase = 'loading' | 'ready' | 'error' | 'signedOut';

const BADGE: Record<Row['status'], { tone: string; icon: string; label: string }> = {
  approved: { tone: 'm-captured', icon: 'i-check', label: 'Approved' },
  paying: { tone: 'm-captured', icon: 'i-send', label: 'Paying' },
  paid: { tone: 'm-paid', icon: 'i-wallet', label: 'Paid' },
  failed: { tone: 'm-failed', icon: 'i-warn', label: 'Payout failed' },
};

const TEXT: Record<Row['status'], string> = {
  approved: 'Your manager approved this shift. Your payout is being prepared.',
  paying: 'Your payout is on its way to your PayPal account.',
  paid: 'Paid to your PayPal account.',
  failed:
    "PayPal couldn't deliver this payout. The money is safe and is not lost; it isn't counted in your totals.",
};

const dateLabel = (r: Row) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: r.venue_tz,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date(r.start_at));

const hoursLabel = (h: number) => `${Number.isInteger(h) ? h : h.toFixed(2).replace(/0$/, '')} h`;

export function Earnings() {
  const [data, setData] = useState<WorkerEarningsDto | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [toast, setToast] = useState('');
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(''), 3200);
    return () => clearTimeout(id);
  }, [toast]);

  const load = useCallback(async () => {
    try {
      setData(await fetchWorkerEarnings());
      setPhase('ready');
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 401) setPhase('signedOut');
      else setPhase((p) => (p === 'ready' ? 'ready' : 'error'));
    }
  }, []);
  usePolling(load, 15_000);

  const copy = (value: string) => {
    void navigator.clipboard?.writeText(value).catch(() => {});
    setToast('Reference copied');
  };

  const items = data?.items ?? [];
  const isEmpty = phase === 'ready' && items.length === 0;
  const failed = items.filter((r) => r.status === 'failed');

  return (
    <main className="sc-app" aria-busy={phase === 'loading'}>
      <header className="sc-appbar">
        <h1 className="sc-appbar__title">Earnings</h1>
        <span className="sc-wordmark__mark" aria-hidden="true">
          <Icon name="i-check" />
        </span>
      </header>

      <section className="sc-app__body sc-app__body--grow">
        {phase === 'loading' && (
          <>
            <span className="sc-visually-hidden" role="status">
              Loading your earnings
            </span>
            <div className="sc-totals" aria-hidden="true">
              {[1, 2].map((k) => (
                <div className="sc-total" key={k}>
                  <Skeleton variant="eyebrow" />
                  <Skeleton variant="title" />
                  <Skeleton variant="line-short" />
                </div>
              ))}
            </div>
            {[1, 2, 3].map((k) => (
              <div className="sc-earn" aria-hidden="true" key={k}>
                <Skeleton variant="eyebrow" />
                <Skeleton variant="title" />
                <Skeleton variant="line" />
                <Skeleton variant="line-short" />
              </div>
            ))}
          </>
        )}

        {phase === 'error' && (
          <div className="sc-notice sc-rise">
            <span className="sc-notice__icon sc-notice__icon--error">
              <Icon name="i-wifi-off" size="xl" />
            </span>
            <h2 className="sc-notice__title" role="status">
              We couldn&apos;t load your earnings
            </h2>
            <p className="sc-notice__text">
              Check your connection and try again. Your money isn&apos;t affected.
            </p>
            <div className="sc-notice__actions">
              <Button
                variant="primary"
                size="lg"
                block
                onClick={() => {
                  setPhase('loading');
                  void load();
                }}
              >
                <Icon name="i-retry" />
                Try again
              </Button>
            </div>
          </div>
        )}

        {phase === 'signedOut' && (
          <div className="sc-notice sc-rise">
            <span className="sc-notice__icon">
              <Icon name="i-lock" size="xl" />
            </span>
            <h2 className="sc-notice__title" role="status">
              Open your link again
            </h2>
            <p className="sc-notice__text">
              To see your earnings, open the latest offer link we sent you.
            </p>
          </div>
        )}

        {isEmpty && (
          <div className="sc-notice sc-rise">
            <span className="sc-notice__icon">
              <Icon name="i-wallet" size="xl" />
            </span>
            <h2 className="sc-notice__title">No earnings yet</h2>
            <p className="sc-notice__text">
              After a manager approves your hours, each shift shows up here with what you&apos;re
              owed and when it&apos;s paid.
            </p>
          </div>
        )}

        {phase === 'ready' && data && items.length > 0 && (
          <>
            <div className="sc-totals">
              {(
                [
                  ['This week', data.week],
                  ['This month', data.month],
                ] as const
              ).map(([label, t]) => (
                <div className="sc-total" key={label}>
                  <span className="sc-eyebrow">{label}</span>
                  <span className="sc-total__amount">{formatUsd(t.total_cents)}</span>
                  <span className="sc-total__sub">
                    <span>Paid {formatUsd(t.paid_cents)}</span>
                    <span>On the way {formatUsd(t.on_the_way_cents)}</span>
                  </span>
                </div>
              ))}
            </div>

            {failed.length > 0 && (
              <Alert tone="error" icon="i-warn" title="A payout failed" role="alert">
                {formatUsd(data.failed_cents)} is safe, but it hasn&apos;t reached you. It
                isn&apos;t in the totals above. Fix it below.
              </Alert>
            )}

            <h2 className="sc-section-title">
              Shifts<small>{items.length}</small>
            </h2>
            {items.map((r) => {
              const b = BADGE[r.status];
              return (
                <article
                  className={`sc-earn ${r.status === 'failed' ? 'sc-earn--failed' : ''}`}
                  key={r.slot_id}
                >
                  <div className="sc-earn__top">
                    <p className="sc-eyebrow">{dateLabel(r)}</p>
                    <Badge tone={b.tone} icon={b.icon}>
                      {b.label}
                    </Badge>
                  </div>
                  <div className="sc-earn__line">
                    <h3 className="sc-earn__title">{ROLE_LABELS[r.role]}</h3>
                    <span className="sc-earn__amount">{formatUsd(r.worker_pay_cents)}</span>
                  </div>
                  <p className="sc-earn__formula">
                    {hoursLabel(r.approved_hours)} × {formatUsd(r.rate_cents)}/hr · {r.venue_name}
                  </p>
                  <p className="sc-earn__text">{TEXT[r.status]}</p>
                  {r.reference && (
                    <button
                      type="button"
                      className="sc-ref sc-ref--worker"
                      onClick={() => copy(r.reference!)}
                      aria-label="Copy PayPal payout reference"
                    >
                      <small>PayPal</small>
                      <span>{r.reference}</span>
                      <Icon name="i-copy" size="sm" />
                    </button>
                  )}
                  {r.status === 'failed' && (
                    <div className="sc-earn__actions">
                      <a
                        className="sc-btn sc-btn--primary sc-btn--block"
                        href="/w/profile#payout-email"
                      >
                        <Icon name="i-mail" />
                        Check your PayPal email
                      </a>
                      <p className="sc-help">
                        If the email is wrong, fix it here. Once it is right, your manager can retry
                        the payout.
                      </p>
                    </div>
                  )}
                </article>
              );
            })}
          </>
        )}
      </section>

      {toast && (
        <div className="sc-snack-wrap">
          <div className="sc-snack" role="status">
            <Icon name="i-check" />
            {toast}
          </div>
        </div>
      )}

      <WorkerTabbar current="earnings" />
    </main>
  );
}
