import {
  CREATE_GAP_RESPONSE,
  GAP_DETAILS,
  PARSE_RESULT,
  ROSTERS,
  WORKER_OFFERS,
  ME,
  type Scene,
} from './fixtures';
import { localDateString } from '@/lib/time';

/**
 * Replaces window.fetch for one review scene so the real screens render from fixtures with no backend.
 * Returns a restore function. Review harness only.
 */
export function installStubFetch(scene: Scene): () => void {
  const real = window.fetch.bind(window);
  const json = (body: unknown, status = 200) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  const fail = (status: number, code: string) => json({ error: { code, message: code } }, status);
  const r = scene.render;
  let workerState =
    r.kind === 'worker' && r.offer !== 'network-error' ? WORKER_OFFERS[r.offer] : null;

  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      location.origin,
    );
    const path = url.pathname;
    const method = (init?.method ?? 'GET').toUpperCase();
    if (!path.startsWith('/api/')) return real(input, init);

    if (r.kind === 'worker') {
      if (r.offer === 'network-error') return Promise.reject(new TypeError('network'));
      if (path.endsWith('/claim') && workerState) {
        workerState = { ...workerState, state: 'claimed' };
        return json(workerState);
      }
      if (path.endsWith('/decline') && workerState) {
        workerState = { ...workerState, state: 'declined' };
        return json(workerState);
      }
      if (path === '/api/offer-link/resend') return json({ ok: true });
      if (path.startsWith('/api/c/')) return json(workerState);
    }
    if (r.kind === 'login') {
      if (path.startsWith('/api/auth/')) return fail(401, 'invalid_credentials');
    }
    if (path === '/api/manager/me') return json(ME);
    if (r.kind === 'roster' && path === '/api/manager/roster') {
      if (r.roster === 'pending') return new Promise<Response>(() => {});
      if (r.roster === 'error') return fail(500, 'error');
      return json(ROSTERS[r.roster]);
    }
    if (r.kind === 'gap-new') {
      if (path === '/api/manager/gaps/parse')
        return json(PARSE_RESULT(localDateString(new Date(), ME.venue.timezone)));
      if (path === '/api/manager/gaps' && method === 'POST') return json(CREATE_GAP_RESPONSE, 201);
      if (path.endsWith('/stub-authorize')) return json({ payment: CREATE_GAP_RESPONSE.payment });
      if (path.endsWith('/start-offering')) return json({ slot: CREATE_GAP_RESPONSE.slot });
    }
    if (r.kind === 'gap-detail') {
      const d = GAP_DETAILS[r.detail];
      if (path === `/api/manager/gaps/${d.slot.id}` && method === 'GET') return json(d);
      if (path.endsWith('/cancel') || path.endsWith('/widen-radius'))
        return json({ slot: d.slot, reopened: false });
      if (path.endsWith('/stub-authorize')) return json({ payment: d.payment });
      if (path.endsWith('/start-offering')) return json({ slot: d.slot });
    }
    return fail(404, 'not_found');
  }) as typeof fetch;
  return () => {
    window.fetch = real;
  };
}
