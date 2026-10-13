import type { Metadata } from 'next';
import { ApprovalsScreen } from '@/features/manager/ApprovalsScreen';

export const metadata: Metadata = { title: 'Approvals · ShiftCover Pay' };

export default function ApprovalsPage() {
  return <ApprovalsScreen />;
}
