import type { Metadata } from 'next';
import { GapDetailScreen } from '@/features/manager/GapDetailScreen';

export const metadata: Metadata = { title: 'Gap · ShiftCover Pay' };

export default async function GapPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <GapDetailScreen id={id} />;
}
