import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '@/styles/g2.css';

// Worker pages are private: never indexed, and (via next.config headers) Referrer-Policy: no-referrer.
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function WorkerLayout({ children }: { children: ReactNode }) {
  return children;
}
