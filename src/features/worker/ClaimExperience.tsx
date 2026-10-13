'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkerOfferDto } from '@/api/dto';
import { ROLE_LABELS, type ShiftRole } from '@/domain/roles';
import { Alert, Button, Notice, Skeleton, Wordmark } from '@/ui/primitives';
import { Icon } from '@/ui/icon';
import {
  dayLabel,
  formatCountdown,
  formatHours,
  formatMiles,
  formatRate,
  formatTimeRange,
  formatUsd,
  formatClock,
} from '@/ui/format';
import {
  claimOffer,
  declineOffer,
  fetchOffer,
  NetworkFailure,
  resendLink,
} from '@/features/client-api';

/**
 * W1 claim card and W2 "You're booked." (design/g1: W1-claim-card, W2-claimed).
 * - GET only reads: the token is never consumed by opening the link.
 * - Claim is a POST. The first tap locks the button synchronously, so a double tap sends one request.
 * - Countdown follows the SERVER clock (server_time offset), never the device clock alone.
 * - After the first valid open the token leaves the address bar (history.replaceState) and lives in
 *   sessionStorage so a reload on the clean URL still works.
 */
type View =
  | 'loading'
  | 'available'
  | 'claiming'
  | 'errorClaim'
  | 'claimed'
  | 'booked'
  | 'taken'
  | 'expired'
  | 'withdrawn'
  | 'invalid'
  | 'errorLoad'
  | 'declined';

const STORAGE_KEY = 'sc-offer-token';
const HAND_OFF_MS = 1500;
const URGENT_SECONDS = 120;

function viewFor(state: WorkerOfferDto['state']): View {
  switch (state) {
    case 'available':
      return 'available';
    case 'claimed':
      return 'booked';
    case 'declined':
      return 'declined';
    case 'taken':
    case 'expired':
    case 'withdrawn':
    case 'invalid':
      return state;
  }
}

const roleLabel = (role: WorkerOfferDto['role']) =>
  role ? ROLE_LABELS[role as ShiftRole] : 'Shift';

