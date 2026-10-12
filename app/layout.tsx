import type { ReactNode } from 'react';
import { body, display, mono } from './fonts';
import '@/styles/tokens.css';
import '@/styles/fonts.css';
import '@/styles/components.css';

export const metadata = { title: 'ShiftCover Pay' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
