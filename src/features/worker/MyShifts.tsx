'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ROLE_LABELS } from '@/domain/roles';
import {
  ApiFailure,
  NetworkFailure,
  arriveShift,
  fetchWorkerShifts,
  finishShift,
  type WorkerShiftsDto,
} from '@/features/client-api';
import { usePolling } from '@/features/manager/use-polling';
import { Badge, Button, Skeleton } from '@/ui/primitives';
import { Icon } from '@/ui/icon';
import {
  dayLabel,
  formatClock,
  formatHours,
  formatRate,
  formatTimeRange,
  formatUsd,
} from '@/ui/format';
import { buildViews, type Section, type ShiftView } from './my-shifts-model';
import { WorkerTabbar } from './WorkerTabbar';

/** G2-W3 My shifts (design/g2). Reads GET /api/w/shifts with the worker session cookie; arrive and finish POST to the shift. */

const CACHE_KEY = 'sc-my-shifts';
type Phase = 'loading' | 'ready' | 'error' | 'signedOut';

const TITLES: Record<Section, string> = {
  active: 'Active now',
  upcoming: 'Upcoming',
  past: 'Past · last 14 days',
};

function readCache(): { savedAt: string; data: WorkerShiftsDto } | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as { savedAt: string; data: WorkerShiftsDto }) : null;
  } catch {
    return null;
  }
}