export function ClaimExperience({ token: urlToken }: { token?: string }) {
  const [view, setView] = useState<View>('loading');
  const [offer, setOffer] = useState<WorkerOfferDto | null>(null);
  const [secs, setSecs] = useState(0);
  const [askSkip, setAskSkip] = useState(false);
  const [email, setEmail] = useState('');
  const [emailInvalid, setEmailInvalid] = useState(false);
  const [linkSent, setLinkSent] = useState(false);
  const token = useRef<string | undefined>(urlToken);
  const offsetMs = useRef(0);
  const locked = useRef(false);
  const handoff = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const headingRef = useRef<HTMLDivElement>(null);

  const apply = useCallback((o: WorkerOfferDto) => {
    setOffer(o);
    if (o.server_time) offsetMs.current = Date.parse(o.server_time) - Date.now();
    if (o.expires_at)
      setSecs(Math.floor((Date.parse(o.expires_at) - (Date.now() + offsetMs.current)) / 1000));
  }, []);

  const load = useCallback(async () => {
    if (!token.current) {
      try {
        token.current = sessionStorage.getItem(STORAGE_KEY) ?? undefined;
      } catch {
        // storage unavailable
      }
    }
    if (!token.current) {
      setOffer(null);
      setView('invalid');
      return;
    }
    try {
      const o = await fetchOffer(token.current);
      apply(o);
      if (o.state !== 'invalid') {
        // Token leaves the address bar once the first valid open has set the session cookie.
        try {
          sessionStorage.setItem(STORAGE_KEY, token.current);
          if (urlToken) window.history.replaceState(null, '', '/c');
        } catch {
          // storage unavailable: the URL keeps the token, which still works
        }
      }
      setView(viewFor(o.state));
    } catch (e) {
      setView(e instanceof NetworkFailure ? 'errorLoad' : 'errorLoad');
    }
  }, [apply, urlToken]);

  useEffect(() => {
    void load();
    return () => {
      if (handoff.current) clearTimeout(handoff.current);
    };
  }, [load]);

  // 1 Hz countdown while the offer is open. aria-live is off on the badge: no per-second announcements.
  useEffect(() => {
    if (!['available', 'claiming', 'errorClaim'].includes(view) || !offer?.expires_at) return;
    const id = setInterval(() => {
      const left = Math.floor(
        (Date.parse(offer.expires_at!) - (Date.now() + offsetMs.current)) / 1000,
      );
      setSecs(left);
      if (left <= 0 && !locked.current) setView('expired');
    }, 1000);
    return () => clearInterval(id);
  }, [view, offer]);

  // Move focus to the heading when a notice or the booked screen appears.
  useEffect(() => {
    if (
      [
        'claimed',
        'booked',
        'taken',
        'expired',
        'withdrawn',
        'invalid',
        'errorLoad',
        'declined',
      ].includes(view)
    ) {
      headingRef.current?.querySelector<HTMLElement>('h1')?.focus();
    }
  }, [view]);

  async function onClaim() {
    if (locked.current || !token.current) return; // set synchronously: later taps are ignored
    locked.current = true;
    setView('claiming');
    try {
      const r = await claimOffer(token.current);
      apply(r);
      if (r.state === 'claimed') {
        setView('claimed');
        handoff.current = setTimeout(() => setView('booked'), HAND_OFF_MS);
      } else {
        setView(viewFor(r.state));
      }
    } catch {
      setView('errorClaim');
    } finally {
      locked.current = false;
    }
  }

  async function onSkipConfirmed() {
    if (!token.current) return;
    setAskSkip(false);
    try {
      const r = await declineOffer(token.current);
      apply(r);
      setView(viewFor(r.state));
    } catch {
      setView('errorClaim');
    }
  }

  async function onSendLink() {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
      setEmailInvalid(true);
      return;
    }
    setEmailInvalid(false);
    try {
      await resendLink(email.trim());
    } catch {
      // identical outcome for the user either way: nothing is revealed
    }
    setLinkSent(true);
  }

  if (view === 'loading') return <Loading />;
  if (view === 'booked') return <Booked offer={offer!} />;

  const tz = offer?.venue_tz ?? 'UTC';
  const urgent = secs <= URGENT_SECONDS;
  const venue = offer?.venue_name ?? 'The venue';

  // ----- offer card: available / rate rising / claiming / claim error -----
  if (view === 'available' || view === 'claiming' || view === 'errorClaim') {
    const o = offer!;
    const rising = (o.first_offered_rate_cents ?? o.rate_cents!) < o.rate_cents!;
    const delta = rising ? (o.rate_cents! - o.first_offered_rate_cents!) * o.hours! : 0;
    const claiming = view === 'claiming';
    return (
      <main className="sc-app" aria-busy={false}>
        <Header />
        <section className="sc-app__body">
          {rising && (
            <div className="sc-rate-banner sc-rate-banner--flash" role="status">
              <Icon name="i-trending-up" />
              <div>
                <span className="sc-rate-banner__title">
                  Rate increased to {formatRate(o.rate_cents!)}
                </span>
                <span className="sc-rate-banner__text">
                  It was {formatRate(o.first_offered_rate_cents!)} when this shift was first
                  offered. That&apos;s {formatUsd(Math.round(delta))} more for the shift.
                </span>
              </div>
            </div>
          )}
          <article className="sc-ticket" aria-labelledby="offer-title">
            <div className="sc-ticket__head">
              <div className="sc-ticket__top">
                <p className="sc-eyebrow">Shift offer</p>
                <span
                  className={`sc-badge sc-badge--timer ${urgent ? 'sc-badge--urgent' : ''}`}
                  role="timer"
                  aria-live="off"
                  aria-label={`${Math.floor(Math.max(secs, 0) / 60)} minutes ${Math.max(secs, 0) % 60} seconds left to claim`}
                >
                  <Icon name={urgent ? 'i-alert' : 'i-clock'} size="sm" />
                  {(urgent ? 'Ending soon · ' : '') + formatCountdown(secs) + ' left'}
                </span>
              </div>
              <h1 className="sc-ticket__title" id="offer-title">
                {roleLabel(o.role)}
              </h1>
              <ul className="sc-ticket__meta">
                <li className="sc-ticket__meta-row">
                  <Icon name="i-pin" />
                  <span>
                    <strong>{o.venue_name}</strong>
                    {o.venue_area ? ` · ${o.venue_area}` : ''}
                    {o.distance_mi !== null ? ` · ${formatMiles(o.distance_mi)} away` : ''}
                  </span>
                </li>
                <li className="sc-ticket__meta-row">
                  <Icon name="i-calendar" />
                  <span>
                    <strong>{dayLabel(o.start_at!, o.server_time!, tz)}</strong> {'·'}{' '}
                    {formatTimeRange(o.start_at!, o.end_at!, tz)}
                  </span>
                </li>
                <li className="sc-ticket__meta-row">
                  <Icon name="i-clock" />
                  <span>{formatHours(o.hours!)}</span>
                </li>
              </ul>
            </div>
            <div className="sc-ticket__perf" />
            <div className="sc-ticket__stub">
              <p className="sc-eyebrow">You&apos;d earn</p>
              <p className="sc-ticket__amount">{formatUsd(o.pay_total_cents!)}</p>
              <p className="sc-ticket__formula">
                {o.hours} h &times; {formatRate(o.rate_cents!)}
                {rising && (
                  <>
                    {' '}
                    <span className="sc-rate-old">
                      (was {formatRate(o.first_offered_rate_cents!)})
                    </span>
                  </>
                )}
              </p>
              <p className="sc-trust">
                <Icon name="i-shield" size="lg" />
                <span>
                  <span className="sc-trust__title">Pay guaranteed: funds are on hold</span>
                  <span className="sc-trust__text">
                    {venue} has already set this money aside with PayPal.
                  </span>
                </span>
              </p>
              <p className="sc-ticket__payline">
                <Icon name="i-wallet" size="sm" />
                <span>
                  You&apos;re paid to your PayPal account after the manager approves your hours.
                </span>
              </p>
            </div>
          </article>
          {view === 'errorClaim' && (
            <Alert tone="error" icon="i-wifi-off" title="Your claim didn't go through" role="alert">
              Nothing was booked. Check your connection and try again.
            </Alert>
          )}
        </section>
        <footer className="sc-app__footer">
          <div className="sc-app__footer-inner">
            {askSkip ? (
              <>
                <p className="sc-text-muted" role="alert">
                  Skip this shift? We won&apos;t ask why.
                </p>
                <Button variant="secondary" block onClick={() => void onSkipConfirmed()}>
                  Yes, skip it
                </Button>
                <Button variant="quiet" block onClick={() => setAskSkip(false)}>
                  Go back
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="primary"
                  size="lg"
                  block
                  busy={claiming}
                  onClick={() => void onClaim()}
                >
                  {claiming
                    ? 'Claiming…'
                    : view === 'errorClaim'
                      ? 'Try again'
                      : 'Claim this shift'}
                </Button>
                <Button variant="quiet" block inert={claiming} onClick={() => setAskSkip(true)}>
                  Not available
                </Button>
              </>
            )}
          </div>
        </footer>
      </main>
    );
  }

  // ----- notices -----
  const NOTICES = {
    claimed: {
      tone: 'success',
      icon: 'i-check',
      title: 'You got it.',
      text: 'The shift is yours. We’re opening your booking.',
    },
    taken: {
      tone: 'info',
      icon: 'i-users',
      title: 'Someone else just claimed this shift',
      text: 'Thanks for being quick. It went to another team member a moment ago.',
    },
    expired: {
      tone: 'neutral',
      icon: 'i-clock',
      title: 'This offer has ended',
      text: 'The time to claim this shift ran out. You don’t need to do anything.',
    },
    withdrawn: {
      tone: 'neutral',
      icon: 'i-ban',
      title: 'This shift is no longer available',
      text: `${venue} filled it another way. Thanks for checking.`,
    },
    invalid: {
      tone: 'warning',
      icon: 'i-lock',
      title: 'This link doesn’t work',
      text: 'It may have expired, or it has already been used. We can email you a new one.',
    },
    errorLoad: {
      tone: 'error',
      icon: 'i-wifi-off',
      title: 'Can’t reach ShiftCover',
      text: 'Check your connection and try again. Nothing has been claimed.',
    },
    declined: {
      tone: 'info',
      icon: 'i-check',
      title: 'Okay, we’ve passed',
      text: 'We won’t ask why. Thanks for letting us know.',
    },
  } as const;
  const n = NOTICES[view as keyof typeof NOTICES] ?? NOTICES.expired;
  const others = offer?.other_open_offers_count ?? 0;

  return (
    <main className="sc-app">
      <Header />
      <section className="sc-app__body">
        <div ref={headingRef}>
          <Notice tone={n.tone} icon={n.icon} title={n.title} text={n.text}>
            {view === 'claimed' && (
              <>
                <p className="sc-notice__hint">
                  <Icon name="i-loader" size="sm" className="sc-spinner" />
                  Taking you to your booking&hellip;
                </p>
                <div className="sc-notice__actions">
                  <Button variant="primary" size="lg" block onClick={() => setView('booked')}>
                    See your booking
                  </Button>
                </div>
              </>
            )}
            {view === 'taken' && (
              <div className="sc-notice__actions">
                {others > 0 ? (
                  <a className="sc-btn sc-btn--secondary sc-btn--lg sc-btn--block" href="/w">
                    See {others} other open {others === 1 ? 'shift' : 'shifts'}
                  </a>
                ) : (
                  <p className="sc-notice__hint">No other open shifts right now.</p>
                )}
              </div>
            )}
            {view === 'errorLoad' && (
              <div className="sc-notice__actions">
                <Button
                  variant="primary"
                  size="lg"
                  block
                  onClick={() => {
                    setView('loading');
                    void load();
                  }}
                >
                  <Icon name="i-retry" />
                  Try again
                </Button>
              </div>
            )}
            {view === 'invalid' && (
              <div className="sc-notice__actions">
                {!linkSent ? (
                  <>
                    <div className="sc-field">
                      <label className="sc-field__label" htmlFor="link-email">
                        Your email
                      </label>
                      <input
                        className="sc-input"
                        id="link-email"
                        type="email"
                        inputMode="email"
                        autoComplete="email"
                        placeholder="you@example.com"
                        value={email}
                        onChange={(e) => {
                          setEmail(e.target.value);
                          setEmailInvalid(false);
                        }}
                        aria-invalid={emailInvalid}
                      />
                      {emailInvalid && (
                        <span className="sc-field__error" role="alert">
                          <Icon name="i-alert" size="sm" />
                          Enter the email address you signed up with.
                        </span>
                      )}
                    </div>
                    <Button variant="primary" size="lg" block onClick={() => void onSendLink()}>
                      <Icon name="i-mail" />
                      Email me a new link
                    </Button>
                  </>
                ) : (
                  <Alert tone="success" icon="i-mail" title="Check your email" role="status">
                    If that address is on a ShiftCover team, a new link is on its way.
                  </Alert>
                )}
              </div>
            )}
          </Notice>
        </div>
      </section>
    </main>
  );
}

