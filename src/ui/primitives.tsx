import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Icon } from './icon';

const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(' ');

export function Wordmark() {
  return (
    <span className="sc-wordmark">
      <span className="sc-wordmark__mark">
        <Icon name="i-check" />
      </span>
      ShiftCover Pay
    </span>
  );
}

type ButtonProps = {
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger' | 'danger-quiet';
  size?: 'lg' | 'md' | 'default';
  block?: boolean;
  wide?: boolean;
  busy?: boolean;
  /** aria-disabled keeps focus and prevents double submits (the design never uses `disabled` for in-flight). */
  inert?: boolean;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'disabled'>;

export function Button({
  variant = 'primary',
  size = 'default',
  block,
  wide,
  busy,
  inert,
  className,
  children,
  onClick,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        'sc-btn',
        `sc-btn--${variant}`,
        size !== 'default' && `sc-btn--${size}`,
        block && 'sc-btn--block',
        wide && 'sc-btn--wide',
        busy && 'is-busy',
        className,
      )}
      aria-disabled={inert || busy || undefined}
      onClick={(e) => {
        if (inert || busy) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
      {...rest}
    >
      {busy !== undefined && <Icon name="i-loader" className="sc-btn__spinner" />}
      {children}
    </button>
  );
}

export function Alert({
  tone,
  icon,
  title,
  children,
  role,
}: {
  tone: 'info' | 'success' | 'warning' | 'error' | 'pending';
  icon: string;
  title: string;
  children?: ReactNode;
  role?: 'alert' | 'status';
}) {
  return (
    <div className={`sc-alert sc-alert--${tone}`} role={role}>
      <Icon name={icon} size="lg" />
      <div>
        <span className="sc-alert__title">{title}</span>
        {children !== undefined && <span className="sc-alert__text">{children}</span>}
      </div>
    </div>
  );
}

export function Skeleton({ variant, className }: { variant: string; className?: string }) {
  return <span className={cx('sc-skeleton', `sc-skeleton--${variant}`, className)} />;
}

export function Notice({
  tone,
  icon,
  title,
  text,
  children,
}: {
  tone: 'neutral' | 'success' | 'info' | 'warning' | 'error';
  icon: string;
  title: string;
  text: string;
  children?: ReactNode;
}) {
  return (
    <div className="sc-notice sc-rise">
      <span className={`sc-notice__icon sc-notice__icon--${tone}`}>
        <Icon name={icon} size="xl" />
      </span>
      <h1 className="sc-notice__title" role="status">
        {title}
      </h1>
      <p className="sc-notice__text">{text}</p>
      {children}
    </div>
  );
}

export function Avatar({
  initials,
  tint,
  size = 'sm',
  kind,
}: {
  initials: string;
  tint?: number;
  size?: 'sm' | 'md';
  kind?: 'brand' | 'user';
}) {
  return (
    <span
      className={cx(
        'sc-avatar',
        size === 'sm' && 'sc-avatar--sm',
        kind && `sc-avatar--${kind}`,
        tint ? `sc-avatar--${tint}` : undefined,
      )}
      aria-hidden="true"
    >
      {initials}
    </span>
  );
}

export function Badge({
  tone,
  icon,
  children,
  className,
  small,
}: {
  tone?: string;
  icon?: string;
  children: ReactNode;
  className?: string;
  small?: boolean;
}) {
  return (
    <span
      className={cx('sc-badge', tone && `sc-badge--${tone}`, small && 'sc-badge--sm', className)}
    >
      {icon && <Icon name={icon} size="sm" />}
      {children}
    </span>
  );
}
