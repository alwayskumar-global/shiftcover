import type { SVGProps } from 'react';

export type IconSize = 'sm' | 'md' | 'lg' | 'xl';

/** Lucide sprite icon (public/icons.svg). Decorative by default: meaning always travels in text. */
export function Icon({
  name,
  size = 'md',
  className = '',
  ...rest
}: { name: string; size?: IconSize } & Omit<SVGProps<SVGSVGElement>, 'name'>) {
  const cls = ['sc-icon', size === 'md' ? '' : `sc-icon--${size}`, className]
    .filter(Boolean)
    .join(' ');
  return (
    <svg className={cls} viewBox="0 0 24 24" aria-hidden="true" {...rest}>
      <use href={`/icons.svg#${name}`} />
    </svg>
  );
}
