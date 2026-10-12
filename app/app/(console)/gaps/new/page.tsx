import type { Metadata } from 'next';
import { ReportGapScreen } from '@/features/manager/ReportGapScreen';

export const metadata: Metadata = { title: 'Report a gap · ShiftCover Pay' };

export default function NewGapPage() {
  return <ReportGapScreen />;
}
