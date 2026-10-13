import type { Metadata } from 'next';
import { WorkersScreen } from '@/features/manager/WorkersScreen';

export const metadata: Metadata = { title: 'Workers · ShiftCover Pay' };

export default function WorkersPage() {
  return <WorkersScreen />;
}
