'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { RosterResponse } from '@/api/dto';
import { fetchRoster } from '@/features/client-api';
import { addDays, usePolling } from './use-polling';
import { LEGEND, tileCounts } from './roster-model';
import { Badge, Button, Skeleton } from '@/ui/primitives';
import { Icon } from '@/ui/icon';
import { useMe } from './me-context';

// Bryntum is client-only (its trial bundle touches window/document at import time).
const RosterScheduler = dynamic(() => import('./RosterScheduler'), {
  ssr: false,
  loading: () => <SchedulerSkeleton />,
});

type Mode = 'day' | 'week';

/** M2 roster (design/g1: M2-roster): summary tiles, legend, date navigation, Day/Week, themed Scheduler. */
export function RosterScreen() {
  const router = useRouter();
  const me = useMe();
  const [mode, setMode] = useState<Mode>('day');
  const [date, setDate] = useState<string | undefined>(undefined); // undefined = the venue's today
  const [data, setData] = useState<RosterResponse | null>(null);
  const [error, setError] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const requestKey = useRef('');

  const key = `${date ?? 'today'}|${mode}`;
  const load = useCallback(async () => {
    requestKey.current = key;
    try {
      const r = await fetchRoster(date, mode === 'week' ? 7 : 1);
      if (requestKey.current !== key) return; // a newer navigation superseded this request
      setData(r);
      setError(false);
    } catch {
      if (requestKey.current === key) setError(true);
    }
  }, [date, mode, key]);

  // Live feel: poll every 3 s while the tab is visible (plain setInterval; no extra dependency).
  usePolling(load, 3000);

  const tiles = data ? tileCounts(data) : null;
  const loading = !data && !error;
  const todayStr = useMemo(() => {
    if (!data) return undefined;
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: data.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(data.server_time));
  }, [data]);

  const first = data?.date;
  const isToday =
    !!data &&
    !!todayStr &&
    (mode === 'day' ? first === todayStr : first! <= todayStr && todayStr <= data.end_date);
  const step = mode === 'day' ? 1 : 7;
  const dateLabel = data ? rangeLabel(data, mode) : '';
  const sub = data ? `${subtitle(data, mode, isToday)} \u00b7 ${me.venue.name}` : '\u00a0';
  const noGaps =
    !!tiles && tiles.open + tiles.offering === 0 && !!todayStr && data!.end_date >= todayStr;

  function go(delta: number) {
    if (!data) return;
    setData(null);
    setSel(null);
    setDate(addDays(data.date, delta));
  }

  return (
    <div className="sc-page">
      <header className="sc-page__head">
        <div>
          <h1 className="sc-page__title">Roster</h1>
          <p className="sc-page__sub">{sub}</p>
        </div>
        <div className="sc-toolbar">
          <div className="sc-toolbar__group">
            <Button
              variant="secondary"
              size="md"
              onClick={() => {
                setData(null);
                setDate(undefined);
              }}
            >
              Today
            </Button>
            <Button
              variant="secondary"
              size="md"
              className="sc-btn--icon"
              aria-label={mode === 'day' ? 'Previous day' : 'Previous week'}
              onClick={() => go(-step)}
            >
              <Icon name="i-chev-left" />
            </Button>
            <span className="sc-toolbar__date" aria-live="polite">
              {dateLabel}
            </span>
            <Button
              variant="secondary"
              size="md"
              className="sc-btn--icon"
              aria-label={mode === 'day' ? 'Next day' : 'Next week'}
              onClick={() => go(step)}
            >
              <Icon name="i-chev" />
            </Button>
          </div>
          <div className="sc-segmented" role="group" aria-label="View">
            <button
              className="sc-segmented__btn"
              aria-pressed={mode === 'day'}
              onClick={() => {
                setData(null);
                setMode('day');
              }}
            >
              Day
            </button>
            <button
              className="sc-segmented__btn"
              aria-pressed={mode === 'week'}
              onClick={() => {
                setData(null);
                setMode('week');
              }}
            >
              Week
            </button>
          </div>
          <Link className="sc-btn sc-btn--primary sc-btn--md" href="/app/gaps/new">
            <Icon name="i-plus" size="sm" />
            Report a gap
          </Link>
        </div>
      </header>

      <section className="sc-stats" aria-label="Summary">
        {loading
          ? [1, 2, 3, 4].map((k) => (
              <div className="sc-stat" aria-hidden="true" key={k}>
                <Skeleton variant="stat" />
              </div>
            ))
          : [
              {
                cls: 'sc-stat--open',
                icon: 'i-alert',
                n: tiles?.open,
                label: tiles?.open === 1 ? 'open gap' : 'open gaps',
                alert: (tiles?.open ?? 0) > 0,
              },
              {
                cls: 'sc-stat--offering',
                icon: 'i-send',
                n: tiles?.offering,
                label: 'offering',
                alert: (tiles?.offering ?? 0) > 0,
              },
              {
                cls: 'sc-stat--pending',
                icon: 'i-hourglass',
                n: tiles?.pending,
                label: 'pending approval',
                alert: (tiles?.pending ?? 0) > 0,
              },
              {
                cls: 'sc-stat--shifts',
                icon: 'i-calendar',
                n: tiles?.shifts,
                label: `shifts ${mode === 'day' ? (isToday ? 'today' : 'this day') : 'this week'}`,
                alert: false,
              },
            ].map((t) => (
              <div className={`sc-stat ${t.cls} ${t.alert ? 'is-alert' : ''}`} key={t.cls}>
                <span className="sc-stat__icon">
                  <Icon name={t.icon} />
                </span>
                <span>
                  <span className="sc-stat__value">{error ? '–' : (t.n ?? '–')}</span>
                  <span className="sc-stat__label"> {t.label}</span>
                </span>
              </div>
            ))}
      </section>

      {noGaps && !error && (
        <div className="sc-banner" role="status">
          <Icon name="i-checks" size="xl" />
          <div>
            <span className="sc-banner__title">
              {mode === 'day'
                ? isToday
                  ? 'No gaps today'
                  : 'No gaps on this day'
                : 'No gaps this week'}
            </span>
            <span className="sc-banner__text">
              All {tiles!.shifts} shifts have someone on them. If someone calls in, report it and
              we&apos;ll start offering the shift.
            </span>
          </div>
        </div>
      )}

      <div className="sc-legend" role="group" aria-label="Shift status legend">
        <span className="sc-legend__title">Status</span>
        {LEGEND.map((l) => (
          <Badge
            key={l.key}
            tone={`st-${l.key}${l.dashed ? ' sc-badge--dashed' : ''}`}
            icon={l.icon}
            small
          >
            {l.label}
          </Badge>
        ))}
      </div>

      {error && (
        <div className="sc-panel" role="alert">
          <span className="sc-panel__icon">
            <Icon name="i-wifi-off" size="xl" />
          </span>
          <h2 className="sc-panel__title">We couldn&apos;t load the roster</h2>
          <p className="sc-panel__text">
            Check your connection and try again. Your shifts haven&apos;t changed; only the display
            failed.
          </p>
          <Button
            variant="secondary"
            size="md"
            onClick={() => {
              setError(false);
              void load();
            }}
          >
            <Icon name="i-retry" size="sm" />
            Try again
          </Button>
        </div>
      )}
      {loading && <SchedulerSkeleton />}
      {data && !error && (
        <RosterScheduler
          data={data}
          mode={mode}
          selectedId={sel}
          onSelect={setSel}
          onOpenGap={(id) => router.push(`/app/gaps/${id}`)}
        />
      )}
    </div>
  );
}

