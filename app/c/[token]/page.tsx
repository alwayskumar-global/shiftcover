import type { Metadata } from 'next';
import { ClaimExperience } from '@/features/worker/ClaimExperience';

// Worker link pages are private: never indexed, and (via next.config headers) Referrer-Policy: no-referrer.
export const metadata: Metadata = { title: 'Shift offer', robots: { index: false, follow: false } };

export default async function ClaimPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <ClaimExperience token={token} />;
}
