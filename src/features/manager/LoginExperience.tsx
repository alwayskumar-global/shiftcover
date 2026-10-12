'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Alert, Wordmark } from '@/ui/primitives';
import { Icon } from '@/ui/icon';
import { MAGIC_LINK_TTL_MINUTES } from '@/config/business';

/**
 * M1 manager login (design/g1: M1-login). Better Auth: POST /api/auth/sign-in/email (password) and
 * POST /api/auth/sign-in/magic-link (link goes to the notification Outbox in this phase).
 * Wrong credentials and rate limiting share one message, so the form never says which part was wrong.
 */
type View =
  'default' | 'validation' | 'wrong' | 'signingIn' | 'linkForm' | 'linkSending' | 'linkSent';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function LoginExperience() {
  const router = useRouter();
  const [view, setView] = useState<View>('default');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [linkInvalid, setLinkInvalid] = useState(false);

  const link = view.startsWith('link');
  const busy = view === 'signingIn' || view === 'linkSending';
  const emailBad = (view === 'validation' && !email.trim()) || (view === 'linkForm' && linkInvalid);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const emailOk = EMAIL_RE.test(email.trim());
    if (link) {
      if (!emailOk) {
        setView('linkForm');
        setLinkInvalid(true);
        return;
      }
      setLinkInvalid(false);
      setView('linkSending');
      try {
        await fetch('/api/auth/sign-in/magic-link', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: email.trim(), callbackURL: '/app/roster' }),
        });
      } catch {
        // Same outcome either way: the screen never reveals whether the address is a manager.
      }
      setView('linkSent');
      return;
    }
    if (!email.trim() || !password) {
      setView('validation');
      return;
    }
    setView('signingIn');
    try {
      const res = await fetch('/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      if (res.ok) {
        router.push('/app/roster');
        router.refresh();
        return;
      }
    } catch {
      // fall through to the same message
    }
    setView('wrong');
  }

  const clearIfStale = () =>
    view === 'validation' || view === 'wrong' ? setView('default') : undefined;

  return (
    <div className="sc-console">
      <main className="sc-login">
        <aside className="sc-login__brand">
          <Wordmark />
          <div>
            <h2 className="sc-login__headline">Someone calls in sick. The shift gets covered.</h2>
          </div>
          <ul className="sc-login__points">
            <li className="sc-login__point">
              <Icon name="i-shield" size="lg" />
              <span>
                <strong>Money is held first</strong>You approve a maximum with PayPal. You only pay
                for hours worked.
              </span>
            </li>
            <li className="sc-login__point">
              <Icon name="i-send" size="lg" />
              <span>
                <strong>Offered in waves</strong>Qualified workers hear first. The rate rises only
                if nobody claims.
              </span>
            </li>
            <li className="sc-login__point">
              <Icon name="i-wallet" size="lg" />
              <span>
                <strong>Paid when you approve</strong>The worker is paid out after you approve their
                hours.
              </span>
            </li>
          </ul>
        </aside>

        <section className="sc-login__main">
          <form className="sc-login__card" onSubmit={onSubmit} noValidate aria-busy={busy}>
            <h1 className="sc-login__title">{link ? 'Get a sign-in link' : 'Sign in'}</h1>
            <p className="sc-login__lead">
              {link
                ? 'We’ll email you a link that signs you in. No password needed.'
                : 'Manage your roster and report gaps.'}
            </p>

            {view === 'wrong' && (
              <Alert
                tone="error"
                icon="i-alert"
                title="That email and password don't match"
                role="alert"
              >
                Check them and try again, or get a sign-in link instead.
              </Alert>
            )}
            {view === 'linkSent' && (
              <Alert tone="success" icon="i-mail" title="Check your email" role="status">
                If {email} belongs to a manager on ShiftCover, a sign-in link is on its way. It
                works once and expires in {MAGIC_LINK_TTL_MINUTES} minutes.
              </Alert>
            )}

            {view !== 'linkSent' && (
              <div className="sc-field">
                <label className="sc-field__label" htmlFor="login-email">
                  Email
                </label>
                <input
                  className="sc-input"
                  id="login-email"
                  type="email"
                  inputMode="email"
                  autoComplete="username"
                  placeholder="you@yourrestaurant.com"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setLinkInvalid(false);
                    clearIfStale();
                  }}
                  disabled={busy}
                  aria-invalid={emailBad}
                  aria-describedby="login-email-err"
                />
                {emailBad && (
                  <span className="sc-field__error" id="login-email-err" role="alert">
                    <Icon name="i-alert" size="sm" />
                    {view === 'validation' && !email.trim()
                      ? 'Enter your email address.'
                      : 'Enter a valid email address.'}
                  </span>
                )}
              </div>
            )}
            {!link && view !== 'linkSent' && (
              <div className="sc-field">
                <label className="sc-field__label" htmlFor="login-password">
                  Password
                </label>
                <div className="sc-input-group">
                  <input
                    className="sc-input"
                    id="login-password"
                    type={show ? 'text' : 'password'}
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value);
                      clearIfStale();
                    }}
                    disabled={busy}
                    aria-invalid={view === 'validation' && !password}
                    aria-describedby="login-password-err"
                  />
                  <button
                    className="sc-input-group__btn"
                    type="button"
                    onClick={() => setShow(!show)}
                    aria-label={show ? 'Hide password' : 'Show password'}
                    aria-pressed={show}
                  >
                    <Icon name={show ? 'i-eye-off' : 'i-eye'} />
                  </button>
                </div>
                {view === 'validation' && !password && (
                  <span className="sc-field__error" id="login-password-err" role="alert">
                    <Icon name="i-alert" size="sm" />
                    Enter your password.
                  </span>
                )}
              </div>
            )}

            {view !== 'linkSent' && (
              <Button variant="primary" wide type="submit" busy={busy}>
                {view === 'signingIn'
                  ? 'Signing in…'
                  : view === 'linkSending'
                    ? 'Sending…'
                    : link
                      ? 'Send sign-in link'
                      : 'Sign in'}
              </Button>
            )}

            {!link && (
              <>
                <div className="sc-login__divider">or</div>
                <Button
                  variant="secondary"
                  wide
                  inert={busy}
                  onClick={() => {
                    setView('linkForm');
                    setPassword('');
                  }}
                >
                  <Icon name="i-link" />
                  Send me a sign-in link
                </Button>
              </>
            )}
            {link && (
              <Button
                variant="quiet"
                className="sc-login__link"
                onClick={() => {
                  setView('default');
                }}
              >
                <Icon name="i-chev-left" size="sm" />
                Back to password sign-in
              </Button>
            )}
            <p className="sc-login__foot">
              Workers don&apos;t need an account. They get a link by email or notification.
            </p>
          </form>
        </section>
      </main>
    </div>
  );
}
