'use client';

import { useCallback, useState } from 'react';
import type { z } from 'zod';
import type { OutboxResponse } from '@/api/dto';
import { Alert, Badge, Button, Skeleton } from '@/ui/primitives';
import { Icon } from '@/ui/icon';
import { usePolling } from './use-polling';

type Items = z.infer<typeof OutboxResponse>['items'];

const when = (iso: string) =>
  new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));

/**
 * Sandbox Outbox: what the app would have emailed or pushed, including worker offer links, so a tester can open them.
 * Shown only in the PayPal sandbox (the page and API answer 404 elsewhere). Links are never logged or sent anywhere.
 */
export function OutboxScreen() {
  const [items, setItems] = useState<Items | null>(null);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/manager/outbox', {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error('failed');
      setItems(((await res.json()) as z.infer<typeof OutboxResponse>).items);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);
  usePolling(load, 5000);

  const copy = (id: string, link: string) => {
    void navigator.clipboard?.writeText(link).catch(() => {});
    setCopied(id);
    setTimeout(() => setCopied((c) => (c === id ? null : c)), 2000);
  };

  return (
    <div className="sc-page">
      <header className="sc-page__head">
        <div>
          <h1 className="sc-page__title">Outbox</h1>
          <p className="sc-page__sub">
            Messages the app would send, newest first. Sandbox testing only: this page does not
            exist outside the PayPal sandbox.
          </p>
        </div>
      </header>

      {failed && (
        <Alert tone="warning" icon="i-wifi-off" title="We couldn’t load the Outbox" role="alert">
          Check your connection. This page keeps trying.
        </Alert>
      )}

      <section className="sc-card sc-card--flush" aria-labelledby="outbox-title">
        <div className="sc-section__head">
          <h2 className="sc-card__title" id="outbox-title">
            Recent messages
          </h2>
          <span className="sc-section__note">
            {items ? `${items.length} ${items.length === 1 ? 'message' : 'messages'}` : ' '}
          </span>
        </div>
        <div className="sc-offers" role="table" aria-label="Outbox">
          <div className="sc-offers__row sc-offers__row--head" role="row">
            <span role="columnheader">To</span>
            <span role="columnheader">Channel</span>
            <span role="columnheader">Created</span>
            <span role="columnheader">Offer link</span>
          </div>
          {items === null && !failed && (
            <div className="sc-offers__row" aria-hidden="true">
              <Skeleton variant="name" />
            </div>
          )}
          {items?.length === 0 && (
            <div className="sc-offers__row is-muted" role="row">
              <span className="sc-offers__who" role="cell">
                <span className="sc-offers__name">Nothing here yet</span>
              </span>
            </div>
          )}
          {items?.map((i) => (
            <div className="sc-offers__row" role="row" key={i.id}>
              <span className="sc-offers__who" role="cell">
                <span>
                  <span className="sc-offers__name">{i.recipient_label}</span>
                  <span className="sc-offers__role">{i.kind.replace(/_/g, ' ')}</span>
                </span>
              </span>
              <span role="cell">
                <Badge tone="neutral" small>
                  {i.channel.replace('_', ' ')}
                </Badge>
              </span>
              <span className="sc-offers__time" role="cell">
                {when(i.created_at)}
              </span>
              <span role="cell">
                {i.link ? (
                  <>
                    <a
                      className="sc-btn sc-btn--quiet sc-btn--md"
                      href={i.link}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      Open
                    </a>
                    <Button variant="quiet" size="md" onClick={() => copy(i.id, i.link!)}>
                      <Icon name={copied === i.id ? 'i-check' : 'i-copy'} size="sm" />
                      {copied === i.id ? 'Copied' : 'Copy link'}
                    </Button>
                  </>
                ) : (
                  '–'
                )}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
