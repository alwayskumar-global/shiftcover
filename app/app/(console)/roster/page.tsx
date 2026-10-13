import type { Metadata } from 'next';
import { RosterScreen } from '@/features/manager/RosterScreen';

export const metadata: Metadata = { title: 'Roster · ShiftCover Pay' };

export default function RosterPage() {
  return <RosterScreen />;
}
