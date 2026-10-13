import { Icon } from '@/ui/icon';

/** Bottom navigation for the worker pages (G2). Server-rendered links; the current page carries aria-current. */
export function WorkerTabbar({ current }: { current: 'shifts' | 'earnings' | 'profile' }) {
  const items = [
    { key: 'shifts', href: '/w', icon: 'i-calendar', label: 'My shifts' },
    { key: 'earnings', href: '/w/earnings', icon: 'i-wallet', label: 'Earnings' },
    { key: 'profile', href: '/w/profile', icon: 'i-user', label: 'Profile' },
  ] as const;
  return (
    <nav className="sc-tabbar" aria-label="Main">
      {items.map((i) => (
        <a
          key={i.key}
          className="sc-tabbar__item"
          href={i.href}
          aria-current={i.key === current ? 'page' : undefined}
        >
          <Icon name={i.icon} size="lg" />
          {i.label}
        </a>
      ))}
    </nav>
  );
}
