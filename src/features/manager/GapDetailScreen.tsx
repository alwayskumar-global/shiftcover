'use client';

import Link from 'next/link';
import { useCallback, useRef, useState } from 'react';
import type { GapDetailResponse, OfferDto, WaveSummaryDto } from '@/api/dto';
import { WAVES } from '@/config/matching';
import { maxRateCents, payForMinutesCents } from '@/domain/money';
import { ROLE_LABELS } from '@/domain/roles';
import {
  ApiFailure,
  cancelGap,
  fetchGap,
  startOffering,
  stubAuthorize,
  widenRadius,
} from '@/features/client-api';
import { Alert, Badge, Button, Skeleton } from '@/ui/primitives';
import { Dialog } from '@/ui/dialog';
import { Icon } from '@/ui/icon';
import {
  dayLabel,
  formatClock,
  formatHours,
  formatRate,
  formatTimeRange,
  formatUsd,
} from '@/ui/format';
import { usePolling } from './use-polling';
import { useMe } from './me-context';
import { STATUS } from './roster-model';

/** M4 gap detail (design/g1: M4-gap-detail): header, facts, wave timeline, offers, money timeline. */

type Slot = GapDetailResponse['slot'];
type Payment = NonNullable<GapDetailResponse['payment']>;
type PassState = 'is-done' | 'is-now' | 'is-next' | 'is-failed' | 'is-released' | 'is-skipped';

const OFFER_BADGE: Record<OfferDto['status'], { label: string; icon: string; cls: string }> = {
  sent: { label: 'Sent', icon: 'i-send', cls: 'sc-badge--neutral' },
  opened: { label: 'Opened', icon: 'i-eye', cls: 'sc-badge--st-offering' },
  claimed: { label: 'Claimed', icon: 'i-check', cls: 'sc-badge--st-confirmed' },
  declined: { label: 'Declined', icon: 'i-x', cls: 'sc-badge--neutral' },
  expired: { label: 'Expired', icon: 'i-clock', cls: 'sc-badge--neutral' },
  withdrawn: { label: 'Withdrawn', icon: 'i-ban', cls: 'sc-badge--neutral sc-badge--dashed' },
};

const rel = (fromMs: number, nowMs: number) => {
  const d = Math.floor((nowMs - fromMs) / 60_000);
  return d < 1 ? 'just now' : d < 60 ? `${d} min ago` : `${Math.floor(d / 60)} h ago`;
};

function offerTime(o: OfferDto): string {
  switch (o.status) {
    case 'claimed':
      return o.claimed_at ?? o.sent_at;
    case 'declined':
      return o.declined_at ?? o.sent_at;
    case 'expired':
      return o.expired_at ?? o.expires_at;
    case 'withdrawn':
      return o.withdrawn_at ?? o.sent_at;
    case 'opened':
      return o.opened_at ?? o.sent_at;
    default:
      return o.sent_at;
  }
}

