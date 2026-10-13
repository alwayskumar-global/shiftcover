import type { Metadata } from 'next';
import { MyShifts } from '@/features/worker/MyShifts';

export const metadata: Metadata = { title: 'My shifts · ShiftCover Pay' };

export default function MyShiftsPage() {
  return <MyShifts />;
}
