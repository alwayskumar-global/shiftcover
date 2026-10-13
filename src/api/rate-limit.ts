/** Small in-memory fixed-window limiter (single Render web instance). Token and claim endpoints use it. */
export interface RateLimiter {
  /** Returns false when the caller exceeded `max` hits in `windowMs`. */
  hit(key: string, max: number, windowMs: number): boolean;
}

export function createRateLimiter(now: () => number = Date.now): RateLimiter {
  const buckets = new Map<string, { start: number; count: number }>();
  return {
    hit(key, max, windowMs) {
      const t = now();
      const b = buckets.get(key);
      if (!b || t - b.start >= windowMs) {
        buckets.set(key, { start: t, count: 1 });
        if (buckets.size > 10_000)
          for (const [k, v] of buckets) if (t - v.start >= windowMs) buckets.delete(k);
        return true;
      }
      b.count += 1;
      return b.count <= max;
    },
  };
}

export function clientIp(headers: Headers): string {
  return (
    headers.get('x-forwarded-for')?.split(',')[0]?.trim() || headers.get('x-real-ip') || 'unknown'
  );
}
