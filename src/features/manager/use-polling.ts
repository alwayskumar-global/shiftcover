import { useEffect, useRef } from 'react';

/** `YYYY-MM-DD` plus whole days (calendar arithmetic, no time zones involved). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

export const shortWeekday = (date: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' }).format(
    new Date(`${date}T12:00:00Z`),
  );

/**
 * Runs `fn` now and then every `ms` while the tab is visible; pauses when hidden and refreshes on return.
 * A plain interval: Gate 1 needs "feels live", not a push channel.
 */
export function usePolling(fn: () => void | Promise<void>, ms: number) {
  const latest = useRef(fn);
  useEffect(() => {
    latest.current = fn;
  });
  useEffect(() => {
    let id: ReturnType<typeof setInterval> | undefined;
    const tick = () => void latest.current();
    const start = () => {
      if (id === undefined) id = setInterval(tick, ms);
    };
    const stop = () => {
      if (id !== undefined) clearInterval(id);
      id = undefined;
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        tick();
        start();
      } else stop();
    };
    tick();
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [ms, fn]);
}
