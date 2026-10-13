import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '@/styles/console.css';
import '@/styles/g2.css';
import '@/styles/overrides.css';

export const metadata: Metadata = {
  title: 'Review harness',
  robots: { index: false, follow: false },
};

export default function ReviewLayout({ children }: { children: ReactNode }) {
  return children;
}
