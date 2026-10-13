import type { Metadata } from 'next';
import { LedgerScreen } from '@/features/manager/LedgerScreen';

export const metadata: Metadata = { title: 'Ledger · ShiftCover Pay' };

export default function LedgerPage() {
  return <LedgerScreen />;
}
