import type { Metadata } from 'next';
import { Earnings } from '@/features/worker/Earnings';

export const metadata: Metadata = { title: 'Earnings · ShiftCover Pay' };

export default function EarningsPage() {
  return <Earnings />;
}