export function MyShifts() {
  const [data, setData] = useState<WorkerShiftsDto | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [offlineAt, setOfflineAt] = useState<string | null>(null);
  const [busy, setBusy] = useState<{ id: string; kind: 'arrive' | 'finish' } | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [toast, setToast] = useState('');
  const lock = useRef(false);
  const say = (t: string) => setToast(t);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(''), 3200);
    return () => clearTimeout(id);
  }, [toast]);

  const load = useCallback(async () => {
    try {
      const d = await fetchWorkerShifts();
      setData(d);
      setOfflineAt(null);
      setPhase('ready');
      try {
        localStorage.setItem(
          CACHE_KEY,
          JSON.stringify({ savedAt: new Date().toISOString(), data: d }),
        );
      } catch {
        // storage unavailable: the list still shows
      }
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 401) {
        setPhase('signedOut');
        return;
      }
      const cached = e instanceof NetworkFailure ? readCache() : null;
      if (cached) {
        setData(cached.data);
        setOfflineAt(cached.savedAt);
        setPhase('ready');
      } else {
        setPhase((p) => (p === 'ready' && data ? 'ready' : 'error'));
      }
    }
  }, [data]);

  usePolling(load, 10_000);
  useEffect(() => {
    const on = () => void load();
    window.addEventListener('online', on);
    return () => window.removeEventListener('online', on);
  }, [load]);

  const views = useMemo(() => (data ? buildViews(data) : []), [data]);
  const offline = offlineAt !== null;

  const act = useCallback(
    async (v: ShiftView, kind: 'arrive' | 'finish') => {
      if (offline) {
        say("You're offline. Try again when you reconnect.");
        return;
      }
      if (lock.current) return; // the first tap wins; later taps are ignored
      lock.current = true;
      setBusy({ id: v.shift.slot_id, kind });
      setConfirmId(null);
      try {
        await (kind === 'arrive' ? arriveShift(v.shift.slot_id) : finishShift(v.shift.slot_id));
        await load();
      } catch (e) {
        say(
          e instanceof NetworkFailure
            ? "You're offline. Try again when you reconnect."
            : kind === 'arrive'
              ? "We couldn't check you in. Try again."
              : "We couldn't save your finish time. Try again.",
        );
      } finally {
        lock.current = false;
        setBusy(null);
      }
    },
    [offline, load],
  );

  const sections = (['active', 'upcoming', 'past'] as const)
    .map((s) => ({ key: s, items: views.filter((v) => v.section === s) }))
    .filter((s) => s.items.length > 0);
  const isEmpty = phase === 'ready' && views.length === 0;

  return (
    <main className="sc-app" aria-busy={phase === 'loading'}>
      <header className="sc-appbar">
        <h1 className="sc-appbar__title">My shifts</h1>
        <span className="sc-wordmark__mark" aria-hidden="true">
          <Icon name="i-check" />
        </span>
      </header>

      {offline && (
        <div className="sc-offline" role="status">
          <Icon name="i-wifi-off" size="lg" />
          <div>
            <span className="sc-offline__title">You&apos;re offline</span>
            <span className="sc-offline__text">
              Showing shifts saved at{' '}
              {new Date(offlineAt!).toLocaleTimeString('en-US', {
                hour: 'numeric',
                minute: '2-digit',
              })}
              . Check-in and finish are paused until you reconnect.
            </span>
          </div>
        </div>
      )}

      <section className="sc-app__body sc-app__body--grow">
        {phase === 'loading' && (
          <>
            <span className="sc-visually-hidden" role="status">
              Loading your shifts
            </span>
            {[1, 2, 3].map((k) => (
              <div className="sc-shift" aria-hidden="true" key={k}>
                <div className="sc-shift__top">
                  <Skeleton variant="eyebrow" />
                  <Skeleton variant="chip" />
                </div>
                <Skeleton variant="title" />
                <Skeleton variant="line" />
                <Skeleton variant="line-short" />
                <Skeleton variant="amount" />
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
              We couldn&apos;t load your shifts
            </h2>
            <p className="sc-notice__text">
              Check your connection and try again. Your booked shifts haven&apos;t changed.
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
              To see your shifts, open the latest offer link we sent you.
            </p>
          </div>
        )}

        {isEmpty && (
          <div className="sc-notice sc-rise">
            <span className="sc-notice__icon">
              <Icon name="i-calendar" size="xl" />
            </span>
            <h2 className="sc-notice__title">No shifts yet</h2>
            <p className="sc-notice__text">
              When you claim a shift from an offer, it shows up here with your pay and what to do
              next.
            </p>
          </div>
        )}

        {phase === 'ready' &&
          sections.map((sec) => (
            <section className="sc-section" aria-label={TITLES[sec.key]} key={sec.key}>
              <h2 className="sc-section-title">
                {TITLES[sec.key]}
                <small>{sec.items.length}</small>
              </h2>
              {sec.items.map((v) => (
                <ShiftCard
                  key={v.shift.slot_id}
                  v={v}
                  serverTime={data!.server_time}
                  busy={busy?.id === v.shift.slot_id ? busy.kind : null}
                  confirming={confirmId === v.shift.slot_id}
                  offline={offline}
                  // eslint-disable-next-line react-hooks/refs -- the double-tap ref is read only when the button is pressed
                  onArrive={() => void act(v, 'arrive')}
                  onAskFinish={() =>
                    offline
                      ? say("You're offline. Try again when you reconnect.")
                      : setConfirmId(v.shift.slot_id)
                  }
                  onFinish={() => void act(v, 'finish')}
                  onBack={() => setConfirmId(null)}
                />
              ))}
            </section>
          ))}
      </section>

      {toast && (
        <div className="sc-snack-wrap">
          <div className="sc-snack" role="status">
            <Icon name="i-info" />
            {toast}
          </div>
        </div>
      )}

      <WorkerTabbar current="shifts" />
    </main>
  );
}

function ShiftCard({
  v,
  serverTime,
  busy,
  confirming,
  offline,
  onArrive,
  onAskFinish,
  onFinish,
  onBack,
}: {
  v: ShiftView;
  serverTime: string;
  busy: 'arrive' | 'finish' | null;
  confirming: boolean;
  offline: boolean;
  onArrive: () => void;
  onAskFinish: () => void;
  onFinish: () => void;
  onBack: () => void;
}) {
  const s = v.shift;
  const tz = s.venue_tz;
  const active = v.section === 'active';
  const day = dayLabel(s.start_at, serverTime, tz);
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date(s.start_at));
  const dateLabel = day === 'Today' || day === 'Tomorrow' ? `${day} · ${date}` : date;
  const note =
    s.slot_status === 'in_progress' && s.check_in_at
      ? `On shift since ${formatClock(s.check_in_at, tz)}. Tap Finished when you leave.`
      : v.note;
  const rate = s.offered_rate_cents ?? 0;
  const formula =
    v.badge.label === 'Cancelled'
      ? `Shift cancelled by ${s.venue_name}`
      : v.badge.label === 'No-show'
        ? 'Marked as a no-show'
        : `${v.payHours} h × ${formatRate(rate).replace('/hr', '')}/hr${v.formulaSuffix}`;
  const primaryLabel =
    busy === 'arrive'
      ? 'Checking in…'
      : busy === 'finish'
        ? 'Saving…'
        : v.step === 'arrive'
          ? "I've arrived"
          : 'Finished';
  const mapsHref = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(s.venue_address || `${s.venue_name} ${s.venue_area}`)}`;
  return (
    <article
      className={`sc-shift ${active ? 'sc-shift--active' : ''}`}
      aria-labelledby={`${s.slot_id}-t`}
    >
      <div className="sc-shift__top">
        <p className="sc-eyebrow">{dateLabel}</p>
        <Badge tone={v.badge.tone} icon={v.badge.icon}>
          {v.badge.label}
        </Badge>
      </div>
      <h3 className="sc-shift__title" id={`${s.slot_id}-t`}>
        {ROLE_LABELS[s.role]}
      </h3>
      <ul className="sc-ticket__meta">
        <li className="sc-ticket__meta-row">
          <Icon name="i-pin" />
          <span>
            <strong>{s.venue_name}</strong> · {s.venue_area}
          </span>
        </li>
        <li className="sc-ticket__meta-row">
          <Icon name="i-clock" />
          <span>
            {formatTimeRange(s.start_at, s.end_at, tz)} · {formatHours(s.hours)}
          </span>
        </li>
      </ul>
      {active && s.check_in_at && (
        <div className="sc-shift__times">
          <div>
            <span className="sc-eyebrow">Arrived</span>
            <span className="sc-shift__time">{formatClock(s.check_in_at, tz)}</span>
          </div>
          <div>
            <span className="sc-eyebrow">Finished</span>
            <span className="sc-shift__time">
              {s.check_out_at ? formatClock(s.check_out_at, tz) : '–'}
            </span>
          </div>
        </div>
      )}
      <div className="sc-shift__pay">
        <span className="sc-eyebrow">{v.payLabel}</span>
        <span className="sc-shift__amount">{formatUsd(v.amountCents)}</span>
        <span className="sc-shift__formula">{formula}</span>
      </div>
      {note && (
        <p className="sc-shift__note">
          <Icon name="i-info" size="sm" />
          {note}
        </p>
      )}
      {confirming && (
        <div className="sc-shift__confirm" role="alert">
          <p>Finish your shift? We&apos;ll record the time you tap as your finish time.</p>
          <Button variant="primary" block onClick={onFinish}>
            Yes, I&apos;m finished
          </Button>
          <Button variant="quiet" block onClick={onBack}>
            Go back
          </Button>
        </div>
      )}
      {v.step && !confirming && (
        <Button
          variant="primary"
          size="lg"
          block
          busy={busy !== null}
          aria-disabled={offline || busy !== null ? true : undefined}
          onClick={v.step === 'arrive' ? onArrive : onAskFinish}
        >
          {primaryLabel}
        </Button>
      )}
      {v.section === 'upcoming' && (
        <a
          className="sc-btn sc-btn--secondary sc-btn--block"
          href={mapsHref}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open in Maps
          <Icon name="i-arrow-up-right" size="sm" />
        </a>
      )}
    </article>
  );
}
