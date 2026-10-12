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

export default function RosterScheduler({
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
  const compact = mode === 'week';
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
