import type { RosterResponse, SlotDto } from '@/api/dto';
import { ROLE_LABELS } from '@/domain/roles';
import { wallClockDate } from '@/lib/time';
import { formatTimeRange, formatTimeRangeCompact } from '@/ui/format';

/** Slot status -> design status key, icon and label (design/g1 bryntum-theme STATUS table). */
export const STATUS = {
  planned: {
    key: 'planned',
    cls: 'sc-ev--planned',
    icon: 'i-calendar',
    label: 'Planned',
    dashed: false,
  },
  open: { key: 'open', cls: 'sc-ev--open', icon: 'i-alert', label: 'Open gap', dashed: false },
  offering: {
    key: 'offering',
    cls: 'sc-ev--offering',
    icon: 'i-send',
    label: 'Offering',
    dashed: false,
  },
  confirmed: {
    key: 'confirmed',
    cls: 'sc-ev--confirmed',
    icon: 'i-check',
    label: 'Confirmed',
    dashed: false,
  },
  in_progress: {
    key: 'progress',
    cls: 'sc-ev--progress',
    icon: 'i-play',
    label: 'In progress',
    dashed: false,
  },
  pending_approval: {
    key: 'pending',
    cls: 'sc-ev--pending',
    icon: 'i-hourglass',
    label: 'Pending approval',
    dashed: false,
  },
  settling: {
    key: 'pending',
    cls: 'sc-ev--pending',
    icon: 'i-hourglass',
    label: 'Settling',
    dashed: false,
  },
  settled: {
    key: 'settled',
    cls: 'sc-ev--settled',
    icon: 'i-checks',
    label: 'Settled',
    dashed: false,
  },
  unfilled: {
    key: 'unfilled',
    cls: 'sc-ev--unfilled',
    icon: 'i-warn',
    label: 'Unfilled',
    dashed: true,
  },
  cancelled: {
    key: 'cancelled',
    cls: 'sc-ev--cancelled',
    icon: 'i-ban',
    label: 'Cancelled',
    dashed: true,
  },
  no_show: {
    key: 'noshow',
    cls: 'sc-ev--noshow',
    icon: 'i-user-x',
    label: 'No-show',
    dashed: false,
  },
} as const satisfies Record<SlotDto['status'], unknown>;

/** The 10 legend entries, in the design's order. */
export const LEGEND = [
  STATUS.planned,
  STATUS.open,
  STATUS.offering,
  STATUS.confirmed,
  STATUS.in_progress,
  STATUS.pending_approval,
  STATUS.settled,
  STATUS.unfilled,
  STATUS.cancelled,
  STATUS.no_show,
];

export const OPEN_ROW_ID = 'open-shifts';
/** Planned shifts nobody is assigned to yet: a neutral row, not a gap. */
export const UNASSIGNED_ROW_ID = 'unassigned-shifts';

export interface SchedulerResource {
  id: string;
  name: string;
  role: string;
  initials: string;
  tint: number;
  cls: string;
}

export interface SchedulerEvent {
  id: string;
  resourceId: string;
  startDate: Date;
  endDate: Date;
  name: string;
  status: SlotDto['status'];
  title: string;
  sub: string;
  tip: string;
  /** True for slots that have a gap lifecycle page (open, offering, unfilled). */
  hasGapPage: boolean;
}

const eventTitle = (s: SlotDto) =>
  s.status === 'planned'
    ? ROLE_LABELS[s.role]
    : s.status === 'offering'
      ? `Offering \u00b7 Wave ${s.current_wave ?? 1}`
      : STATUS[s.status].label;

/**
 * Roster API -> Bryntum resources and events.
 * - A gap sits on the row of the worker it replaces (design: "Shift needs cover"), and that row is highlighted.
 *   Gaps with no replaced worker go on a synthetic "Open shifts" row, which only exists when needed.
 * - The cancelled original shift of a replaced worker is hidden behind its gap (same worker, same times).
 */
export function toSchedulerData(r: RosterResponse, compact: boolean) {
  const tz = r.timezone;
  const gapKeys = new Set(
    r.events
      .filter((e) => e.replaces_worker)
      .map((e) => `${e.replaces_worker!.id}|${e.start_at}|${e.end_at}`),
  );
  const events: SchedulerEvent[] = [];
  for (const s of r.events) {
    if (
      s.status === 'cancelled' &&
      s.worker &&
      gapKeys.has(`${s.worker.id}|${s.start_at}|${s.end_at}`)
    )
      continue;
    const gapLike = ['open', 'offering', 'unfilled'].includes(s.status);
    const resourceId =
      s.worker?.id ?? s.replaces_worker?.id ?? (gapLike ? OPEN_ROW_ID : UNASSIGNED_ROW_ID);
    const full = formatTimeRange(s.start_at, s.end_at, tz);
    const compactRange = formatTimeRangeCompact(s.start_at, s.end_at, tz);
    events.push({
      id: s.id,
      resourceId,
      startDate: wallClockDate(s.start_at, tz),
      endDate: wallClockDate(s.end_at, tz),
      name: ROLE_LABELS[s.role],
      status: s.status,
      title: eventTitle(s),
      sub: compact
        ? compactRange
        : s.status === 'planned'
          ? full
          : `${ROLE_LABELS[s.role]} · ${full}`,
      tip: `${STATUS[s.status].label} · ${ROLE_LABELS[s.role]} · ${full}${s.worker ? ` · ${s.worker.name}` : ''}`,
      hasGapPage: ['open', 'offering', 'unfilled'].includes(s.status),
    });
  }
  const gapRows = new Set(events.filter((e) => e.status === 'open').map((e) => e.resourceId));
  const resources: SchedulerResource[] = r.resources.map((w) => ({
    id: w.id,
    name: w.name,
    role: ROLE_LABELS[w.role],
    initials: w.initials,
    tint: w.avatar_tint,
    cls: gapRows.has(w.id) ? 'sc-row--gap' : '',
  }));
  if (events.some((e) => e.resourceId === UNASSIGNED_ROW_ID)) {
    resources.unshift({
      id: UNASSIGNED_ROW_ID,
      name: 'Unassigned',
      role: 'Planned, no one yet',
      initials: '?',
      tint: 5,
      cls: '',
    });
  }
  if (events.some((e) => e.resourceId === OPEN_ROW_ID)) {
    resources.unshift({
      id: OPEN_ROW_ID,
      name: 'Open shifts',
      role: 'Needs cover',
      initials: '!',
      tint: 1,
      cls: 'sc-row--gap',
    });
  }
  return { resources, events, gapRows };
}

/** Header tiles. open/offering come from the API summary; pending and shifts are derived from the displayed range. */
export function tileCounts(r: RosterResponse) {
  const live = r.events.filter((e) => e.status !== 'cancelled');
  const unassigned = live.filter((e) => e.status === 'planned' && !e.worker).length;
  return {
    open: r.summary.open_gaps,
    offering: r.summary.offering,
    pending: live.filter((e) => e.status === 'pending_approval').length,
    /** Shifts that have someone on them; planned shifts nobody is assigned to are counted separately. */
    shifts: live.length - unassigned,
    unassigned,
  };
}
