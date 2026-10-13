'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/**
 * Modal dialog on the design's scrim/dialog classes: focus moves in on open, Tab is trapped,
 * Esc closes, and focus returns to whatever opened it.
 */
export function Dialog({
  titleId,
  role = 'dialog',
  onClose,
  children,
}: {
  titleId: string;
  role?: 'dialog' | 'alertdialog';
  onClose: () => void;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const el = box.current;
    const focusables = () =>
      Array.from(
        el?.querySelectorAll<HTMLElement>(
          'button:not([aria-disabled="true"]), [href], input, select, textarea',
        ) ?? [],
      );
    (el?.querySelector<HTMLElement>('[data-autofocus]') ?? focusables()[0])?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close.current();
      } else if (e.key === 'Tab') {
        const f = focusables();
        if (f.length === 0) return;
        const first = f[0]!;
        const last = f[f.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, []);

  return (
    <div className="sc-scrim">
      <div className="sc-dialog" role={role} aria-modal="true" aria-labelledby={titleId} ref={box}>
        {children}
      </div>
    </div>
  );
}
