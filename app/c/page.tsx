import type { Metadata } from 'next';
import { ClaimExperience } from '@/features/worker/ClaimExperience';

export const metadata: Metadata = { title: 'Shift offer', robots: { index: false, follow: false } };

/** The clean URL the token is replaced with after the first valid open. */
export default function ClaimCleanPage() {
  return <ClaimExperience />;
}
