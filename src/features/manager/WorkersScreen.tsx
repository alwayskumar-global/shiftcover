'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { ROLE_LABELS } from '@/domain/roles';
import { ApiFailure, fetchWorkers, inviteWorker, type WorkersDto } from '@/features/client-api';
import { Icon } from '@/ui/icon';
import { Alert, Avatar, Badge, Button, Skeleton } from '@/ui/primitives';

/**
 * G2-M7 Workers (design/g2): the team with skills, certifications and expiry, an availability summary and the
 * reliability score, plus invite-by-email. Every value, including the expiry state and the score tier, comes from
 * GET /api/manager/workers; the invite posts to /api/manager/workers/invite.
 */
type Worker = WorkersDto['items'][number];
type Phase = 'loading' | 'ready' | 'error';
type Invite =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'sent'; email: string }
  | { kind: 'invalid'; message: string }
  | { kind: 'dup'; title: string; text: string }
  | { kind: 'error' };
type Filter = 'all' | 'attention' | 'review';

const FILTERS: Array<{ v: Filter; label: string }> = [
  { v: 'all', label: 'Everyone' },
  { v: 'attention', label: 'Certs to renew' },
  { v: 'review', label: 'Needs review' },
];

const TIER: Record<Worker['reliability_tier'], { tone: string; icon: string; label: string }> = {
  reliable: { tone: 'success', icon: 'i-check', label: 'Reliable' },
  good: { tone: 'info', icon: 'i-info', label: 'Good' },
  review: { tone: 'warning', icon: 'i-alert', label: 'Review' },
};

const CERT_NAMES: Record<string, string> = {
  food_handler: 'Food handler card',
  alcohol_service: 'Alcohol service permit',
};
const certName = (c: string) =>
  CERT_NAMES[c] ?? c.replace(/_/g, ' ').replace(/^./, (m) => m.toUpperCase());

const dateText = (iso: string) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(`${iso}T00:00:00Z`));

