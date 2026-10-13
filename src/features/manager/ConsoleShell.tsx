'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { MeResponse } from '@/api/dto';
import { Avatar, Wordmark } from '@/ui/primitives';
import { Icon } from '@/ui/icon';
import { initialsOf } from '@/api/adapters';
import { MeProvider } from './me-context';

/** App shell (design/g1: M2 nav). Roster is the only live destination in Gate 1; the rest read "Soon". */
export function ConsoleShell({ me, children }: { me: MeResponse; children: ReactNode }) {
  const router = useRouter();

  async function signOut() {
    try {
      await fetch('/api/auth/sign-out', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
    } finally {
      router.push('/app/login');
      router.refresh();
    }
  }

  const soon = (icon: string, label: string) => (
    <button className="sc-nav__item" aria-disabled="true" title={`${label} (coming soon)`}>
      <Icon name={icon} />
      <span className="sc-nav__label">{label}</span>
      <span className="sc-nav__tag">Soon</span>
    </button>
  );

  return (
    <div className="sc-console">
      <div className="sc-console__shell">
        <nav className="sc-nav" aria-label="Main">
          <Wordmark />
          <div className="sc-nav__venue">
            <Avatar initials={initialsOf(me.venue.name).slice(0, 1)} kind="brand" />
            <span className="sc-nav__venue-text">
              <span className="sc-nav__venue-name">{me.venue.name}</span>
              <span className="sc-nav__venue-sub">{me.venue.area}</span>
            </span>
          </div>
          <div className="sc-nav__list">
            <Link
              className="sc-nav__item is-active"
              href="/app/roster"
              aria-current="page"
              title="Roster"
            >
              <Icon name="i-calendar" />
              <span className="sc-nav__label">Roster</span>
            </Link>
            {soon('i-users', 'Workers')}
            {soon('i-wallet', 'Money')}
            {soon('i-settings', 'Settings')}
          </div>
          <span className="sc-nav__spacer" />
          <div className="sc-nav__user">
            <Avatar initials={initialsOf(me.manager.name)} kind="user" />
            <span className="sc-nav__user-text">
              <span className="sc-nav__user-name">{me.manager.name}</span>
              <span className="sc-nav__user-sub">Manager</span>
            </span>
            <button
              className="sc-nav__signout"
              onClick={() => void signOut()}
              aria-label="Sign out"
              title="Sign out"
            >
              <Icon name="i-log-out" />
            </button>
          </div>
        </nav>
        <main className="sc-console__main">
          <MeProvider me={me}>{children}</MeProvider>
        </main>
      </div>
    </div>
  );
}
