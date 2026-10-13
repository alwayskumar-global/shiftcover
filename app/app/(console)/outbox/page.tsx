import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getServerEnv } from '@/config/env';
import { OutboxScreen } from '@/features/manager/OutboxScreen';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Outbox · ShiftCover Pay',
  robots: { index: false, follow: false },
};

/** Sandbox testing aid. Not linked from the navigation and absent (404) outside the PayPal sandbox. */
export default function OutboxPage() {
  if (String(getServerEnv().PAYPAL_ENV) !== 'sandbox') notFound();
  return <OutboxScreen />;
}