function SchedulerSkeleton() {
  return (
    <div className="sc-sched" aria-busy="true" aria-label="Loading roster">
      <div className="sc-sched__head">
        <div className="sc-sched__corner">Team</div>
      </div>
      <div className="sc-sched__body">
        {Array.from({ length: 10 }, (_, i) => (
          <div className="sc-sched__row" aria-hidden="true" key={i}>
            <div className="sc-sched__res">
              <Skeleton variant="avatar" />
              <span>
                <Skeleton variant="name" />
                <Skeleton variant="role" />
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const fmt = (iso: string, tz: string, o: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('en-US', { timeZone: tz, ...o }).format(new Date(`${iso}T12:00:00Z`));

function rangeLabel(d: RosterResponse, mode: Mode) {
  if (mode === 'day')
    return fmt(d.date, 'UTC', { weekday: 'short', month: 'short', day: 'numeric' });
  const a = fmt(d.date, 'UTC', { month: 'short', day: 'numeric' });
  const sameMonth = d.date.slice(0, 7) === d.end_date.slice(0, 7);
  return sameMonth
    ? `${a} – ${Number(d.end_date.slice(8))}`
    : `${a} – ${fmt(d.end_date, 'UTC', { month: 'short', day: 'numeric' })}`;
}

function subtitle(d: RosterResponse, mode: Mode, isToday: boolean) {
  return mode === 'day'
    ? `${fmt(d.date, 'UTC', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}${isToday ? ' · Today' : ''}`
    : `Week of ${fmt(d.date, 'UTC', { month: 'long', day: 'numeric', year: 'numeric' })}`;
}