function Header() {
  return (
    <header className="sc-app__header">
      <Wordmark />
    </header>
  );
}

function Loading() {
  return (
    <main className="sc-app" aria-busy="true">
      <Header />
      <section className="sc-app__body" aria-label="Loading shift offer">
        <span className="sc-visually-hidden" role="status">
          Loading shift details
        </span>
        <article className="sc-ticket sc-ticket--skeleton" aria-hidden="true">
          <div className="sc-ticket__head">
            <div className="sc-ticket__top">
              <Skeleton variant="eyebrow" />
              <Skeleton variant="chip" />
            </div>
            <Skeleton variant="title" />
            <Skeleton variant="line" />
            <Skeleton variant="line" />
            <Skeleton variant="line-short" />
          </div>
          <div className="sc-ticket__perf" />
          <div className="sc-ticket__stub">
            <Skeleton variant="eyebrow" />
            <Skeleton variant="amount" />
            <Skeleton variant="line-short" />
            <Skeleton variant="block" />
          </div>
        </article>
      </section>
      <footer className="sc-app__footer" aria-hidden="true">
        <div className="sc-app__footer-inner">
          <Skeleton variant="button" />
        </div>
      </footer>
    </main>
  );
}

/** W2: "You're booked." Every figure comes from the claimed offer, nothing is hard-coded. */
function Booked({ offer }: { offer: WorkerOfferDto }) {
  const tz = offer.venue_tz ?? 'UTC';
  const day = dayLabel(offer.start_at!, offer.server_time!, tz);
  const mapsHref =
    offer.venue_lat !== null && offer.venue_lng !== null
      ? `https://www.google.com/maps/search/?api=1&query=${offer.venue_lat},${offer.venue_lng}`
      : undefined;
  const steps: Array<[string, string]> = [
    [
      `Arrive by ${formatClock(offer.start_at!, tz)}`,
      `Head to ${offer.venue_name}. The kitchen is expecting you.`,
    ],
    ['Tap “I’ve arrived”', 'In ShiftCover, when you’re at the door. This starts your shift.'],
    ['Tap “Finished”', `When your shift ends, around ${formatClock(offer.end_at!, tz)}.`],
    ['The manager approves your hours', 'They check the time you worked and confirm it.'],
    ['You get paid', `${formatUsd(offer.pay_total_cents!)} goes to your PayPal account.`],
  ];
  return (
    <main className="sc-app">
      <Header />
      <section className="sc-app__body sc-rise">
        <div className="sc-booked">
          <span className="sc-booked__disc">
            <Icon name="i-check" size="xl" />
          </span>
          <h1 className="sc-booked__title" role="status" tabIndex={-1} ref={(el) => el?.focus()}>
            You&apos;re booked.
          </h1>
          <p className="sc-booked__sub">
            {offer.venue_name} is expecting you {day.toLowerCase()} at{' '}
            {formatClock(offer.start_at!, tz)}.
          </p>
        </div>

        <article className="sc-card" aria-labelledby="summary-title">
          <p className="sc-eyebrow" id="summary-title">
            Your shift
          </p>
          <ul className="sc-ticket__meta">
            <li className="sc-ticket__meta-row">
              <Icon name="i-calendar" />
              <span>
                <strong>{roleLabel(offer.role)}</strong> {'·'} {day},{' '}
                {formatTimeRange(offer.start_at!, offer.end_at!, tz)}
              </span>
            </li>
            <li className="sc-ticket__meta-row">
              <Icon name="i-clock" />
              <span>
                {formatHours(offer.hours!)} at {formatRate(offer.rate_cents!)}
              </span>
            </li>
            <li className="sc-ticket__meta-row">
              <Icon name="i-pin" />
              <span>
                <strong>{offer.venue_name}</strong>
                {offer.venue_address && (
                  <>
                    <br />
                    {offer.venue_address}
                  </>
                )}
              </span>
            </li>
          </ul>
          {mapsHref && (
            <a className="sc-link-row" href={mapsHref} target="_blank" rel="noopener noreferrer">
              Open in Maps
              <Icon name="i-arrow-up-right" />
            </a>
          )}
        </article>

        <article className="sc-card sc-card--guarantee" aria-labelledby="pay-title">
          <p className="sc-eyebrow" id="pay-title">
            Guaranteed pay
          </p>
          <p className="sc-ticket__amount">{formatUsd(offer.pay_total_cents!)}</p>
          <p className="sc-ticket__formula">
            {offer.hours} h &times; {formatRate(offer.rate_cents!)}
          </p>
          <p className="sc-ticket__payline">
            <Icon name="i-shield" size="sm" />
            <span>
              The money is already on hold with PayPal. It goes to your PayPal account once the
              manager approves your hours.
            </span>
          </p>
        </article>

        <article className="sc-card" aria-labelledby="next-title">
          <h2 className="sc-card__title" id="next-title">
            What happens next
          </h2>
          <ol className="sc-steps">
            {steps.map(([title, text], i) => (
              <li key={title} className={`sc-steps__item ${i === 0 ? 'sc-steps__item--next' : ''}`}>
                <span className="sc-steps__node" aria-hidden="true">
                  {i + 1}
                </span>
                <div>
                  <p className="sc-steps__title">
                    {title}
                    {i === 0 && <span className="sc-steps__tag">Next</span>}
                  </p>
                  <p className="sc-steps__text">{text}</p>
                </div>
              </li>
            ))}
          </ol>
        </article>
      </section>
      <footer className="sc-app__footer">
        <div className="sc-app__footer-inner">
          <a className="sc-btn sc-btn--primary sc-btn--lg sc-btn--block" href="/w">
            Go to My shifts
            <Icon name="i-arrow-right" />
          </a>
        </div>
      </footer>
    </main>
  );
}
