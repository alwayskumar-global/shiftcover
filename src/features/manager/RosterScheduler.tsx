'use client';

import '@bryntum/scheduler/scheduler.css';
import '@bryntum/scheduler/svalbard-light.css';
import '@/styles/bryntum-theme.css';
import { useMemo } from 'react';
import type { DomClassList } from '@bryntum/scheduler';
import { BryntumScheduler } from '@bryntum/scheduler-react';
import { wallClockDate } from '@/lib/time';
import { formatClock } from '@/ui/format';
import type { RosterResponse } from '@/api/dto';
import { Icon } from '@/ui/icon';
import { STATUS, toSchedulerData, type SchedulerEvent } from './roster-model';

/**
 * The roster as a real Bryntum Scheduler (trial package), themed by design/g1/bryntum-theme.css.
 * Bryntum owns position and size; we only attach status classes and render icon + title + subtitle.
 * Everything is shown on VENUE time (wall-clock Dates), and "now" comes from the server clock.
 */
const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

function DayScheduler({
  data,
  mode,
  selectedId,
  onSelect,
  onOpenGap,
}: {
  data: RosterResponse;
  mode: 'day' | 'week';
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onOpenGap: (id: string) => void;
}) {
  const compact = false; // the week view is the design's own grid (WeekGrid below), not a time axis
  const model = useMemo(() => toSchedulerData(data, compact), [data, compact]);
  const tz = data.timezone;
  const byId = useMemo(() => new Map(model.events.map((e) => [e.id, e])), [model]);

  const range = useMemo(() => {
    const [y, m, d] = data.date.split('-').map(Number) as [number, number, number];
    if (mode === 'day') return { start: new Date(y, m - 1, d, 5), end: new Date(y, m - 1, d, 23) };
    const [ey, em, ed] = data.end_date.split('-').map(Number) as [number, number, number];
    return { start: new Date(y, m - 1, d), end: new Date(ey, em - 1, ed + 1) };
  }, [data.date, data.end_date, mode]);

  const nowRange = useMemo(
    () => [
      {
        id: 'now',
        startDate: wallClockDate(data.server_time, tz),
        duration: 0,
        name: `Now ${formatClock(data.server_time, tz)}`,
        cls: 'b-sch-current-time',
      },
    ],
    [data.server_time, tz],
  );

  const columns = useMemo(
    () => [
      {
        text: `Team ${model.resources.length}`,
        field: 'name',
        width: 232,
        htmlEncode: false,
        renderer: ({
          record,
        }: {
          record: { name: string; role: string; initials: string; tint: number };
        }) =>
          `<div class="sc-sched__res"><span class="sc-avatar sc-avatar--${record.tint}" aria-hidden="true">${esc(record.initials)}</span>` +
          `<span class="sc-sched__res-text"><span class="sc-sched__res-name">${esc(record.name)}</span>` +
          `<span class="sc-sched__res-role">${esc(record.role)}</span></span></div>`,
      },
    ],
    [model.resources.length],
  );

  return (
    <BryntumScheduler
      cls="sc-roster"
      readOnly
      autoHeight
      resources={model.resources}
      events={model.events}
      timeRanges={nowRange}
      columns={columns}
      startDate={range.start}
      endDate={range.end}
      viewPreset={mode === 'day' ? 'hourAndDay' : 'dayAndWeek'}
      rowHeight={64}
      barMargin={10}
      eventStyle={null as unknown as undefined}
      eventColor={null as unknown as undefined}
      multiEventSelect={false}
      stripeFeature
      eventTooltipFeature={false}
      timeRangesFeature={{ showCurrentTimeLine: false }}
      eventRenderer={({ eventRecord, renderData }) => {
        const ev = byId.get(String(eventRecord.id)) as SchedulerEvent | undefined;
        if (!ev) return '';
        const st = STATUS[ev.status];
        const cls = renderData.cls as DomClassList;
        cls.add('sc-ev', st.cls);
        if (compact) cls.add('sc-ev--compact');
        if (ev.id === selectedId) cls.add('is-selected');
        return (
          `<svg class="sc-icon sc-icon--sm" viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#${st.icon}"></use></svg>` +
          `<span class="sc-ev__text"><span class="sc-ev__title">${esc(ev.title)}</span><span class="sc-ev__sub">${esc(ev.sub)}</span></span>`
        );
      }}
      onEventClick={({ eventRecord }: { eventRecord: { id: string | number } }) => {
        const ev = byId.get(String(eventRecord.id));
        if (!ev) return;
        if (ev.hasGapPage) onOpenGap(ev.id);
        else onSelect(ev.id === selectedId ? null : ev.id);
      }}
    />
  );
}

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dayLabel = (iso: string, o: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...o }).format(new Date(`${iso}T12:00:00Z`));
const addDay = (iso: string, n: number) => {
  const t = new Date(`${iso}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

/**
 * Week view as designed (design/g1 M2-roster, "week view"): one column per day, one cell per worker and day, each shift a
 * full-width block (time range plus status icon). A plain grid, so blocks never shrink with the shift's length the way a
 * time axis would squeeze them.
 */
function WeekGrid({
  data,
  selectedId,
  onSelect,
  onOpenGap,
}: {
  data: RosterResponse;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onOpenGap: (id: string) => void;
}) {
  const tz = data.timezone;
  const model = useMemo(() => toSchedulerData(data, true), [data]);
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(data.server_time));
  const days = useMemo(() => {
    const out: string[] = [];
    for (let d = data.date; d <= data.end_date && out.length < 7; d = addDay(d, 1)) out.push(d);
    return out;
  }, [data.date, data.end_date]);
  const cells = useMemo(() => {
    const m = new Map<string, SchedulerEvent[]>();
    for (const e of model.events) {
      const k = `${e.resourceId}|${ymd(e.startDate)}`;
      m.set(k, [...(m.get(k) ?? []), e]);
    }
    return m;
  }, [model.events]);
  const label = `Roster for the week of ${dayLabel(data.date, { month: 'long', day: 'numeric' })}`;

  return (
    <div style={{ overflowX: 'auto' }}>
      <div
        className="sc-sched sc-sched--week"
        role="grid"
        aria-label={label}
        style={{ minWidth: 960 }}
      >
        <div className="sc-sched__head" role="row">
          <div className="sc-sched__corner" role="columnheader">
            Team <span className="sc-text-muted">{model.resources.length}</span>
          </div>
          {days.map((d) => (
            <div
              className={`sc-sched__day ${d === today ? 'is-today' : ''}`}
              role="columnheader"
              key={d}
            >
              <span>
                {dayLabel(d, { weekday: 'short' })}
                {d === today ? ' · Today' : ''}
              </span>
              <small>{dayLabel(d, { month: 'short', day: 'numeric' })}</small>
            </div>
          ))}
        </div>
        <div className="sc-sched__body">
          {model.resources.map((r) => (
            <div
              className={`sc-sched__row ${r.cls ? 'sc-sched__row--gap' : ''}`}
              role="row"
              key={r.id}
            >
              <div className="sc-sched__res" role="rowheader">
                <span className={`sc-avatar sc-avatar--${r.tint}`} aria-hidden="true">
                  {r.initials}
                </span>
                <span className="sc-sched__res-text">
                  <span className="sc-sched__res-name">{r.name}</span>
                  <span className="sc-sched__res-role">{r.role}</span>
                  {model.gapRows.has(r.id) && (
                    <span className="sc-sched__res-flag">
                      <Icon name="i-alert" size="sm" />
                      Shift needs cover
                    </span>
                  )}
                </span>
              </div>
              {days.map((d) => (
                <div
                  className={`sc-sched__cell ${d === today ? 'is-today' : ''}`}
                  role="gridcell"
                  key={d}
                >
                  {(cells.get(`${r.id}|${d}`) ?? []).map((ev) => {
                    const st = STATUS[ev.status];
                    return (
                      <button
                        type="button"
                        key={ev.id}
                        className={`sc-ev sc-ev--compact ${st.cls} ${ev.id === selectedId ? 'is-selected' : ''}`}
                        title={ev.tip}
                        aria-pressed={ev.id === selectedId}
                        onClick={() => {
                          if (ev.hasGapPage) onOpenGap(ev.id);
                          else onSelect(ev.id === selectedId ? null : ev.id);
                        }}
                      >
                        <Icon name={st.icon} size="sm" />
                        <span className="sc-ev__text">
                          <span className="sc-ev__title">{ev.sub}</span>
                          <span className="sc-ev__sub">{ev.name}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function RosterScheduler(props: {
  data: RosterResponse;
  mode: 'day' | 'week';
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onOpenGap: (id: string) => void;
}) {
  return props.mode === 'week' ? (
    <WeekGrid
      data={props.data}
      selectedId={props.selectedId}
      onSelect={props.onSelect}
      onOpenGap={props.onOpenGap}
    />
  ) : (
    <DayScheduler {...props} />
  );
}