export function GapDetailScreen({ id }: { id: string }) {
  const me = useMe();
  const [data, setData] = useState<GapDetailResponse | null>(null);
  const [error, setError] = useState<'missing' | 'network' | null>(null);
  const [dlg, setDlg] = useState<'cancel' | null>(null);
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState<null | 'cancel' | 'radius' | 'approve'>(null);
  const [actionError, setActionError] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      setData(await fetchGap(id));
      setError(null);
    } catch (e) {
      setError(
        e instanceof ApiFailure && (e.status === 404 || e.status === 400) ? 'missing' : 'network',
      );
    }
  }, [id]);
  usePolling(load, 3000);

  const say = (t: string) => {
    setToast(t);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 3200);
  };
  const copy = (v: string) => {
    void navigator.clipboard?.writeText(v).catch(() => {});
    say('Reference copied');
  };

  if (error === 'missing') {
    return (
      <div className="sc-page">
        <div className="sc-panel" role="alert">
          <span className="sc-panel__icon">
            <Icon name="i-alert" size="xl" />
          </span>
          <h2 className="sc-panel__title">We couldn&apos;t find that gap</h2>
          <p className="sc-panel__text">It may have been removed, or the link is wrong.</p>
          <Link className="sc-btn sc-btn--secondary sc-btn--md" href="/app/roster">
            Back to roster
          </Link>
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="sc-page" aria-busy="true">
        <header className="sc-gaphead">
          <div className="sc-gaphead__main">
            <Skeleton variant="name" />
            <Skeleton variant="stat" />
          </div>
        </header>
        {error === 'network' && (
          <Alert tone="warning" icon="i-wifi-off" title="We couldn't load this gap" role="alert">
            Check your connection. This page keeps trying.
          </Alert>
        )}
      </div>
    );
  }

  const { slot, waves, offers, payment, widen } = data;
  const tz = slot.venue_tz;
  const nowMs = Date.parse(data.server_time);
  const minutes = Math.round(slot.hours * 60);
  const capRate = maxRateCents(slot.base_rate_cents, slot.max_premium_pct);
  const st = STATUS[slot.status];
  const claimed = offers.find((o) => o.status === 'claimed');
  const workerName = slot.worker?.name ?? claimed?.worker.name ?? null;
  const first = workerName?.split(' ')[0] ?? '';
  const finalRate = slot.offered_rate_cents;
  const finalPay = finalRate !== null ? payForMinutesCents(finalRate, minutes) : null;
  const held = payment?.authorized_cents ?? 0;
  const holdText = formatUsd(held);
  const isFilled = ['confirmed', 'in_progress', 'pending_approval', 'settling', 'settled'].includes(
    slot.status,
  );
  const awaitingApproval = payment?.status === 'awaiting_approval';
  const canCancel = ['open', 'offering', 'confirmed'].includes(slot.status);

  // ---- badges
  const moneyBadge = (() => {
    switch (payment?.status) {
      case 'capture_declined':
        return { cls: 'sc-badge--error', icon: 'i-warn', label: 'Capture declined' };
      case 'payout_failed':
        return { cls: 'sc-badge--error', icon: 'i-warn', label: 'Payout failed' };
      case 'voided':
        return { cls: 'sc-badge--neutral', icon: 'i-shield', label: 'Hold released' };
      case 'captured':
      case 'payout_pending':
      case 'paid':
        return { cls: 'sc-badge--success', icon: 'i-banknote', label: 'Charged' };
      case 'authorized':
        return { cls: 'sc-badge--info', icon: 'i-shield', label: `${holdText} on hold` };
      default:
        return { cls: 'sc-badge--neutral', icon: 'i-clock', label: 'Hold needed' };
    }
  })();

  // ---- facts
  const lastWave = waves[waves.length - 1];
  const currentRate =
    slot.status === 'offering' && lastWave
      ? `${formatRate(lastWave.rate_cents)} · wave ${lastWave.wave}`
      : isFilled && finalRate !== null
        ? `${formatRate(finalRate)} · final`
        : slot.status === 'unfilled'
          ? `${formatRate(lastWave?.rate_cents ?? capRate)} · ${lastWave?.capped ? 'cap reached' : 'last wave'}`
          : `${formatRate(slot.base_rate_cents)} · base`;
  const facts = [
    { k: 'Current rate', v: currentRate },
    { k: 'Cap', v: `+${slot.max_premium_pct}% · ${formatRate(capRate)}` },
    { k: 'Fill by', v: slot.fill_by ? formatClock(slot.fill_by, tz) : '–' },
    { k: 'Worker', v: workerName ?? 'Not filled yet' },
  ];

  // ---- banner
  const nextWaveRate = (n: number) =>
    Math.min(
      capRate,
      Math.round(
        (slot.base_rate_cents * (100 + (WAVES.find((w) => w.wave === n)?.premiumPct ?? 0))) / 100,
      ),
    );
  const banner = (() => {
    const claimedAt = claimed?.claimed_at ? formatClock(claimed.claimed_at, tz) : '';
    switch (slot.status) {
      case 'open':
        return {
          tone: 'warning',
          icon: 'i-lock',
          title: 'Waiting for your approval of the hold',
          text: 'We start offering the shift to qualified workers once the hold is placed.',
        };
      case 'offering': {
        const w = slot.current_wave ?? 1;
        return {
          tone: 'info',
          icon: 'i-send',
          title: `Wave ${w} is open and nobody has claimed yet`,
          text:
            w < 3
              ? `The next wave goes out at ${formatRate(nextWaveRate(w + 1))}${w + 1 === 3 ? ', the cap, to everyone eligible' : ''} unless someone claims first.`
              : `This is the last wave. The shift is unfilled if nobody claims by ${slot.fill_by ? formatClock(slot.fill_by, tz) : 'the deadline'}.`,
        };
      }
      case 'confirmed':
        return {
          tone: 'success',
          icon: 'i-check',
          title: `${workerName ?? 'A worker'} claimed this${claimedAt ? ` at ${claimedAt}` : ''}`,
          text:
            finalRate !== null && finalPay !== null
              ? `Final rate ${formatRate(finalRate)}, pay ${formatUsd(finalPay)}. The other offers were withdrawn.`
              : 'The other offers were withdrawn.',
        };
      case 'unfilled':
        return {
          tone: 'warning',
          icon: 'i-warn',
          title: 'Nobody claimed this shift',
          text: `The ${holdText} hold was released. Nothing was charged.`,
        };
      case 'in_progress':
        return {
          tone: 'info',
          icon: 'i-play',
          title: `${workerName ?? 'The worker'} is on shift`,
          text: 'Hours are approved after the shift ends.',
        };
      case 'pending_approval':
        return {
          tone: 'pending',
          icon: 'i-hourglass',
          title: `${first || 'The worker'} finished. Hours need your approval`,
          text: 'Money moves only after you approve. Approving happens on the Approvals screen (coming soon).',
        };
      case 'settling':
        return payment?.status === 'capture_declined'
          ? {
              tone: 'pending',
              icon: 'i-hourglass',
              title: 'Settling is stuck on the charge',
              text: 'Hours were approved, but PayPal declined the charge. See Money below.',
            }
          : payment?.status === 'payout_failed'
            ? {
                tone: 'pending',
                icon: 'i-hourglass',
                title: 'Settling is stuck on the payout',
                text: `You were charged, but the payout to ${first || 'the worker'} failed. See Money below.`,
              }
            : {
                tone: 'pending',
                icon: 'i-hourglass',
                title: 'Settling',
                text: 'The charge and the payout are in progress. See Money below.',
              };
      case 'cancelled':
        return {
          tone: 'info',
          icon: 'i-ban',
          title: 'You cancelled this gap',
          text: 'Offers were withdrawn and the hold was released. Nothing was charged.',
        };
      default:
        return null;
    }
  })();

  // ---- waves (A)
  const counts = (n: number) => {
    const o = offers.filter((x) => x.wave === n);
    const c = (s: OfferDto['status']) => o.filter((x) => x.status === s).length;
    const parts = [
      [c('claimed'), 'claimed'],
      [c('declined'), 'declined'],
      [c('opened'), 'opened'],
      [c('sent'), 'waiting'],
      [c('expired'), 'expired'],
      [c('withdrawn'), 'withdrawn'],
    ]
      .filter(([k]) => (k as number) > 0)
      .map(([k, l]) => `${k} ${l}`);
    return parts.join(' · ') || 'No offers';
  };
  const audience = (w: WaveSummaryDto) =>
    w.wave === 1
      ? `Top ${w.audience_count} candidates`
      : w.wave === 2
        ? `Next ${w.audience_count}`
        : `Everyone eligible (${w.audience_count})`;
  const premNote = (rate: number) => {
    const p = Math.round((rate / slot.base_rate_cents - 1) * 100);
    return p <= 0 ? 'Base rate' : `+${p}%`;
  };
  const waveRows = [1, 2, 3].map((n) => {
    const w = waves.find((x) => x.wave === n);
    const isLast = n === 3;
    if (!w) {
      const planned = nextWaveRate(n);
      const next = slot.status === 'offering';
      return {
        n,
        tone: 'wave',
        st: (next ? 'is-next' : 'is-skipped') as PassState,
        icon: next ? 'i-send' : 'i-ban',
        tag: next ? 'Sends next' : 'Not sent',
        when: next ? 'Next' : 'Not sent',
        audience: n === 2 ? 'Next 5' : 'Everyone eligible',
        result: next
          ? n === (slot.current_wave ?? 1) + 1
            ? 'Goes out unless someone claims.'
            : 'Goes out after the previous wave.'
          : slot.status === 'cancelled'
            ? 'Not sent'
            : 'Not needed',
        rate: formatRate(planned),
        rateNote: n === 3 ? `Cap +${slot.max_premium_pct}%` : premNote(planned),
        cap: isLast,
        isLast,
      };
    }
    const wasClaim = offers.some((o) => o.wave === n && o.status === 'claimed');
    const latestLive = slot.status === 'offering' && n === (slot.current_wave ?? 1);
    const stopped = slot.status === 'cancelled';
    const noTakers = slot.status === 'unfilled';
    return {
      n,
      tone: wasClaim ? 'claimed' : 'wave',
      st: (latestLive ? 'is-now' : stopped && n > 1 ? 'is-skipped' : 'is-done') as PassState,
      icon: wasClaim ? 'i-check' : stopped && n > 1 ? 'i-ban' : 'i-send',
      tag: wasClaim
        ? 'Claimed'
        : latestLive
          ? 'Open now'
          : noTakers
            ? 'No takers'
            : stopped
              ? 'Stopped'
              : isFilled
                ? 'No takers'
                : 'Sent',
      when: formatClock(w.sent_at, tz),
      audience: audience(w),
      result: counts(n),
      rate: formatRate(w.rate_cents),
      rateNote: wasClaim
        ? `${premNote(w.rate_cents)} · final rate`
        : n === 3
          ? `Cap +${slot.max_premium_pct}%`
          : premNote(w.rate_cents),
      cap: isLast || w.capped,
      isLast,
    };
  });

  // ---- money (C)
  const refs = payment?.paypal_references;
  const ref = (label: string, value: string | null | undefined) =>
    value ? [{ label, value }] : [];
  const money = moneyRows(payment, slot, { holdText, first, tz, workerPay: finalPay });

  // ---- actions
  async function onCancel() {
    setBusy('cancel');
    setActionError('');
    try {
      await cancelGap(id);
      setDlg(null);
      say(`Gap cancelled. Hold of ${holdText} released.`);
      await load();
    } catch {
      setActionError('We couldn’t cancel the gap. Nothing changed. Try again.');
      setDlg(null);
    } finally {
      setBusy(null);
    }
  }
  const radiusNext = Math.min(widen.radius_mi + 5, widen.max_radius_mi);
  async function onWidenRadius() {
    if (busy) return;
    setBusy('radius');
    setActionError('');
    try {
      await widenRadius(id, radiusNext);
      say(`Radius widened to ${radiusNext} mi.`);
      await load();
    } catch {
      setActionError('We couldn’t widen the radius. Nothing changed. Try again.');
    } finally {
      setBusy(null);
    }
  }
  /** Stub-only: authorizes the new hold without PayPal and starts offering again. */
  async function onStubApprove() {
    if (busy) return;
    setBusy('approve');
    setActionError('');
    try {
      await stubAuthorize(id);
      await startOffering(id);
      say(`Hold increased to ${holdText}`);
      await load();
    } catch {
      setActionError('We couldn’t place the hold. Nothing was charged. Try again.');
    } finally {
      setBusy(null);
    }
  }

  const dateTime = `${dayLabel(slot.start_at, data.server_time, tz)} · ${formatTimeRange(slot.start_at, slot.end_at, tz)}`;
  const radiusSuggest = slot.status === 'unfilled' && widen.radius_mi < widen.max_radius_mi;

  return (
    <div className="sc-page">
      {dlg === 'cancel' && (
        <Dialog titleId="dlg-cancel-title" role="alertdialog" onClose={() => setDlg(null)}>
          <h2 className="sc-dialog__title" id="dlg-cancel-title">
            Cancel this gap?
          </h2>
          <p className="sc-dialog__text">
            {ROLE_LABELS[slot.role]},{' '}
            {dateTime.toLowerCase().startsWith('today')
              ? 'today ' + formatTimeRange(slot.start_at, slot.end_at, tz).replace('–', 'to')
              : dateTime}
            . This can&apos;t be undone.
          </p>
          <ul className="sc-dialog__list">
            <li>Offers to workers are withdrawn.</li>
            <li>The {holdText} hold is released. Nothing is charged.</li>
            <li>The shift stays uncovered.</li>
          </ul>
          <div className="sc-dialog__actions">
            <Button variant="secondary" size="md" data-autofocus onClick={() => setDlg(null)}>
              Keep gap
            </Button>
            <Button variant="danger" size="md" busy={busy === 'cancel'} onClick={onCancel}>
              Cancel gap
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
      <nav className="sc-crumbs" aria-label="Breadcrumb">
        <Link href="/app/roster">
          <Icon name="i-chev-left" size="sm" />
          Roster
        </Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">
          Gap · {ROLE_LABELS[slot.role]}, {formatClock(slot.start_at, tz)}
        </span>
      </nav>

      <header className="sc-gaphead">
        <div className="sc-gaphead__main">
          <p className="sc-eyebrow">Gap · {slot.venue_name}</p>
          <h1 className="sc-gaphead__title">{ROLE_LABELS[slot.role]}</h1>
          <div className="sc-gaphead__meta">
            <span>
              <Icon name="i-calendar" size="sm" />
              {dateTime}
            </span>
            <span>
              <Icon name="i-clock" size="sm" />
              {formatHours(slot.hours)}
            </span>
            {slot.replaces_worker && (
              <span>
                <Icon name="i-user-x" size="sm" />
                Replacing {slot.replaces_worker.name}
              </span>
            )}
          </div>
        </div>
        <div className="sc-gaphead__side">
          <div className="sc-gaphead__badges">
            <Badge tone={`st-${st.key}${st.dashed ? ' sc-badge--dashed' : ''}`} icon={st.icon}>
              {st.label}
            </Badge>
            <Badge tone={moneyBadge.cls.replace('sc-badge--', '')} icon={moneyBadge.icon}>
              {moneyBadge.label}
            </Badge>
          </div>
          <div className="sc-toolbar__group">
            {/* Raising the cap needs the extra PayPal hold (M2); the control stays visible but inert until then. */}
            <Button
              variant="secondary"
              size="md"
              inert
              title="Available once PayPal approval is connected"
            >
              <Icon name="i-plus" size="sm" />
              Widen the cap
            </Button>
            <Button
              variant="danger-quiet"
              size="md"
              inert={!canCancel}
              title={canCancel ? undefined : 'Not available once the shift has started or ended'}
              onClick={() => setDlg('cancel')}
            >
              <Icon name="i-ban" size="sm" />
              Cancel gap
            </Button>
          </div>
        </div>
      </header>

      <div className="sc-facts" aria-label="Key facts">
        {facts.map((f) => (
          <div className="sc-fact" key={f.k}>
            <span className="sc-fact__label">{f.k}</span>
            <span className="sc-fact__value">{f.v}</span>
          </div>
        ))}
      </div>

      {actionError && <Alert tone="error" icon="i-warn" title={actionError} role="alert" />}
      {banner && (
        <Alert tone={banner.tone as 'info'} icon={banner.icon} title={banner.title} role="status">
          {banner.text}
        </Alert>
      )}

      {slot.status === 'unfilled' && (
        <section className="sc-card" aria-labelledby="sug-title">
          <h2 className="sc-card__title" id="sug-title">
            Try one of these
          </h2>
          <div className="sc-suggest">
            <div className="sc-suggest__item">
              <span className="sc-suggest__title">Raise the cap</span>
              <span className="sc-suggest__text">
                Offer a higher rate than +{slot.max_premium_pct}% ({formatRate(capRate)}). The extra
                hold is approved in PayPal; you are still charged for hours worked only.
              </span>
              <Button
                variant="primary"
                size="md"
                inert
                title="Available once PayPal approval is connected"
              >
                Raise cap and re-offer
              </Button>
            </div>
            {radiusSuggest && (
              <div className="sc-suggest__item">
                <span className="sc-suggest__title">Widen the radius</span>
                <span className="sc-suggest__text">
                  Offer to qualified workers farther away: {widen.radius_mi} mi to {radiusNext} mi.
                  Rates stay the same.
                </span>
                <Button
                  variant="secondary"
                  size="md"
                  busy={busy === 'radius'}
                  onClick={onWidenRadius}
                >
                  Widen radius and re-offer
                </Button>
              </div>
            )}
          </div>
        </section>
      )}

      <section className="sc-card" aria-labelledby="a-title">
        <div className="sc-section__head">
          <h2 className="sc-card__title" id="a-title">
            A · Offer waves
          </h2>
          <span className="sc-section__note">
            The rate rises only if nobody claims. The dashed ceiling is your cap.
          </span>
        </div>
        <div className="sc-pass">
          {waveRows.map((w) => (
            <div className={`sc-pass__item sc-pass__item--${w.tone} ${w.st}`} key={w.n}>
              <div className="sc-pass__top">
                <span className="sc-pass__node">
                  <Icon name={w.icon} />
                </span>
                <span className={`sc-pass__line ${w.isLast ? 'sc-visually-hidden' : ''}`} />
              </div>
              <div>
                <div className="sc-pass__head">
                  Wave {w.n}
                  <span className="sc-pass__tag">{w.tag}</span>
                </div>
                <div className="sc-offers__name">
                  {w.when} · {w.audience}
                </div>
                <div className="sc-pass__text">{w.result}</div>
              </div>
              {w.cap && (
                <span className="sc-pass__capflag">
                  <Icon name="i-lock" size="sm" />
                  Cap
                </span>
              )}
              <div className="sc-pass__bar">
                <div
                  className={`sc-pass__step sc-pass__step--${w.n} ${w.cap ? 'sc-pass__step--cap' : ''}`}
                >
                  <strong>{w.rate}</strong>
                  <span>{w.rateNote}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="sc-card sc-card--flush" aria-labelledby="b-title">
        <div className="sc-section__head">
          <h2 className="sc-card__title" id="b-title">
            B · Offers
          </h2>
          <span className="sc-section__note">
            {offers.length} {offers.length === 1 ? 'row' : 'rows'} · times are relative; hover for
            the clock time
          </span>
        </div>
        <div className="sc-offers" role="table" aria-label="Offers">
          <div className="sc-offers__row sc-offers__row--head" role="row">
            <span role="columnheader">Worker</span>
            <span role="columnheader">Wave</span>
            <span role="columnheader">Status</span>
            <span role="columnheader">When</span>
          </div>
          {offers.map((o) => {
            const b = OFFER_BADGE[o.status];
            const at = offerTime(o);
            return (
              <div
                className={`sc-offers__row ${o.status === 'claimed' ? 'is-claimed' : o.status === 'withdrawn' || o.status === 'expired' ? 'is-muted' : ''}`}
                role="row"
                key={o.id}
              >
                <span className="sc-offers__who" role="cell">
                  <span
                    className={`sc-avatar sc-avatar--${o.worker.avatar_tint}`}
                    aria-hidden="true"
                  >
                    {o.worker.initials}
                  </span>
                  <span>
                    <span className="sc-offers__name">{o.worker.name}</span>
                    <span className="sc-offers__role">{ROLE_LABELS[o.worker.role]}</span>
                    {o.status === 'claimed' && (
                      <span className="sc-offers__final">
                        <Icon name="i-check" size="sm" />
                        Final rate {formatRate(o.rate_cents)} · pay{' '}
                        {formatUsd(payForMinutesCents(o.rate_cents, minutes))}
                      </span>
                    )}
                  </span>
                </span>
                <span role="cell">Wave {o.wave}</span>
                <span role="cell">
                  <span className={`sc-badge sc-badge--sm ${b.cls}`}>
                    <Icon name={b.icon} size="sm" />
                    {b.label}
                  </span>
                </span>
                <span className="sc-offers__time" role="cell" title={formatClock(at, tz)}>
                  {b.label} {rel(Date.parse(at), nowMs)}
                  <small>{formatClock(at, tz)}</small>
                </span>
              </div>
            );
          })}
          {offers.length === 0 && (
            <div className="sc-offers__row is-muted" role="row">
              <span className="sc-offers__who" role="cell">
                <span>
                  <span className="sc-offers__name">No offers sent yet</span>
                </span>
              </span>
            </div>
          )}
        </div>
      </section>

      <section className="sc-card" aria-labelledby="c-title">
        <div className="sc-section__head">
          <h2 className="sc-card__title" id="c-title">
            C · Money
          </h2>
          <span className="sc-section__note">
            Authorized, then Captured, then Paid. Each amount says what it is.
          </span>
        </div>
        {awaitingApproval && (
          <Alert
            tone="info"
            icon="i-info"
            title={`Approve the ${holdText} hold to offer this shift`}
          >
            Workers only see the shift once the hold is placed.
            {/* PayPal slot: M2 mounts the SDK v6 button here. The stub button exists only in stub mode, never in a production build. */}
            <span id="paypal-button-container" style={{ display: 'block' }}>
              {process.env.NODE_ENV !== 'production' && me.config.payments_mode === 'stub' && (
                <button
                  className="sc-paypal__slot"
                  type="button"
                  data-testid="stub-approve"
                  aria-disabled={busy === 'approve'}
                  aria-busy={busy === 'approve'}
                  onClick={onStubApprove}
                >
                  {busy === 'approve'
                    ? 'Waiting for PayPal…'
                    : 'Test mode: approve hold without PayPal'}
                </button>
              )}
            </span>
          </Alert>
        )}
        <div className="sc-pass">
          {money.map((m, i) => (
            <div className={`sc-pass__item sc-pass__item--${m.tone} ${m.st}`} key={m.label}>
              <div className="sc-pass__top">
                <span className="sc-pass__node">
                  <Icon name={m.icon} />
                </span>
                <span
                  className={`sc-pass__line ${i === money.length - 1 ? 'sc-visually-hidden' : ''}`}
                />
              </div>
              <div>
                <div className="sc-pass__head">
                  {m.label}
                  <span className="sc-pass__tag">{m.tag}</span>
                </div>
                <div className="sc-pass__amt">{m.amt}</div>
              </div>
              <p className="sc-pass__text">{m.text}</p>
              <span className="sc-pass__when">{m.when}</span>
              <div className="sc-pass__refs">
                {[
                  ...(m.tone === 'authorized'
                    ? [...ref('Order', refs?.order), ...ref('Auth', refs?.authorization)]
                    : []),
                  ...(m.tone === 'captured' ? ref('Capture', refs?.capture) : []),
                  ...(m.tone === 'paid' ? ref('Payout', refs?.payout) : []),
                ].map((r) => (
                  <button
                    className="sc-ref"
                    key={r.label}
                    onClick={() => copy(r.value)}
                    aria-label={`Copy ${r.label} reference`}
                  >
                    <small>{r.label}</small>
                    {r.value}
                    <Icon name="i-copy" size="sm" />
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
        {(payment?.status === 'capture_declined' || payment?.status === 'payout_failed') && (
          <Alert
            tone="error"
            icon="i-warn"
            role="alert"
            title={
              payment.status === 'capture_declined'
                ? `PayPal declined the charge of ${formatUsd(payment.worker_pay_cents + payment.platform_fee_cents)}`
                : `The payout to ${workerName ?? 'the worker'} failed`
            }
          >
            {payment.status === 'capture_declined'
              ? `${first || 'The worker'}’s pay is waiting. Check your PayPal account, then retry the charge.`
              : `You were charged ${formatUsd(payment.captured_cents)} and the money is safe. Retry the payout; if it fails again, copy the reference and contact support.`}
            <span className="sc-actions">
              <Button
                variant="secondary"
                size="md"
                onClick={() =>
                  copy((payment.status === 'capture_declined' ? refs?.capture : refs?.payout) ?? '')
                }
              >
                <Icon name="i-copy" size="sm" />
                Copy reference for support
              </Button>
            </span>
          </Alert>
        )}
      </section>
    </div>
  );
}

function moneyRows(
  p: Payment | null,
  slot: Slot,
  x: { holdText: string; first: string; tz: string; workerPay: number | null },
) {
  const s = p?.status ?? 'none';
  const who = x.first || 'the worker';
  const row = (
    tone: string,
    st: PassState,
    icon: string,
    label: string,
    tag: string,
    amt: string,
    text: string,
    when = '',
  ) => ({ tone, st, icon, label, tag, amt, text, when });
  const dash = '$–';

  const auth = (() => {
    if (s === 'none' || s === 'awaiting_approval')
      return row(
        'authorized',
        'is-next',
        'i-shield',
        'Authorized',
        'Waiting for you',
        x.holdText,
        'Approve the hold to start offering. Nothing is charged until you approve hours.',
      );
    if (s === 'voided')
      return row(
        'authorized',
        'is-released',
        'i-shield',
        'Authorized',
        'Released',
        x.holdText,
        slot.status === 'cancelled'
          ? 'You cancelled the gap. The hold was released and nothing was charged.'
          : 'The hold was released because nobody claimed the shift. Nothing was charged.',
      );
    if (s === 'authorized') {
      const filled = slot.status !== 'offering';
      return row(
        'authorized',
        filled ? 'is-done' : 'is-now',
        'i-shield',
        'Authorized',
        filled ? 'Held' : 'On hold',
        x.holdText,
        filled && slot.offered_rate_cents !== null
          ? `Held at ${x.holdText}. ${x.first || 'The worker'} claimed at ${formatRate(slot.offered_rate_cents)}, so the final charge will be lower than the hold; the rest is released.`
          : 'Held on your PayPal. Nothing has been charged. This is the most the shift can cost.',
      );
    }
    return row(
      'authorized',
      'is-done',
      'i-shield',
      'Authorized',
      'Held',
      x.holdText,
      `The hold was placed at ${x.holdText}.`,
    );
  })();

  const capturedAmt = p ? formatUsd(p.captured_cents) : dash;
  const captured = (() => {
    if (s === 'voided')
      return row(
        'captured',
        'is-skipped',
        'i-banknote',
        'Captured',
        'Not applicable',
        '$0.00',
        'No one worked the shift, so there is nothing to charge.',
      );
    if (s === 'capture_declined')
      return row(
        'captured',
        'is-failed',
        'i-warn',
        'Captured',
        'Declined',
        p ? formatUsd(p.worker_pay_cents + p.platform_fee_cents) : dash,
        `PayPal declined this charge. ${who === 'the worker' ? 'The worker' : who} hasn’t been paid yet.`,
      );
    if (s === 'captured' || s === 'payout_pending' || s === 'paid' || s === 'payout_failed')
      return row(
        'captured',
        'is-done',
        'i-banknote',
        'Captured',
        'Charged',
        capturedAmt,
        'You were charged for the hours worked. The unused hold was released.',
      );
    if (slot.status === 'pending_approval')
      return row(
        'captured',
        'is-next',
        'i-banknote',
        'Captured',
        'Waiting for you',
        dash,
        `Charged when you approve ${who}’s hours.`,
      );
    return row(
      'captured',
      'is-next',
      'i-banknote',
      'Captured',
      'Up next',
      dash,
      'Charged only after you approve the hours worked, and never more than the hold.',
    );
  })();

  const paid = (() => {
    if (s === 'voided')
      return row(
        'paid',
        'is-skipped',
        'i-wallet',
        'Paid',
        'Not applicable',
        '$0.00',
        'No payout is needed.',
      );
    if (s === 'payout_failed')
      return row(
        'paid',
        'is-failed',
        'i-warn',
        'Paid',
        'Payout failed',
        p ? formatUsd(p.worker_pay_cents) : dash,
        `PayPal couldn’t send this to ${x.first || 'the worker'}. They haven’t been paid yet.`,
      );
    if (s === 'paid')
      return row(
        'paid',
        'is-done',
        'i-wallet',
        'Paid',
        'Paid',
        p ? formatUsd(p.worker_pay_cents) : dash,
        `${who === 'the worker' ? 'The worker was' : who + ' was'} paid.`,
      );
    if (s === 'capture_declined')
      return row(
        'paid',
        'is-next',
        'i-wallet',
        'Paid',
        'Waiting',
        dash,
        `${who === 'the worker' ? 'The worker is' : who + ' is'} paid once the charge goes through.`,
      );
    return row(
      'paid',
      'is-next',
      'i-wallet',
      'Paid',
      'Up next',
      dash,
      x.workerPay !== null && slot.status !== 'offering'
        ? `${who === 'the worker' ? 'The worker is' : who + ' is'} paid ${formatUsd(x.workerPay)} right after you approve.`
        : 'Sent to the worker’s PayPal right after you approve their hours.',
    );
  })();
  return [auth, captured, paid];
}
