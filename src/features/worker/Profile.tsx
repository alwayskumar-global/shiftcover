'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ROLE_LABELS, SHIFT_ROLES, type ShiftRole } from '@/domain/roles';
import {
  ApiFailure,
  NetworkFailure,
  fetchWorkerProfile,
  startPayoutEmailChange,
  updateWorkerProfile,
  verifyPayoutEmailChange,
  type UpdateProfileDto,
  type WorkerProfileDto,
} from '@/features/client-api';
import { usePolling } from '@/features/manager/use-polling';
import { Icon } from '@/ui/icon';
import { Alert, Button, Skeleton } from '@/ui/primitives';
import { WorkerTabbar } from './WorkerTabbar';

/**
 * G2-W5 Profile (design/g2): skills, home area, notification choices and the payout-email change flow
 * (enter new email -> 6-digit code -> done). Reads and writes /api/w/profile. The code is typed by the worker and sent
 * only to the verify call: it is never logged, stored or put in a URL.
 */
type Phase = 'loading' | 'ready' | 'error' | 'signedOut';
type Step = 'idle' | 'enter' | 'otp';
type Prefs = WorkerProfileDto['notifications'];

const PREF_ROWS: Array<{
  group: string;
  rows: Array<{ key: keyof Prefs; label: string; desc: string }>;
}> = [
  {
    group: 'Shift offers',
    rows: [
      {
        key: 'offers_push',
        label: 'Push',
        desc: 'A notification on this phone when a shift opens.',
      },
      { key: 'offers_email', label: 'Email', desc: 'The same offer, with your private link.' },
    ],
  },
  {
    group: 'Pay',
    rows: [
      {
        key: 'pay_email',
        label: 'Email when I’m paid',
        desc: 'One email after each payout is sent.',
      },
    ],
  },
];

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function Profile() {
  const [p, setP] = useState<WorkerProfileDto | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [toast, setToast] = useState('');
  const [step, setStep] = useState<Step>('idle');
  const [justChanged, setJustChanged] = useState(false);
  const [areaDraft, setAreaDraft] = useState('');
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(''), 3200);
    return () => clearTimeout(id);
  }, [toast]);

  const firstLoad = useRef(true);
  const load = useCallback(async () => {
    try {
      const d = await fetchWorkerProfile();
      setP(d);
      setPhase('ready');
      // Only the first load seeds the draft and honours the link from Earnings; a refresh when the worker returns to
      // this tab (to read the code, say) must not reset what they were typing or the step they are on.
      if (firstLoad.current) {
        firstLoad.current = false;
        setAreaDraft(d.home_area);
        if (window.location.hash === '#payout-email') setStep('enter');
      }
    } catch (e) {
      setPhase(e instanceof ApiFailure && e.status === 401 ? 'signedOut' : 'error');
    }
  }, []);
  usePolling(load, 24 * 3600_000); // loads once on mount; the profile does not change under the worker

  /** Optimistic save: the screen updates at once and rolls back with a message if the server says no. */
  const save = async (
    patch: UpdateProfileDto,
    optimistic: (d: WorkerProfileDto) => WorkerProfileDto,
  ) => {
    if (!p) return;
    const before = p;
    setP(optimistic(p));
    try {
      setP(await updateWorkerProfile(patch));
      setToast('Saved');
    } catch (e) {
      setP(before);
      setAreaDraft(before.home_area);
      setToast(
        e instanceof NetworkFailure
          ? "You're offline. That change wasn't saved."
          : e instanceof ApiFailure && e.status === 422
            ? e.message
            : "We couldn't save that. Try again.",
      );
    }
  };

  const toggleSkill = (k: ShiftRole) => {
    if (!p) return;
    const has = p.skills.includes(k);
    if (has && p.skills.length === 1) {
      setToast('Keep at least one skill to get offers.');
      return;
    }
    const skills = has ? p.skills.filter((s) => s !== k) : [...p.skills, k];
    void save({ skills }, (d) => ({ ...d, skills }));
  };
  const togglePref = (key: keyof Prefs) => {
    if (!p) return;
    const v = !p.notifications[key];
    void save({ notifications: { [key]: v } }, (d) => ({
      ...d,
      notifications: { ...d.notifications, [key]: v },
    }));
  };

  if (step !== 'idle' && p)
    return (
      <EmailFlow
        current={p.paypal_email}
        onBack={() => setStep('idle')}
        onDone={(email) => {
          setP({ ...p, paypal_email: email });
          setJustChanged(true);
          setStep('idle');
        }}
        step={step}
        setStep={setStep}
      />
    );

  const offersOff = p && !p.notifications.offers_push && !p.notifications.offers_email;

  return (
    <main className="sc-app" aria-busy={phase === 'loading'}>
      <header className="sc-appbar">
        <h1 className="sc-appbar__title">Profile</h1>
        <span className="sc-wordmark__mark" aria-hidden="true">
          <Icon name="i-check" />
        </span>
      </header>

      <section className="sc-app__body sc-app__body--grow">
        {phase === 'loading' && (
          <>
            <span className="sc-visually-hidden" role="status">
              Loading your profile
            </span>
            <div aria-hidden="true" className="sc-profile-head">
              <Skeleton variant="title" />
            </div>
            {[1, 2, 3].map((k) => (
              <div className="sc-earn" aria-hidden="true" key={k}>
                <Skeleton variant="eyebrow" />
                <Skeleton variant="line" />
                <Skeleton variant="line-short" />
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
              We couldn&apos;t load your profile
            </h2>
            <p className="sc-notice__text">Check your connection and try again.</p>
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
              To see your profile, open the latest offer link we sent you.
            </p>
          </div>
        )}

        {phase === 'ready' && p && (
          <>
            <div className="sc-profile-head">
              <span className="sc-avatar sc-avatar--lg sc-avatar--1" aria-hidden="true">
                {p.initials}
              </span>
              <div>
                <h2 className="sc-profile-head__name">{p.name}</h2>
                <p className="sc-profile-head__sub">{p.email}</p>
              </div>
            </div>

            <section aria-labelledby="skills-t" className="sc-flow">
              <h2 className="sc-group-title" id="skills-t">
                Your skills
              </h2>
              <p className="sc-help">You only get offers for the skills you pick.</p>
              <div className="sc-picks" role="group" aria-labelledby="skills-t">
                {SHIFT_ROLES.map((k) => (
                  <button
                    type="button"
                    className="sc-pick"
                    key={k}
                    aria-pressed={p.skills.includes(k)}
                    onClick={() => toggleSkill(k)}
                  >
                    <Icon name="i-check" size="sm" />
                    {ROLE_LABELS[k]}
                  </button>
                ))}
              </div>
            </section>

            <section className="sc-field">
              <label className="sc-field__label" htmlFor="area">
                Home area
              </label>
              <input
                className="sc-input"
                id="area"
                maxLength={60}
                placeholder="e.g. Pearl District"
                value={areaDraft}
                onChange={(e) => setAreaDraft(e.target.value)}
                onBlur={() => {
                  const v = areaDraft.trim();
                  if (v !== p.home_area)
                    void save({ home_area: v }, (d) => ({ ...d, home_area: v }));
                }}
              />
              <span className="sc-help">
                Shown to your manager. Offers are matched by distance.
              </span>
            </section>

            <section aria-labelledby="notif-t" className="sc-flow">
              <h2 className="sc-group-title" id="notif-t">
                Notifications
              </h2>
              {offersOff && (
                <Alert
                  tone="warning"
                  icon="i-warn"
                  title="Keep one on for shift offers"
                  role="status"
                >
                  If both are off you won&apos;t hear about open shifts.
                </Alert>
              )}
              {PREF_ROWS.map((g) => (
                <div key={g.group}>
                  <h3 className="sc-group-title">{g.group}</h3>
                  {g.rows.map((r) => (
                    <div className="sc-setting" key={r.key}>
                      <div>
                        <span className="sc-setting__label">{r.label}</span>
                        <span className="sc-setting__desc">{r.desc}</span>
                      </div>
                      <button
                        type="button"
                        className="sc-switch"
                        role="switch"
                        aria-checked={p.notifications[r.key]}
                        aria-label={`${g.group}: ${r.label}`}
                        onClick={() => togglePref(r.key)}
                      >
                        <span className="sc-switch__track" />
                        <span className="sc-switch__state">
                          {p.notifications[r.key] ? 'On' : 'Off'}
                        </span>
                      </button>
                    </div>
                  ))}
                </div>
              ))}
            </section>

            <section aria-labelledby="payout-t" className="sc-flow" id="payout-email">
              <h2 className="sc-group-title" id="payout-t">
                Payout
              </h2>
              {justChanged && (
                <Alert tone="success" icon="i-check" title="Payout email updated" role="status">
                  New payouts go to {p.paypal_email}.
                </Alert>
              )}
              <div className="sc-setting">
                <div>
                  <span className="sc-setting__label">PayPal email</span>
                  <span className="sc-setting__desc">{p.paypal_email ?? 'Not set yet'}</span>
                </div>
                <Button variant="secondary" onClick={() => setStep('enter')}>
                  {p.paypal_email ? 'Change' : 'Add'}
                </Button>
              </div>
            </section>
          </>
        )}
      </section>

      {toast && (
        <div className="sc-snack-wrap">
          <div className="sc-snack" role="status">
            <Icon name="i-check" />
            {toast}
          </div>
        </div>
      )}

      <WorkerTabbar current="profile" />
    </main>
  );
}

function EmailFlow({
  current,
  step,
  setStep,
  onBack,
  onDone,
}: {
  current: string | null;
  step: Step;
  setStep: (s: Step) => void;
  onBack: () => void;
  onDone: (email: string) => void;
}) {
  const [email, setEmail] = useState('');
  const [emailErr, setEmailErr] = useState('');
  const [sendErr, setSendErr] = useState(false);
  const [code, setCode] = useState('');
  const [codeErr, setCodeErr] = useState('');
  const [expired, setExpired] = useState(false);
  const [locked, setLocked] = useState(false);
  const [left, setLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);

  // Countdown from the server's lifetime (expires_in_seconds); zero shows the expired state.
  useEffect(() => {
    if (step !== 'otp' || expired) return;
    const id = setInterval(() => {
      setLeft((n) => {
        if (n <= 1) {
          setExpired(true);
          return 0;
        }
        return n - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [step, expired]);

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    if (lock.current) return;
    const v = email.trim();
    if (!EMAIL_RE.test(v)) {
      setEmailErr('Enter a full email address, like you@example.com.');
      return;
    }
    setEmailErr('');
    setSendErr(false);
    lock.current = true;
    setBusy(true);
    try {
      const r = await startPayoutEmailChange(v);
      setEmail(r.new_email);
      setLeft(r.expires_in_seconds);
      setExpired(false);
      setLocked(false);
      setCode('');
      setCodeErr('');
      setStep('otp');
    } catch (err) {
      if (err instanceof ApiFailure && (err.status === 422 || err.status === 400))
        setEmailErr(err.message);
      else if (err instanceof ApiFailure && err.status === 429)
        setEmailErr('Too many codes requested. Try again later.');
      else setSendErr(true);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };

  const verify = async (e: FormEvent) => {
    e.preventDefault();
    if (lock.current) return;
    if (!/^\d{6}$/.test(code)) {
      setCodeErr('Enter the 6 digits from the email.');
      return;
    }
    setCodeErr('');
    lock.current = true;
    setBusy(true);
    try {
      const r = await verifyPayoutEmailChange(code);
      onDone(r.paypal_email);
    } catch (err) {
      if (err instanceof ApiFailure && err.status === 410) setExpired(true);
      else if (err instanceof ApiFailure && err.status === 429) {
        setLocked(true);
        setCodeErr(err.message);
      } else if (err instanceof ApiFailure && err.status === 422) setCodeErr(err.message);
      else setCodeErr("We couldn't check the code. Check your connection and try again.");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };

  return (
    <main className="sc-app">
      <header className="sc-appbar">
        <button type="button" className="sc-iconbtn" onClick={onBack} aria-label="Back to profile">
          <Icon name="i-chev-left" size="lg" />
        </button>
        <h1 className="sc-appbar__title">Change payout email</h1>
      </header>
      <section className="sc-app__body sc-app__body--grow">
        {step === 'enter' && (
          <form className="sc-flow" onSubmit={send} noValidate>
            <span className="sc-steptag">Step 1 of 2</span>
            {current && <p className="sc-help">Current payout email: {current}</p>}
            {sendErr && (
              <Alert tone="error" icon="i-warn" title="We couldn't send the code" role="alert">
                Nothing has changed. Check your connection and try again.
              </Alert>
            )}
            <div className="sc-field">
              <label className="sc-field__label" htmlFor="new-email">
                New PayPal email
              </label>
              <input
                className="sc-input"
                id="new-email"
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                aria-invalid={emailErr ? true : undefined}
                aria-describedby="new-email-help"
              />
              {emailErr ? (
                <span className="sc-field__error" id="new-email-help" role="alert">
                  <Icon name="i-warn" size="sm" />
                  {emailErr}
                </span>
              ) : (
                <span className="sc-help" id="new-email-help">
                  Use the email on your PayPal account. We&apos;ll send a 6-digit code to it.
                </span>
              )}
            </div>
            <div className="sc-flow__actions">
              <Button type="submit" variant="primary" size="lg" block busy={busy}>
                <Icon name="i-send" />
                {busy ? 'Sending…' : 'Send code'}
              </Button>
              <Button variant="quiet" block onClick={onBack}>
                Cancel
              </Button>
            </div>
          </form>
        )}

        {step === 'otp' && (
          <form className="sc-flow" onSubmit={verify} noValidate>
            <span className="sc-steptag">Step 2 of 2</span>
            <p className="sc-help">
              We sent a 6-digit code to <strong>{email}</strong>.
            </p>
            {expired && (
              <Alert tone="warning" icon="i-clock" title="This code has expired" role="alert">
                Codes last 10 minutes. Send a new one to continue.
              </Alert>
            )}
            <div className="sc-field">
              <label className="sc-field__label" htmlFor="otp">
                6-digit code
              </label>
              <input
                className="sc-input sc-otp"
                id="otp"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="······"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                disabled={expired || locked}
                aria-invalid={codeErr ? true : undefined}
                aria-describedby="otp-help"
              />
              {codeErr ? (
                <span className="sc-field__error" id="otp-help" role="alert">
                  <Icon name="i-warn" size="sm" />
                  {codeErr}
                </span>
              ) : (
                !expired && (
                  <span className="sc-help" id="otp-help">
                    Code expires in {mmss(left)}
                  </span>
                )
              )}
            </div>
            <div className="sc-flow__actions">
              {!expired && !locked && (
                <Button type="submit" variant="primary" size="lg" block busy={busy}>
                  {busy ? 'Checking…' : 'Confirm new email'}
                </Button>
              )}
              <Button
                variant={expired || locked ? 'primary' : 'quiet'}
                size={expired || locked ? 'lg' : undefined}
                block
                onClick={() => void send()}
              >
                Send a new code
              </Button>
              <Button variant="quiet" block onClick={() => setStep('enter')}>
                Use a different email
              </Button>
            </div>
          </form>
        )}
      </section>
    </main>
  );
}