function certBadge(c: Worker['certifications'][number]) {
  switch (c.state) {
    case 'expired':
      return { tone: 'error', icon: 'i-warn', label: `Expired ${dateText(c.valid_until!)}` };
    case 'expiring':
      return {
        tone: 'warning',
        icon: 'i-clock',
        label:
          c.days_left === 0
            ? 'Expires today'
            : `Expires in ${c.days_left} ${c.days_left === 1 ? 'day' : 'days'}`,
      };
    case 'valid':
      return { tone: 'success', icon: 'i-check', label: `Valid to ${dateText(c.valid_until!)}` };
    default:
      return { tone: 'success', icon: 'i-check', label: 'No expiry' };
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function WorkersScreen() {
  const [data, setData] = useState<WorkersDto | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [email, setEmail] = useState('');
  const [invite, setInvite] = useState<Invite>({ kind: 'idle' });

  const load = useCallback(async () => {
    try {
      setData(await fetchWorkers());
      setPhase('ready');
    } catch {
      setPhase((p) => (p === 'ready' ? 'ready' : 'error'));
    }
  }, []);
  useEffect(() => {
    let live = true;
    fetchWorkers()
      .then((d) => {
        if (!live) return;
        setData(d);
        setPhase('ready');
      })
      .catch(() => live && setPhase('error'));
    return () => {
      live = false;
    };
  }, []);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (invite.kind === 'busy') return;
    const v = email.trim();
    if (!EMAIL_RE.test(v)) {
      setInvite({ kind: 'invalid', message: 'Enter a full email address, like name@example.com.' });
      return;
    }
    setInvite({ kind: 'busy' });
    try {
      const r = await inviteWorker(v);
      setInvite({ kind: 'sent', email: r.email });
      setEmail('');
      await load();
    } catch (err) {
      if (err instanceof ApiFailure && err.status === 409)
        setInvite({
          kind: 'dup',
          title:
            err.code === 'already_member'
              ? 'That person is already on your team'
              : 'You already invited this email',
          text:
            err.code === 'already_member'
              ? 'There is nothing to send.'
              : 'They are on the list below as Invited. Nothing was sent again.',
        });
      else if (err instanceof ApiFailure && (err.status === 422 || err.status === 400))
        setInvite({
          kind: 'invalid',
          message: 'Enter a full email address, like name@example.com.',
        });
      else if (err instanceof ApiFailure && err.status === 429)
        setInvite({ kind: 'invalid', message: 'Too many invites. Try again later.' });
      else setInvite({ kind: 'error' });
    }
  };

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.items ?? []).filter((w) => {
      if (
        filter === 'attention' &&
        !w.certifications.some((c) => c.state === 'expired' || c.state === 'expiring')
      )
        return false;
      if (filter === 'review' && w.reliability_tier !== 'review') return false;
      if (!needle) return true;
      return [w.name, w.email, ...w.skills.map((s) => ROLE_LABELS[s])]
        .join(' ')
        .toLowerCase()
        .includes(needle);
    });
  }, [data, q, filter]);

  const sum = data?.summary;
  const stats: Array<{ label: string; value: number | null; icon: string; alert: boolean }> = [
    { label: 'Workers', value: sum?.total ?? null, icon: 'i-users', alert: false },
    { label: 'Active', value: sum?.active ?? null, icon: 'i-check', alert: false },
    { label: 'Invited', value: sum?.invited ?? null, icon: 'i-send', alert: false },
    {
      label: 'With certs to renew',
      value: sum?.certs_needing_attention ?? null,
      icon: 'i-warn',
      alert: (sum?.certs_needing_attention ?? 0) > 0,
    },
  ];

  return (
    <div className="sc-page">
      <header className="sc-page__head">
        <div>
          <h1 className="sc-page__title">Workers</h1>
          <p className="sc-page__sub">Your team, who is certified for what, and who shows up.</p>
        </div>
      </header>

      <section className="sc-card sc-invite" aria-labelledby="inv-t">
        <div>
          <h2 className="sc-card__title" id="inv-t">
            Invite a worker
          </h2>
          <p className="sc-card__lead">
            We add them to your list as Invited and email them. They start getting shift offers that
            match their skills once they are set up.
          </p>
        </div>
        <form className="sc-invite__form" onSubmit={send} noValidate>
          <div className="sc-invite__row">
            <div className="sc-field">
              <label className="sc-field__label" htmlFor="inv-email">
                Email address
              </label>
              <input
                className="sc-input sc-input--md"
                id="inv-email"
                type="email"
                inputMode="email"
                autoComplete="off"
                placeholder="name@example.com"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (invite.kind !== 'busy' && invite.kind !== 'idle') setInvite({ kind: 'idle' });
                }}
                aria-invalid={invite.kind === 'invalid' ? true : undefined}
                aria-describedby={invite.kind === 'invalid' ? 'inv-err' : undefined}
              />
            </div>
            <Button
              type="submit"
              variant="primary"
              size="md"
              busy={invite.kind === 'busy'}
              style={{ marginTop: 28 }}
            >
              <Icon name="i-send" />
              {invite.kind === 'busy' ? 'Sending…' : 'Send invite'}
            </Button>
          </div>
          {invite.kind === 'invalid' && (
            <span className="sc-field__error" id="inv-err" role="alert">
              <Icon name="i-warn" size="sm" />
              {invite.message}
            </span>
          )}
          {invite.kind === 'sent' && (
            <Alert
              tone="success"
              icon="i-check"
              title={`Invite sent to ${invite.email}`}
              role="status"
            >
              They are on the list below as Invited.
            </Alert>
          )}
          {invite.kind === 'dup' && (
            <Alert tone="warning" icon="i-info" title={invite.title} role="status">
              {invite.text}
            </Alert>
          )}
          {invite.kind === 'error' && (
            <Alert tone="error" icon="i-warn" title="We couldn't send the invite" role="alert">
              Nothing was sent. Check your connection and try again.
            </Alert>
          )}
        </form>
      </section>

      {phase !== 'error' && (
        <section className="sc-stats" aria-label="Summary">
          {stats.map((t) => (
            <div className={`sc-stat ${t.alert ? 'sc-stat--open is-alert' : ''}`} key={t.label}>
              <span className="sc-stat__icon">
                <Icon name={t.icon} />
              </span>
              <span>
                <span className="sc-stat__value">
                  {t.value === null ? <Skeleton variant="amount" /> : t.value}
                </span>
                <span className="sc-stat__label">{t.label}</span>
              </span>
            </div>
          ))}
        </section>
      )}

      {phase !== 'error' && (
        <div className="sc-filterbar" role="group" aria-label="Filters">
          <div className="sc-search">
            <Icon name="i-search" size="sm" />
            <label className="sc-visually-hidden" htmlFor="wq">
              Search workers
            </label>
            <input
              className="sc-input sc-input--md"
              id="wq"
              type="search"
              placeholder="Search name, email or skill"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <div className="sc-segmented" role="group" aria-label="Filter">
            {FILTERS.map((f) => (
              <button
                type="button"
                className="sc-segmented__btn"
                key={f.v}
                aria-pressed={filter === f.v}
                onClick={() => setFilter(f.v)}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {phase === 'error' && (
        <div className="sc-panel">
          <span className="sc-panel__icon">
            <Icon name="i-wifi-off" size="xl" />
          </span>
          <h2 className="sc-panel__title">We couldn&apos;t load your workers</h2>
          <p className="sc-panel__text">
            Check your connection and try again. Nothing was changed.
          </p>
          <Button
            variant="secondary"
            size="md"
            onClick={() => {
              setPhase('loading');
              void load();
            }}
          >
            <Icon name="i-retry" />
            Try again
          </Button>
        </div>
      )}

      {phase !== 'error' && (
        <div className="sc-tbl-scroll">
          <div
            className="sc-tbl sc-cols-workers"
            role="table"
            aria-label="Workers"
            aria-busy={phase === 'loading'}
          >
            <div className="sc-tbl__row sc-tbl__row--head" role="row">
              <span role="columnheader">Worker</span>
              <span role="columnheader">Skills</span>
              <span role="columnheader">Certifications</span>
              <span role="columnheader">Availability</span>
              <span role="columnheader">Reliability</span>
            </div>
            {phase === 'loading' &&
              [1, 2, 3, 4].map((k) => (
                <div className="sc-tbl__row" aria-hidden="true" key={k}>
                  {[1, 2, 3, 4, 5].map((c) => (
                    <Skeleton variant="line" key={c} />
                  ))}
                </div>
              ))}
            {phase === 'ready' &&
              rows.map((w) => {
                const tier = TIER[w.reliability_tier];
                return (
                  <div className="sc-tbl__row" role="row" key={w.id}>
                    <span
                      className="sc-tbl__cell"
                      role="cell"
                      style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}
                    >
                      <Avatar initials={w.initials} tint={w.avatar_tint} size="sm" />
                      <span style={{ minWidth: 0 }}>
                        <span className="sc-tbl__strong">{w.name}</span>
                        <span className="sc-tbl__sub">
                          {w.status === 'invited'
                            ? 'Invited · '
                            : w.status === 'inactive'
                              ? 'Inactive · '
                              : ''}
                          {w.email}
                        </span>
                      </span>
                    </span>
                    <span className="sc-tbl__cell" role="cell">
                      {w.skills.length ? (
                        <span className="sc-tags">
                          {w.skills.map((s) => (
                            <span className="sc-tag" key={s}>
                              {ROLE_LABELS[s]}
                            </span>
                          ))}
                        </span>
                      ) : (
                        <span className="sc-tbl__sub">None yet</span>
                      )}
                    </span>
                    <span className="sc-tbl__cell" role="cell">
                      {w.certifications.length ? (
                        <span className="sc-certs">
                          {w.certifications.map((c) => {
                            const b = certBadge(c);
                            return (
                              <span className="sc-cert" key={c.name}>
                                <span className="sc-cert__name">{certName(c.name)}</span>
                                <Badge tone={b.tone} icon={b.icon} small>
                                  {b.label}
                                </Badge>
                              </span>
                            );
                          })}
                        </span>
                      ) : (
                        <span className="sc-tbl__sub">None on file</span>
                      )}
                    </span>
                    <span className="sc-tbl__cell" role="cell">
                      {w.availability}
                    </span>
                    <span className="sc-tbl__cell" role="cell">
                      <span className="sc-score">
                        <span className="sc-score__n">{w.reliability_pct}</span>
                        <Badge tone={tier.tone} icon={tier.icon} small>
                          {tier.label}
                        </Badge>
                      </span>
                    </span>
                  </div>
                );
              })}
            {phase === 'ready' && rows.length === 0 && (
              <div
                className="sc-tbl__row"
                role="row"
                style={{ display: 'block', padding: '32px 16px', textAlign: 'center' }}
              >
                <h2 className="sc-panel__title">
                  {data && data.items.length > 0 ? 'No workers match' : 'No workers yet'}
                </h2>
                <p className="sc-panel__text" style={{ margin: '8px auto' }}>
                  {data && data.items.length > 0
                    ? 'Try a different search or filter.'
                    : 'Invite your first worker above. They show up here as Invited.'}
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
